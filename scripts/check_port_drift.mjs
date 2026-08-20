#!/usr/bin/env node
// Detects the "pm2 says online, but nothing is actually listening" failure mode --
// a leftover process from an abnormal restart (Docker Desktop crash, pm2 daemon
// hiccup, a manual recovery command run outside pm2) squats the real service's
// port first, so the pm2-tracked process starts clean but silently fails to bind.
//
// IMPORTANT, learned the hard way live 2026-08-20: a process running one of this
// repo's scripts under the SYSTEM Python install (C:\...\Python311\python.exe)
// rather than backend-python/venv's own python.exe is NOT by itself evidence of
// an orphan. This venv's own launcher (backend-python/venv/Scripts/python.exe) is
// a stub that execs the real interpreter as a CHILD process using the exact path
// recorded in pyvenv.cfg's `home` field -- which on this machine IS the system
// Python311 install -- while correctly wiring up the venv's site-packages, so the
// child legitimately has CUDA torch etc. Confirmed by running a trivial script
// with zero app imports through the venv launcher: it also forks a bare-Python311
// child. Likewise pm2's fork-mode wrapper (ProcessContainerFork.js) always spawns
// the real tsx/node worker for bharat-server as a CHILD, never runs it directly.
// An earlier version of this script flagged both patterns as "wrong interpreter"
// orphans and repeatedly killed the live, working server, which is worse than the
// bug it was meant to catch.
//
// The only thing that actually distinguishes a squatter from the real service's
// own legitimate child is ANCESTRY: is the process that's listening on a service's
// port a descendant of (or equal to) the PID pm2 itself is tracking for that
// service? If yes, it's the real worker, whatever interpreter path it shows. If
// no, it's an unrelated process that got there first -- the actual incident this
// script exists to catch (confirmed live: 3 fully independent processes, with no
// ancestry link to pm2 at all, squatting 3000/8000/8002 for over an hour after a
// Docker Desktop crash).
//
// Run on a schedule (see ecosystem.config.cjs's 'port-drift-check' job) or by hand
// after any manual recovery to confirm nothing was left squatting a port.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import 'dotenv/config';

const isWin = process.platform === 'win32';

// name -> { port, scriptMatch } -- scriptMatch is matched against the process command
// line (case-insensitive substring), used only to find candidate orphans that never
// won the port race at all (e.g. a one-shot script like dl_engine.py that holds no
// port but still burns memory/GPU sitting outside pm2's tree).
const SERVICES = {
  'bharat-server':   { port: 3000, scriptMatch: 'server.ts' },
  'ml-api':          { port: 8000, scriptMatch: 'python_api.py' },
  'chatbot':         { port: 8001, scriptMatch: 'chatbot\\app.py' },
  'alphaquant-api':  { port: 8002, scriptMatch: 'main.py' },
};

function sh(cmd, args) {
  // shell:true -- same rationale as check_deploy_drift.mjs: pm2 resolves to pm2.cmd, a
  // batch wrapper execFileSync can't invoke directly on Windows without going through a
  // shell. Args below are hardcoded literals, never externally-supplied input, so the
  // unescaped-arg risk shell:true warns about doesn't apply.
  return execFileSync(cmd, args, { encoding: 'utf8', shell: true, maxBuffer: 8 * 1024 * 1024 }).trim();
}

