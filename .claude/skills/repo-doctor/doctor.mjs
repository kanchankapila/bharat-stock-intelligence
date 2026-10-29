#!/usr/bin/env node
/**
 * repo-doctor — ONE consolidated health check across codebase, database, frontend and logs,
 * encoding every recurring bug class this repo has seen (see .claude/rules/recurring-bugs.md).
 *
 * Usage:
 *   node .claude/skills/repo-doctor/doctor.mjs           # quick: static checks + DB + logs
 *   node .claude/skills/repo-doctor/doctor.mjs --full    # also runs tsc + vite build
 *
 * Exit code: 0 = all clear (warnings allowed), 1 = at least one FAIL.
 *
 * RULE: when a new recurring bug is root-caused, ADD A CHECK HERE (the grep/query that would
 * have caught it, negative-controlled so healthy code doesn't trip it) AND a row in
 * recurring-bugs.md. A bug class without a check here WILL silently recur.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import 'dotenv/config';
import {
  classifyLatestDq,
  isKnownTransientFailure,
  latestExpectedNseDailyRun,
  latestExpectedNseIntradaySlot,
  latestNseSessionDate,
  logRotationVerdict,
  unrecoveredFailureRows,
} from './doctor-lib.mjs';

const ROOT = process.cwd();
const results = [];
const check = (id, lane, status, detail) => {
  results.push({ id, lane, status, detail });
  const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️ ' : status === 'SKIP' ? '➖' : '❌';
  console.log(`${icon} [${lane}] ${id} — ${detail}`);
};
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; } };
const persistedPm2EnvHas = (name) => {
  try {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return false;
    const apps = JSON.parse(fs.readFileSync(path.join(home, '.pm2', 'dump.pm2'), 'utf8'));
    return apps.some(app => app?.name === 'bharat-server'
      && String(app?.pm2_env?.[name] || app?.[name] || '').trim());
  } catch { return false; }
};

// ───────────────────────── A. CODEBASE static checks ─────────────────────────
console.log('\n━━━ A. Codebase ━━━');

// AF-20260909-07: 429 must be retried, never treated as final
const tg = read('src/server/telegramService.ts');
check('tg-429-retry', 'code',
  tg.includes('postWithRateLimitRetry') ? 'PASS' : 'FAIL',
  tg.includes('postWithRateLimitRetry') ? '429 retry helper present in telegramService' : 'postWithRateLimitRetry MISSING — 429s would silently drop digests again');

const gemini = read('src/services/geminiService.ts');
const geminiResilient = gemini.includes('GEMINI_MIN_INTERVAL_MS')
  && gemini.includes('GEMINI_MAX_RETRY_DELAY_MS')
  && gemini.includes('providerBlockedUntil');
check('gemini-quota-circuit', 'code', geminiResilient ? 'PASS' : 'FAIL',
  geminiResilient ? 'Gemini calls are paced, bounded, and circuit-break on long quota/provider outages'
    : 'Gemini pacing/retry-delay ceiling/provider circuit is missing');

// AF-20260909-11 follow-up: unmocked test sends must be impossible
check('tg-vitest-guard', 'code',
  tg.includes('process.env.VITEST') ? 'PASS' : 'FAIL',
  tg.includes('process.env.VITEST') ? 'sendMarkdownMessage refuses to send under vitest' : 'VITEST guard MISSING — an unmocked test can message the production Telegram chat');

// AF-20260909-11 root: any test file that IMPORTS jobs/registerJob must either mock
// telegramService or mock registerJob itself (a full-module vi.mock never loads the real file).
// Comment-only path mentions don't count — match import statements, not prose.
let unmocked = [];
try {
  for (const f of fs.readdirSync(path.join(ROOT, 'src/server/__tests__'))) {
    if (!f.endsWith('.test.ts')) continue;
    const t = read(path.join('src/server/__tests__', f));
    const imports = /from '[^']*jobs\/registerJob'/.test(t);
    const safe = t.includes("vi.mock('../telegramService'") || t.includes("vi.mock('../jobs/registerJob'");
    if (imports && !safe) unmocked.push(f);
  }
} catch { /* dir missing in odd checkouts */ }
check('tests-mock-telegram', 'code', unmocked.length ? 'FAIL' : 'PASS',
  unmocked.length ? `test files import jobs/registerJob WITHOUT mocking telegramService: ${unmocked.join(', ')}` : 'all registerJob-driving tests mock telegramService');

