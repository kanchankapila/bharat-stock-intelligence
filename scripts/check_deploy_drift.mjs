#!/usr/bin/env node
// Detects "committed but not deployed" -- .ts is not hot-reloaded, so `git pull`/checkout
// landing a newer commit than the running bharat-server process means the fix is in the repo
// but not live. "server N commits behind HEAD" is a recurring finding in this repo's own audit
// history (AF-14), always caught late by a human noticing, never by a check -- because nothing
// compared the two. This does, and stamps job_heartbeat('deploy-drift') so dataQualityChecks'
// 'deploy-drift' entry can watch it the same way it watches everything else.
//
// Run this on the deployment host, on a schedule (see ecosystem.config.cjs's
// 'deploy-drift-check' job) or by hand after a deploy to confirm it actually landed.
//
// Two independent signals, because either one alone can be wrong:
//   1. git: is HEAD's commit newer than pm2's process start time for bharat-server?
//   2. pm2: is bharat-server even running, and for how long?
// Neither needs POSTGRES_URL to be reachable to report something useful -- git/pm2 state is
// checked first and reported even if the job_heartbeat write subsequently fails, so a database
// outage does not also hide a deploy-drift finding.
import { execFileSync } from 'node:child_process';
import 'dotenv/config';
import { driftVerdict } from './lib/deployDriftVerdict.mjs';

function sh(cmd, args) {
  // pm2 resolves to pm2.cmd (a batch wrapper) on Windows; .cmd files are not real executables,
  // so we route through cmd.exe explicitly -- cmd.exe IS a real executable, so args go through
  // as an argv array WITHOUT shell:true. This both works where plain execFileSync('pm2')
  // threw EINVAL, and silences the DEP0190 deprecation warning that shell:true + args emitted
  // into pm2-err.log on every run (2026-08-25). Args here are hardcoded literals ('jlist'),
  // never interpolated from external input.
  return execFileSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}

function gitHeadInfo() {
  const sha = sh('git', ['rev-parse', 'HEAD']);
  // Committer date, not author date -- a rebased/cherry-picked commit's author date can be
  // arbitrarily old; committer date is when it actually landed on this branch.
  const committedAtEpoch = Number(sh('git', ['log', '-1', '--format=%ct']));
  return { sha, committedAt: new Date(committedAtEpoch * 1000) };
}

function pm2ProcessInfo(name) {
  let list;
  try {
    list = JSON.parse(sh('pm2', ['jlist']));
  } catch (err) {
    return { running: false, error: `pm2 jlist failed: ${err.message.slice(0, 300)}` };
  }
  const proc = list.find((p) => p.name === name);
  if (!proc) return { running: false, error: `no pm2 process named '${name}'` };
  const status = proc.pm2_env?.status;
  const startedAt = proc.pm2_env?.pm_uptime ? new Date(proc.pm2_env.pm_uptime) : null;
  return { running: status === 'online', status, startedAt };
}

/**
 * Self-healing step for the drift the grace window exists to bound. `pm2 restart` is
 * idempotent and side-effect-free beyond the restart itself — the server re-reads HEAD from
 * disk on boot — so once a commit has sat undeployed past AUTO_RESTART_AFTER_MS, running it
 * beats holding a critical monitor red until a human types the same command. Set
 * DEPLOY_DRIFT_AUTO_RESTART=0 to restore alert-only behaviour (e.g. pinning a build during
 * an incident).
 */
function autoRestartServer() {
  if (process.env.DEPLOY_DRIFT_AUTO_RESTART === '0') {
    console.log('[deploy-drift] auto-restart disabled via DEPLOY_DRIFT_AUTO_RESTART=0');
    return false;
  }
  try {
    // Same cmd.exe routing as sh(): pm2 resolves to a .cmd wrapper on Windows.
    sh('pm2', ['restart', 'bharat-server', '--update-env']);
    console.log('[deploy-drift] pm2 restart bharat-server --update-env: issued');
    return true;
  } catch (err) {
    console.error(`[deploy-drift] WARNING: auto-restart failed: ${err.message.slice(0, 300)}`);
    return false;
  }
}