// powershell.exe is a real executable (unlike pm2.cmd), so this deliberately runs WITHOUT
// shell:true -- args are passed straight through as an argv array with no cmd.exe parsing
// in between. That matters here specifically: the PowerShell one-liners below pipe through
// Select-Object/ConvertTo-Json, and cmd.exe's own `|` interpretation (triggered even inside
// a quoted argument) breaks that pipe into separate, nonexistent cmd.exe commands before
// PowerShell ever sees it -- confirmed live, shell:true here fails with "'Select-Object' is
// not recognized as an internal or external command".
function shPwsh(psScript) {
  return execFileSync('powershell', ['-NoProfile', '-Command', psScript],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}

function pm2List() {
  try {
    return JSON.parse(sh('pm2', ['jlist']));
  } catch (err) {
    throw new Error(`pm2 jlist failed: ${err.message.slice(0, 300)}`);
  }
}

// Returns { [port]: pid } for every LISTENing TCP port on the host.
function listeningPorts() {
  if (!isWin) return {};
  const ps = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ` +
    `Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress`;
  const out = shPwsh(ps);
  if (!out) return {};
  const rows = JSON.parse(out);
  const arr = Array.isArray(rows) ? rows : [rows];
  const byPort = {};
  for (const r of arr) byPort[r.LocalPort] = r.OwningProcess;
  return byPort;
}

// Returns [{ pid, ppid, interpreter, commandLine }] for every python.exe/node.exe
// process on the host, regardless of who spawned it -- this is deliberately NOT
// scoped to pm2's own tree, since the whole point is catching processes pm2 does
// not know about. ppid is what makes ancestry-walking possible below.
function allInterpreterProcesses() {
  if (!isWin) return [];
  const ps = `Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='node.exe'" | ` +
    `Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  const out = shPwsh(ps);
  if (!out) return [];
  const rows = JSON.parse(out);
  const arr = Array.isArray(rows) ? rows : [rows];
  return arr.map(r => ({
    pid: r.ProcessId,
    ppid: r.ParentProcessId,
    interpreter: r.ExecutablePath || '',
    commandLine: r.CommandLine || '',
  }));
}

// Walks the ppid chain (bounded, since a stale/circular parent record must not hang
// this check) to answer: is `pid` the same as `rootPid`, or a descendant of it?
function isSelfOrDescendant(pid, rootPid, byPid) {
  let cur = String(pid);
  const root = String(rootPid);
  for (let hops = 0; hops < 20; hops++) {
    if (cur === root) return true;
    const proc = byPid.get(cur);
    if (!proc || proc.ppid == null) return false;
    cur = String(proc.ppid);
  }
  return false; // chain longer than any real pm2->worker relationship — treat as unrelated
}

async function recordHeartbeat(ok, detail) {
  const nowMs = Date.now();
  // Raw `pg`, same rationale as check_deploy_drift.mjs's recordHeartbeat: this is a plain
  // .mjs script so it keeps working even if a bad deploy broke the TypeScript build.
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
      ['port-drift', ok ? 'success' : 'failed', nowMs, ok ? nowMs : null,
       ok ? null : detail.slice(0, 2000), ok ? 0 : 1],
    );
  } catch (err) {
    console.error(`[port-drift] WARNING: could not record heartbeat: ${err.message}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main() {
  if (!isWin) {
    console.log('[port-drift] non-Windows host — port/process introspection here is Windows-only, skipping.');
    await recordHeartbeat(true, '');
    return;
  }

  const procs = pm2List();
  const ports = listeningPorts();
  const allProcs = allInterpreterProcesses();
  const byPid = new Map(allProcs.map(p => [String(p.pid), p]));
  const problems = [];

  for (const [name, svc] of Object.entries(SERVICES)) {
    const pm2Proc = procs.find(p => p.name === name);
    if (!pm2Proc || pm2Proc.pm2_env?.status !== 'online') {
      // Not pm2's job to be online right now (e.g. chatbot intentionally stopped) -- skip.
      continue;
    }
    const pm2Pid = pm2Proc.pid;
    const listeningPid = ports[svc.port];

    if (listeningPid == null) {
      problems.push(`${name}: pm2 reports online (pid ${pm2Pid}) but nothing is listening on port ${svc.port} at all.`);
      continue;
    }
    if (!isSelfOrDescendant(listeningPid, pm2Pid, byPid)) {
      const squatter = byPid.get(String(listeningPid));
      const squatterDetail = squatter
        ? `pid ${listeningPid}, interpreter "${squatter.interpreter}", cmd: ${squatter.commandLine.slice(0, 200)}`
        : `pid ${listeningPid} (process details not found — may have exited since the port scan)`;
      problems.push(
        `${name}: port ${svc.port} is held by a process with NO ancestry link to pm2's tracked pid ${pm2Pid} — ${squatterDetail}. ` +
        `Kill the squatter and pm2 will rebind, or 'pm2 restart ${name}'.`
      );
    }
  }

  // Orphan scan for scripts that never bind a port at all (e.g. dl_engine.py) --
  // flag only a process with NO ancestry link to ANY currently-online pm2 process.
  // A legitimate venv-launcher child or pm2 fork-mode worker always chains back to
  // some pm2-tracked pid; a real orphan (leftover from a crash, or a stray manual
  // invocation) does not chain back to anything pm2 knows about.
  const onlinePm2Pids = procs.filter(p => p.pm2_env?.status === 'online').map(p => p.pid);
  for (const [name, svc] of Object.entries(SERVICES)) {
    const matches = allProcs.filter(p =>
      p.commandLine.toLowerCase().includes(svc.scriptMatch.toLowerCase())
    );
    for (const m of matches) {
      const linked = onlinePm2Pids.some(root => isSelfOrDescendant(m.pid, root, byPid));
      if (linked) continue;
      problems.push(
        `${name}: process pid ${m.pid} running ${svc.scriptMatch} has no ancestry link to any online pm2 process ` +
        `— likely a leftover from an abnormal restart. interpreter: ${m.interpreter || 'unknown'}, cmd: ${m.commandLine.slice(0, 200)}`
      );
    }
  }

  if (problems.length > 0) {
    const detail = problems.join(' | ');
    console.error(`[port-drift] FAIL: ${problems.length} issue(s) found:\n${problems.map(p => '  - ' + p).join('\n')}`);
    await recordHeartbeat(false, detail);
    process.exitCode = 1;
    return;
  }

  console.log('[port-drift] OK: every online pm2 service owns its expected port, no orphan interpreter processes found.');
  await recordHeartbeat(true, '');
}

main().catch((err) => {
  console.error(`[port-drift] unexpected error: ${err.stack || err}`);
  process.exitCode = 1;
});