// AF-20260909-08: the dead winProbability gate must never come back
const tss = read('src/server/technicalSignalsService.ts');
check('scan-digest-gate', 'code',
  tss.includes('r.winProbability >= 0.85') ? 'FAIL' : (tss.includes('sendTelegramSignals') ? 'PASS' : 'WARN'),
  tss.includes('r.winProbability >= 0.85') ? 'dead winProbability gate RESURRECTED — scan digest would go silent again' : (tss.includes('sendTelegramSignals') ? 'scan digest gated on signalScore + export present' : 'sendTelegramSignals export not found — scan digest path changed, re-verify'));

// AF-20260909-09: benign stderr classification
const sweep = read('src/server/jobSweep.ts');
check('highflyer-benign', 'code',
  /HighFlyer.*skipped.*stat day/i.test(sweep) ? 'PASS' : 'WARN',
  /HighFlyer.*skipped.*stat day/i.test(sweep) ? 'HighFlyer skip-notice in BENIGN list' : 'HighFlyer benign pattern missing — successful runs will warn as real_error again');

// AF-20260909-10: vite watcher must ignore churn-only files
const vite = read('vite.config.ts');
check('vite-watch-ignored', 'code',
  vite.includes('.audit-files.txt') ? 'PASS' : 'WARN',
  vite.includes('.audit-files.txt') ? '.audit-files.txt in vite watch.ignored' : 'audit scratch files may re-trigger EBUSY rejections in vite watcher');

// AF-20261014-07: a lost PM2 daemon leaves real venv interpreters serving behind dead
// redirectors. The guard must prove same-service ownership before terminating an exact PID, and
// its timeout must count as unstable rather than resetting max_restarts forever.
const portGuard = read('src/server/pyboot/port_guard.py');
const ecosystem = read('ecosystem.config.cjs');
const minUptimeMatch = ecosystem.match(/min_uptime:\s*([\d_]+)/);
const minUptimeMs = minUptimeMatch ? Number(minUptimeMatch[1].replaceAll('_', '')) : 0;
const managedTakeover = portGuard.includes('owner[0] == expected_service')
  && portGuard.includes('owner[1] != os.getpid()')
  && portGuard.includes('_terminate_process(owner[1])')
  && minUptimeMs > 300_000;
{
  // AF-20261028-20
  const home = process.env.USERPROFILE || process.env.HOME || '';
  let logBytes = 0;
  try { logBytes = fs.statSync(path.join(ROOT, 'logs', 'pm2-out.log')).size; } catch { /* no log yet */ }
  const v = logRotationVerdict({ moduleInstalled: fs.existsSync(path.join(home, '.pm2', 'modules', 'pm2-logrotate')), logBytes });
  check('pm2-log-rotation', 'infra', v.status, v.detail);
}
check('pm2-python-orphan-takeover', 'code', managedTakeover ? 'PASS' : 'FAIL',
  managedTakeover
    ? `same-service PID takeover present; PM2 min_uptime ${minUptimeMs}ms exceeds the 300000ms guard`
    : 'safe same-service PID takeover or PM2 stability-window ordering is missing — an orphan can restart-storm forever');

// AF-20261014-08: PM2 kill_timeout is shutdown grace after SIGINT, not maximum runtime. An
// hours-long value delays the next cron restart if the prior run is genuinely hung.
const bqaBlock = ecosystem.match(/name:\s*'bqa-daily'[\s\S]*?kill_timeout:\s*([\d_]+)/);
const bqaShutdownGraceMs = bqaBlock ? Number(bqaBlock[1].replaceAll('_', '')) : 0;
const bqaShutdownBounded = bqaShutdownGraceMs >= 60_000 && bqaShutdownGraceMs <= 15 * 60_000;
check('bqa-daily-shutdown-grace', 'code', bqaShutdownBounded ? 'PASS' : 'FAIL',
  bqaShutdownBounded
    ? `BQA daily shutdown grace is ${(bqaShutdownGraceMs / 60_000).toFixed(0)}m; the next cron cannot wait hours on a hung predecessor`
    : `BQA daily kill_timeout ${bqaShutdownGraceMs || 'missing'}ms is not a 1-15m shutdown grace`);