async function recordHeartbeat(ok, detail) {
  const nowMs = Date.now();
  // Raw `pg`, not src/server/pgClient.ts: this is a plain .mjs script (deliberately, so it
  // keeps working even if a bad deploy broke the TypeScript build), and Node's ESM loader
  // cannot resolve a bare .ts import without a loader/tsx -- confirmed live, `import
  // '../src/server/pgClient.js'` throws ERR_MODULE_NOT_FOUND since no compiled .js exists at
  // that path. Same connection-string precedence as pgConfig.ts's pgConnectionString().
  const { Pool } = await import('pg');
  const connectionString = process.env.POSTGRES_URL
    || `postgresql://${process.env.POSTGRES_USER || 'bharat'}:${encodeURIComponent(process.env.POSTGRES_PASSWORD || 'bharat')}` +
       `@${process.env.POSTGRES_HOST || '127.0.0.1'}:${process.env.POSTGRES_PORT || '5433'}/${process.env.POSTGRES_DB || 'bharat_intel'}`;
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    await pool.query(
      `INSERT INTO job_heartbeat
             (job_name, last_status, last_run_at, last_success_at, last_error, run_count, fail_count)
         VALUES ($1, $2, $3, $4, $5, 1, $6)
         ON CONFLICT (job_name) DO UPDATE SET
             last_status     = excluded.last_status,
             last_run_at     = excluded.last_run_at,
             last_success_at = COALESCE(excluded.last_success_at, job_heartbeat.last_success_at),
             last_error      = excluded.last_error,
             run_count       = job_heartbeat.run_count + 1,
             fail_count      = job_heartbeat.fail_count + $6`,
      ['deploy-drift', ok ? 'success' : 'failed', nowMs, ok ? nowMs : null,
       ok ? null : detail.slice(0, 2000), ok ? 0 : 1],
    );
  } catch (err) {
    console.error(`[deploy-drift] WARNING: could not record heartbeat: ${err.message}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main() {
  const head = gitHeadInfo();
  const proc = pm2ProcessInfo('bharat-server');

  console.log(`[deploy-drift] HEAD ${head.sha.slice(0, 12)} committed ${head.committedAt.toISOString()}`);
  if (proc.running) {
    console.log(`[deploy-drift] bharat-server started ${proc.startedAt.toISOString()}`);
  }

  const { status, detail } = driftVerdict(head, proc);

  if (status === 'fail') {
    console.error(`[deploy-drift] FAIL: ${detail}`);
    await recordHeartbeat(false, detail);
    process.exitCode = 1;
    return;
  }

  // Past 4h undeployed: heal it. The heartbeat is still stamped as a SUCCESS — the drift was
  // real but is now remediated by this very run, and marking the run failed would re-raise
  // exactly the noise this change removes. The `auto_restarted:` marker in last_error keeps
  // the event greppable in run history; the NEXT run's pass branch reports the fresh start.
  if (status === 'restart') {
    const restarted = autoRestartServer();
    const marker = restarted ? 'auto_restarted: ' : 'auto_restart_failed: ';
    await recordHeartbeat(true, `${marker}${detail}`);
    process.exitCode = restarted ? 0 : 1;
    return;
  }

  // PENDING is deliberately stamped as a heartbeat SUCCESS: the whole point of the grace window
  // is that a just-landed commit must not raise a critical alert. It still prints, so a human
  // reading the log (or running this by hand after a deploy) sees the pending restart.
  if (status === 'pending') {
    console.warn(`[deploy-drift] PENDING: ${detail}`);
  } else {
    console.log(`[deploy-drift] OK: ${detail}`);
  }
  await recordHeartbeat(true, '');
}

main().catch((err) => {
  console.error(`[deploy-drift] unexpected error: ${err.stack || err}`);
  process.exitCode = 1;
});