// AF-20261014-10: a fan-out is not successful when the parent merely enqueues delayed children,
// and arbitrary child successes must not overwrite a sibling failure.
const queuesSource = read('src/server/queues.ts');
const batchSource = read('src/server/trendlyneDailyBatch.ts');
const jobRegistrySource = read('src/server/jobRegistry.ts');
const trendlyneGraceMatch = jobRegistrySource.match(
  /jobName:\s*'trendlyne-daily-fetch'[\s\S]{0,250}?graceMinutes:\s*(\d+)/,
);
const trendlyneGraceMinutes = trendlyneGraceMatch ? Number(trendlyneGraceMatch[1]) : 0;
const honestTrendlyneBatch = queuesSource.includes('initialiseTrendlyneBatch(')
  && queuesSource.includes('settleTrendlyneBatch(')
  && queuesSource.includes('job.attemptsMade < attempts')
  && queuesSource.includes('legacy child completed')
  && batchSource.includes("hsetnx(key, 'completed'")
  && batchSource.includes('missing batch state for')
  && trendlyneGraceMinutes >= 12 * 60;
check('trendlyne-fanout-heartbeat', 'code', honestTrendlyneBatch ? 'PASS' : 'FAIL',
  honestTrendlyneBatch
    ? `Trendlyne daily heartbeat finalises once from retry-safe aggregate terminal child outcomes; grace=${trendlyneGraceMinutes}m`
    : 'Trendlyne daily fan-out lacks retry-safe state, honest terminal aggregation, or enough grace for its delayed children');

// Recurring class "notification gate reads a field its pipeline never populates" (heuristic)
const suspectGates = new Set();
const gateFieldWriters = new Set();
try {
  for (const f of fs.readdirSync(path.join(ROOT, 'src/server'))) {
    if ((!f.endsWith('.ts') && !f.endsWith('.py')) || f.endsWith('.test.ts')) continue;
    const body = read(path.join('src/server', f));
    if (f.endsWith('.ts') && /\.winProbability\b/.test(body)) suspectGates.add(f);
    if (/\bSET\s+(?:calibrated_)?win_probability\s*=|\bwin_probability\s*=\s*\?/i.test(body)) gateFieldWriters.add(f);
  }
} catch { /* ignore */ }
const unwrittenGate = suspectGates.size > 0 && gateFieldWriters.size === 0;
check('gate-field-writers', 'code', unwrittenGate ? 'WARN' : 'PASS',
  unwrittenGate
    ? `.winProbability readers exist in ${[...suspectGates].join(', ')} but no win_probability writer was found`
    : suspectGates.size
      ? `.winProbability readers backed by writers in ${[...gateFieldWriters].join(', ')}`
      : 'no suspicious never-populated gate fields (winProbability class)');

// SQLite-ism guard: SQLite-only SQL in server TS (pgClient may translate — flag for a read)
const sqliteisms = [];
try {
  for (const f of fs.readdirSync(path.join(ROOT, 'src/server'))) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    if (f === 'sqlTranslate.ts') continue; // translator implementation/docs are not a SQL call site
    const body = read(path.join('src/server', f));
    const unsupported = /strftime\(/.test(body);
    const translatedDatetime = /datetime\('now'\)/.test(body) &&
      (f === 'sqlTranslate.ts' || /from\s+['"]\.\/dbAsync['"]/.test(body));
    if (unsupported || (/datetime\('now'\)/.test(body) && !translatedDatetime)) sqliteisms.push(f);
  }
} catch { /* ignore */ }
check('sqlite-isms', 'code', sqliteisms.length ? 'WARN' : 'PASS',
  sqliteisms.length ? `untranslated SQLite-only SQL in ${sqliteisms.join(', ')} — route through dbAsync or convert` : 'SQLite-compatible SQL is translated through dbAsync; no bypasses found');

// AF-20260909-14: classification colour mappings must never be inverted relative to
// direction. The Grafana "top losers" panel once mapped Strong Sell → dark-green / Strong
// Buy → dark-red (a correct Sell call showed green); this greps every grafana/*.json for
// the inverted signature so it cannot silently recur beside a correctly-coloured sibling.
const grafanaDir = 'grafana';
const invertedColourMappings = [];
try {
  for (const f of fs.readdirSync(path.join(ROOT, grafanaDir))) {
    if (!f.endsWith('.json')) continue;
    const g = read(path.join(grafanaDir, f));
    if (/"Strong Sell"\s*:\s*\{[^}]*"color"\s*:\s*"dark-green"/.test(g) ||
        /"Strong Buy"\s*:\s*\{[^}]*"color"\s*:\s*"dark-red"/.test(g)) invertedColourMappings.push(f);
  }
} catch { /* grafana/ absent */ }
check('grafana-systemcall-colors', 'code', invertedColourMappings.length ? 'FAIL' : 'PASS',
  invertedColourMappings.length
    ? `inverted System-call colour mapping (Sell=green / Buy=red) in ${invertedColourMappings.join(', ')} — flip it back` : 'all grafana classification mappings colour Sell=red, Buy=green');

// AF-20260910-01: a job whose processor's own catch calls updateMonitorState('name','failed',...)
// AND whose worker.on('failed', ...) handler also calls it will double-log every failure --
// withJobTimeout is Promise.race([fn(), timeout]), so a processor-thrown error still propagates
// to BullMQ and fires 'failed' even though the processor's own catch already logged it. Found in
// quant-eod-sync (fixed 2026-09-10): two identical job_run_history rows 9ms apart for one real
// failure, inflating its 7-day fail-rate. Detects any job NAME logged 'failed' via
// updateMonitorState/recordHeartbeat with a LITERAL string at 2+ call sites in the same file set
// -- registerJob.ts's own shared handler uses a variable (fName/mName), not a literal, so it
// never trips this; only a hand-rolled second write site does.
const dualFailureLogs = new Map(); // name -> [line, ...]
try {
  for (const f of ['src/server/queues.ts', ...fs.readdirSync(path.join(ROOT, 'src/server/jobs')).filter(x => x.endsWith('.ts')).map(x => `src/server/jobs/${x}`)]) {
    const src = read(f);
    if (!src) continue;
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/(?:updateMonitorState|recordHeartbeat)\(\s*'([^']+)'\s*,\s*'failed'/);
      if (m) {
        const key = m[1];
        if (!dualFailureLogs.has(key)) dualFailureLogs.set(key, []);
        dualFailureLogs.get(key).push(`${f}:${i + 1}`);
      }
    });
  }
} catch { /* jobs dir absent */ }
const dualLogged = [...dualFailureLogs.entries()].filter(([, sites]) => sites.length > 1);
check('dual-failure-log', 'code', dualLogged.length ? 'WARN' : 'PASS',
  dualLogged.length
    ? `job name logged 'failed' from 2+ literal call sites (double-counts every failure): ${dualLogged.map(([n, s]) => `${n} (${s.join(', ')})`).join('; ')}`
    : 'no job logs \'failed\' from more than one literal call site');

// ───────────────────────── B. FRONTEND ─────────────────────────
console.log('\n━━━ B. Frontend ━━━');
const indexHtml = read('index.html');
check('frontend-shell', 'frontend', indexHtml ? 'PASS' : 'WARN',
  indexHtml ? 'index.html present (v1 shell is the only frontend since fd0cbd4)' : 'index.html not found — frontend shape changed?');
if (process.argv.includes('--full')) {
  try {
    execSync('npx tsc --noEmit', { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60_000 });
    check('tsc-noemit', 'frontend', 'PASS', 'tsc --noEmit clean');
  } catch (e) {
    check('tsc-noemit', 'frontend', 'FAIL', `tsc errors: ${String(e.stdout || e.message).slice(0, 400)}`);
  }
  try {
    execSync('npx vite build --logLevel error', { cwd: ROOT, stdio: 'pipe', timeout: 15 * 60_000 });
    check('vite-build', 'frontend', 'PASS', 'vite build clean');
  } catch (e) {
    check('vite-build', 'frontend', 'FAIL', `vite build failed: ${String(e.stdout || e.message).slice(0, 400)}`);
  }
} else {
  check('tsc-noemit', 'frontend', 'SKIP', 'run with --full to execute tsc/vite build');
}

// ───────────────────────── C. DATABASE ─────────────────────────
console.log('\n━━━ C. Database ━━━');
let client = null;
try {
  const pg = (await import('pg')).default;
  client = new pg.Client({
    connectionString: process.env.POSTGRES_URL || 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel',
    statement_timeout: 15_000,
  });
  await client.connect();
} catch (e) {
  check('pg-connect', 'db', 'FAIL', `cannot reach Postgres: ${e.message}`);
}
if (client) {
  const q = async (sql) => (await client.query(sql)).rows;
  const nowMs = Date.now();

  // job_heartbeat stores naive-UTC epochs: compare epoch ms directly, never AT TIME ZONE.
  // Ages = cadence + documented grace from JOB_REGISTRY (rounded up generously).
  const freshness = [
    ['ml-daily-ops', 30, 'nse-daily', { hourUtc: 13, minuteUtc: 20, graceMinutes: 270 }],
    ['ml-weekly-data', 24 * 9], ['ml-weekly-retrain', 24 * 9],
    ['data-quality-daily', 30], ['job-digest', 30], ['job-digest-morning', 30],
    ['recommendations-digest', 30, 'nse-daily', { hourUtc: 17, minuteUtc: 10, graceMinutes: 90 }],
    ['quant-eod-sync', 30, 'nse-daily', { hourUtc: 16, minuteUtc: 30, graceMinutes: 360 }],
    ['outcome-resolver', 30, 'nse-daily', { hourUtc: 4, minuteUtc: 0, graceMinutes: 45 }],
    ['trendlyne-midweek', 24 * 9],
    ['nt-live-filter-capture', 20, 'nse-intraday'], ['technical-scan', 24 * 3, 'nse-intraday'],
  ];
  let nseHolidays = [];
  try {
    nseHolidays = (await q(`SELECT to_char(date, 'YYYY-MM-DD') AS day
      FROM market_holidays
      WHERE exchange = 'NSE' AND date >= current_date - interval '40 days'`)).map(r => r.day);
  } catch { /* heartbeat query below remains useful even if the holiday calendar is unavailable */ }

  for (const [job, maxAgeH, schedule, scheduleOptions] of freshness) {
    try {
      const rows = await q(`SELECT last_status, last_success_at FROM job_heartbeat WHERE job_name = '${job}'`);
      if (!rows.length) { check(`hb-${job}`, 'db', 'WARN', 'no heartbeat row (verify the job is heartbeat-less by design)'); continue; }
      const lastSuccessMs = Number(rows[0].last_success_at || 0);
      const ageH = (nowMs - lastSuccessMs) / 3_600_000;
      const lastFailed = rows[0].last_status === 'failed';
      if (schedule === 'nse-intraday') {
        const latestDueMs = latestExpectedNseIntradaySlot(new Date(nowMs), nseHolidays);
        const late = latestDueMs != null && lastSuccessMs < latestDueMs;
        const due = latestDueMs == null ? 'none' : new Date(latestDueMs).toISOString();
        check(`hb-${job}`, 'db', lastFailed || late ? 'WARN' : 'PASS',
          `last success ${ageH.toFixed(1)}h ago; latest completed NSE slot ${due}; status ${rows[0].last_status}`);
      } else if (schedule === 'nse-daily') {
        const latestDueMs = latestExpectedNseDailyRun(new Date(nowMs), nseHolidays, scheduleOptions);
        const late = latestDueMs != null && lastSuccessMs < latestDueMs;
        const due = latestDueMs == null ? 'none' : new Date(latestDueMs).toISOString();
        check(`hb-${job}`, 'db', lastFailed || late ? 'WARN' : 'PASS',
          `last success ${ageH.toFixed(1)}h ago; latest due NSE run ${due}; status ${rows[0].last_status}`);
      } else {
        check(`hb-${job}`, 'db', lastFailed || ageH > maxAgeH ? 'WARN' : 'PASS',
          `last success ${ageH.toFixed(1)}h ago (tolerates ≤${maxAgeH}h), status ${rows[0].last_status}`);
      }
    } catch (e) { check(`hb-${job}`, 'db', 'WARN', `query failed: ${e.message}`); }
  }

  // AF-20260910-05: the whole platform stops when the host sleeps or reboots, and NOTHING
  // detects it -- every heartbeat/fail-rate check above reads "healthy" because a job that never
  // ran writes no failure. There is no pm2 Windows service and no scheduled task, so pm2 does
  // not come back until a human starts it (2026-09-10: a Windows Update restart at 02:06 IST
  // left the platform down 4.4h; the trailing 14 days held NINE gaps over 2h, ~40h total).
  //
  // Threshold calibrated against the real distribution rather than guessed, per this repo's rule
  // that a check firing on correct data stops being read: measured over 14d / 15,927 intervals,
  // p50 = 0.23min, p95 = 5.2min, p99 = 14.5min. 90min is ~6x p99 -- it cannot fire on healthy
  // operation, and it caught all nine real outages when backtested.
  try {
    const OUTAGE_MIN = 90;
    const gaps = await q(`
      WITH ordered AS (
        SELECT ran_at, lag(ran_at) OVER (ORDER BY ran_at) AS prev
        FROM job_run_history WHERE ran_at > now() - interval '7 days'
      )
      SELECT round((EXTRACT(EPOCH FROM (ran_at - prev))/60.0)::numeric) AS gap_min, prev, ran_at
      FROM ordered
      WHERE prev IS NOT NULL AND EXTRACT(EPOCH FROM (ran_at - prev))/60.0 > ${OUTAGE_MIN}
      ORDER BY gap_min DESC LIMIT 5`);
    check('platform-outage-gaps', 'db', gaps.length ? 'WARN' : 'PASS',
      gaps.length
        ? `${gaps.length} window(s) >${OUTAGE_MIN}min with NO job of any kind running (7d) — the platform was down, not idle: `
          + gaps.map(g => `${Math.round(g.gap_min)}min (${new Date(g.prev).toISOString().slice(5, 16)}Z→${new Date(g.ran_at).toISOString().slice(5, 16)}Z)`).join('; ')
          + ` — check host sleep/reboot + whether pm2 auto-starts (scripts/install-pm2-autostart.ps1)`
        : `no job-run gap >${OUTAGE_MIN}min in 7d (platform ran continuously)`);
  } catch (e) { check('platform-outage-gaps', 'db', 'WARN', e.message); }

  // 7d fail-rate flags (same shape the digest uses)
  try {
    const fr = await q(`SELECT job_name, COUNT(*) AS total, COUNT(*) FILTER (WHERE status <> 'success') AS fails
      FROM job_run_history WHERE ran_at > now() - interval '7 days'
      GROUP BY job_name HAVING COUNT(*) >= 5`);
    const flagged = fr.filter(r => r.fails / r.total > 0.25);
    check('fail-rates-7d', 'db', flagged.length ? 'WARN' : 'PASS',
      flagged.length ? `>25% fail-rate (7d): ${flagged.map(r => `${r.job_name} ${r.fails}/${r.total}`).join('; ')} — classify each failure (vendor/timeout/real)` : 'no job above 25% fail-rate over 7d');
  } catch (e) { check('fail-rates-7d', 'db', 'WARN', e.message); }

  // 48h failures not explained by known-benign vendor/retry classes
  try {
    const fails48 = await q(`SELECT f.job_name, f.ran_at, left(coalesce(f.error,''),160) AS err,
        EXISTS (
          SELECT 1 FROM job_run_history s
          WHERE s.job_name = f.job_name AND s.status = 'success' AND s.ran_at > f.ran_at
        ) AS recovered
      FROM job_run_history f WHERE f.ran_at > now() - interval '48 hours' AND f.status <> 'success'
      ORDER BY ran_at DESC LIMIT 20`);
    const unexplained = unrecoveredFailureRows(fails48);
    const recovered = fails48.filter(r => r.recovered).length;
    const transient = fails48.filter(r => !r.recovered && isKnownTransientFailure(r.err)).length;
    check('failures-48h', 'db', unexplained.length ? 'WARN' : 'PASS',
      unexplained.length
        ? `failures needing root-cause: ${unexplained.map(r => `${r.job_name}@${new Date(r.ran_at).toISOString().slice(0, 16)}: ${r.err}`).join(' | ').slice(0, 400)}`
        : `${fails48.length} failures in 48h; ${recovered} recovered by a later success, ${transient} known transient`);
  } catch (e) { check('failures-48h', 'db', 'WARN', e.message); }

  // data-quality latest-per-check
  try {
    const dq = await q(`WITH latest AS (SELECT DISTINCT ON (check_id) check_id, status, critical
        FROM data_quality_results ORDER BY check_id, checked_at DESC)
      SELECT check_id, status, critical FROM latest ORDER BY check_id`);
    const verdict = classifyLatestDq(dq);
    check('dq-latest', 'db', verdict.status, verdict.detail);
  } catch (e) { check('dq-latest', 'db', 'WARN', e.message); }

  // ml dispersion collapse (isotonic-calibration behaviour — trend-watch, not a fix)
  try {
    const disp = await q(`SELECT status, left(detail, 200) AS detail FROM data_quality_results
      WHERE check_id = 'ur-engine-dispersion-collapse' ORDER BY checked_at DESC LIMIT 1`);
    if (disp.length) check('ml-dispersion', 'db', disp[0].status === 'fail' ? 'WARN' : 'PASS',
      `${disp[0].status}: ${disp[0].detail} (measurement.md: do NOT "fix"; watch trend + retrain freshness)`);
  } catch { /* check may not exist */ }

  // producer freshness: engine composite / recommendations / research reports
  try {
    const ecs = await q(`SELECT MAX(computed_at) AS m FROM engine_composite_scores`);
    const ageD = ecs[0]?.m ? (nowMs - new Date(ecs[0].m).getTime()) / 86_400_000 : 1e9;
    check('engine-composite', 'db', ageD > 9 ? 'WARN' : 'PASS',
      `engine_composite_scores max computed_at ${ecs[0]?.m ?? 'NULL'} (${ageD.toFixed(1)}d old; producer = ml-weekly-retrain)`);
    const recs = await q(`SELECT 'unified' AS src, MAX(computed_at) AS m FROM unified_recommendations
      UNION ALL SELECT 'intraday', MAX(computed_at) FROM intraday_recommendations`);
    const latestSessionDay = latestNseSessionDate(new Date(nowMs), nseHolidays);
    for (const r of recs) {
      const expectedDay = r.src === 'intraday'
        ? latestSessionDay
        : new Date(nowMs - 36 * 3_600_000).toISOString().slice(0, 10);
      const stale = !r.m || (expectedDay != null && String(r.m).slice(0, 10) < expectedDay);
      check(`recs-${r.src}`, 'db', stale ? 'WARN' : 'PASS', `max computed_at ${r.m}`);
    }
    const reports = await q(`SELECT status, COUNT(*) AS n FROM daily_research_reports
      WHERE report_date >= (SELECT MAX(report_date) FROM daily_research_reports) GROUP BY status`);
    check('research-reports', 'db', reports.some(r => r.status !== 'READY') ? 'WARN' : 'PASS',
      reports.map(r => `${r.status}=${r.n}`).join(' / ') || 'no rows');
  } catch (e) { check('producer-freshness', 'db', 'WARN', e.message); }

  // test-fixture contamination (AF-20260909-11 class)
  try {
    const contam = await q(`SELECT COUNT(*) AS n FROM job_heartbeat WHERE last_error LIKE '%fake-queue%'`);
    check('no-test-contamination', 'db', Number(contam[0].n) > 0 ? 'FAIL' : 'PASS',
      Number(contam[0].n) > 0 ? `${contam[0].n} heartbeat rows reference 'fake-queue' — test fixtures leaked into prod state` : 'no fake-queue contamination in job_heartbeat');
  } catch (e) { check('no-test-contamination', 'db', 'WARN', e.message); }

  // telegram settings + gemini key
  try {
    // Prove configuration without selecting or printing any credential material. Token prefixes
    // and chat identifiers are still secrets; redaction is safer than partial disclosure.
    const tgset = await q(`SELECT key, (COALESCE(value, '') <> '') AS configured,
        CASE WHEN key = 'telegram_enabled' THEN lower(value) = 'true' ELSE NULL END AS enabled
      FROM app_settings WHERE key LIKE 'telegram%'`);
    const enabled = tgset.find(r => r.key === 'telegram_enabled')?.enabled === true;
    const hasTok = tgset.find(r => r.key === 'telegram_bot_token')?.configured === true;
    const hasChat = tgset.find(r => r.key === 'telegram_chat_id')?.configured === true;
    check('telegram-settings', 'db', enabled && hasTok && hasChat ? 'PASS' : 'WARN',
      `enabled=${enabled}; bot_token=${hasTok ? 'configured' : 'missing'}; chat_id=${hasChat ? 'configured' : 'missing'}`);
  } catch (e) { check('telegram-settings', 'db', 'WARN', e.message); }
  // The interactive shell may intentionally omit secrets while the persisted PM2 service
  // environment contains them. Check the deployed process configuration without printing it.
  if (!String(process.env.GEMINI_API_KEY || '').trim() && persistedPm2EnvHas('GEMINI_API_KEY')) {
    process.env.GEMINI_API_KEY = '__present_in_pm2__';
  }
  check('gemini-key', 'db', process.env.GEMINI_API_KEY ? 'PASS' : 'WARN',
    process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY present' : 'GEMINI_API_KEY empty — AI features degrade honestly (user action, AF-20260828-24)');
}
// ───────────────────────── D. LOGS (today + yesterday) ─────────────────────────
console.log('\n━━━ D. Logs ━━━');
const BENIGN_LOG = [
  [/(?:^|[\s\\/])__tests__[\\/]fixtures[\\/]mem_hog\.py\b/i, 'intentional Python memory-ceiling test fixture'],
  [/waf|captcha/i, 'Trendlyne WAF captcha (vendor block, self-clears)'],
  [/niftytrader.*(unauthorized|403|timeout)|execution budget/i, 'NiftyTrader vendor block/budget (self-clears)'],
  [/marketsmojo/i, 'MarketsMojo crawl (progressive 7-day skip cache)'],
  [/EBUSY.*audit-files/i, 'vite watcher EBUSY (ignored since AF-10)'],
  [/error_code:? ?429|retry after/i, 'Telegram 429 (retried since AF-07)'],
  [/timeout exceeded when trying to connect/i, 'DB connect blip (documented transient family — verify it did not persist)'],
  [/GenAI (?:Profile )?API Error:.*(?:429|503)/i, 'legacy pre-circuit Gemini quota/high-demand error (current code logs bounded WARN; doctor enforces the circuit)'],
  [/Error fetching /i, 'fetcher vendor error (verify the next scheduled run succeeded)'],
  // Child attempts are retry telemetry. The batch-final `batch failed: N/M symbol fetches
  // failed` line is deliberately NOT matched and remains the actionable aggregate outcome.
  [/^\[QUEUE\] trendlyne-daily-fetch failed: Trendlyne metrics fetch returned no durable data for \S+$/i,
    'Trendlyne symbol retry (aggregate batch verdict remains actionable)'],
];
try {
  const days = [new Date(), new Date(Date.now() - 86_400_000)].map(d => d.toISOString().slice(0, 10));
  const seen = new Map();
  for (const day of days) {
    const f = path.join(ROOT, 'logs', `app-${day}.log`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"level":"error"')) continue;
      let msg = line; try { msg = JSON.parse(line).message || line; } catch { /* raw */ }
      const key = String(msg).replace(/[0-9a-f-]{16,}|\d{3,}/g, '#').slice(0, 90);
      if (!seen.has(key)) {
        seen.set(key, { n: 0, sample: String(msg).slice(0, 140), benign: (BENIGN_LOG.find(([re]) => re.test(String(msg))) || [])[1] });
      }
      seen.get(key).n++;
    }
  }
  const unknown = [...seen.entries()].filter(([, v]) => !v.benign);
  const totalErr = [...seen.values()].reduce((a, v) => a + v.n, 0);
  check('log-errors', 'logs', unknown.length ? 'WARN' : 'PASS',
    unknown.length
      ? `${unknown.length} unclassified error signature(s): ${unknown.slice(0, 4).map(([, v]) => `${v.n}x ${v.sample}`).join(' | ')}`
      : `${totalErr} error lines, all match known-benign classes`);
  for (const [, v] of [...seen.entries()].filter(([, v]) => v.benign).slice(0, 6)) {
    console.log(`      · benign ${v.n}x — ${v.benign}`);
  }
} catch (e) {
  check('log-errors', 'logs', 'WARN', `log scan failed: ${e.message}`);
}

// ───────────────────────── summary ─────────────────────────
const fails = results.filter(r => r.status === 'FAIL');
const warns = results.filter(r => r.status === 'WARN');
console.log(`\n━━━ repo-doctor: ${results.length} checks — ${results.filter(r => r.status === 'PASS').length} PASS, ${warns.length} WARN, ${fails.length} FAIL ━━━`);
if (warns.length) console.log('WARN = needs a human read (documented-benign or trend-watch), not necessarily a fix.');
if (client) await client.end().catch(() => {});
if (fails.length) { console.log('FAIL = regression-guard breach — fix before commit.'); process.exit(1); }
