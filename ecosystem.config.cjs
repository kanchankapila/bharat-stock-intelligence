/**
 * PM2 process manager config (P5 hardening).
 *
 * Replaces `concurrently` for running the stack, which does NOT restart a crashed
 * child — the cause of a real incident where the Python AlphaQuant service (port 8002)
 * silently died and stock scores went stale for weeks. PM2 auto-restarts each service,
 * keeps logs, and (via `pm2 save` + `pm2 startup`) survives a reboot.
 *
 *   npm i -g pm2
 *   pm2 start ecosystem.config.cjs      # boot the whole stack
 *   pm2 logs / pm2 status / pm2 restart all
 *   pm2 save && pm2 startup             # persist across reboot
 *
 * The four services mirror the `npm start` scripts exactly (same interpreters/paths).
 */
const path = require('path');
const fs = require('fs');

const isWin = process.platform === 'win32';
const VENV_PY = isWin
  ? path.resolve(__dirname, 'backend-python', 'venv', 'Scripts', 'python.exe')
  : path.resolve(__dirname, 'backend-python', 'venv', 'bin', 'python');

// Inject .env into EVERY service. The Node app loads dotenv itself, but the Python services
// (AlphaQuant, ml-api, chatbot) only see what we hand them — without POSTGRES_URL they cannot
// connect at all (SQLite has been fully decommissioned since 2026-08-17; the split-brain
// incident this guard originally came from predates that). Parsing .env here keeps every
// service on one DB engine.
let dotenvVars = {};
try {
  dotenvVars = require('dotenv').parse(fs.readFileSync(path.resolve(__dirname, '.env')));
} catch (_) { /* .env optional */ }

// Shared restart policy: recover from crashes, but back off and cap to avoid a tight
// restart storm if a service is fundamentally misconfigured (e.g. venv missing).
const common = {
  autorestart: true,
  max_restarts: 10,
  restart_delay: 3000,
  min_uptime: 10_000,
  kill_timeout: 10_000,
  env: { ...dotenvVars, PYTHONUNBUFFERED: '1' },
  out_file: path.resolve(__dirname, 'logs', 'pm2-out.log'),
  error_file: path.resolve(__dirname, 'logs', 'pm2-err.log'),
  merge_logs: true,
  time: true,
};

// Shared config for greenfield one-shot cron jobs (shadow-ranker pipeline).
// cron_restart schedules the run; autorestart:false lets the script exit normally
// without pm2 restarting it immediately.
//
// cron_restart strings below are LOCAL SERVER TIME (IST, UTC+5:30), not UTC, despite
// every job's inline comment historically documenting a "UTC = IST" pair as if the UTC
// half were literal. Found 2026-08-27: PM2's cron_restart (Worker.js) calls
// `Cron(pm2_env.cron_restart, callback)` from the `croner` package with no options object
// at all -- no timezone field exists anywhere in PM2's own cron_restart code path for an
// ecosystem.config.cjs app to set, so croner always falls back to the process's system
// timezone (IST on this host, confirmed via job_heartbeat: pg-backup fired at 17:45
// LOCAL, matching its raw '45 17 * * *' string, not the intended 17:45 UTC = 23:15 IST).
// Every cron string below was therefore firing 5.5h earlier than its own comment's stated
// intent for as long as it has run. Fixed by rewriting each string to its true IST
// value (arithmetic verified against the pre-existing "X UTC = Y IST" comments, which were
// internally correct -- only the code never matched them) and updating comments to match.
// Prerequisite: run `pnpm install` once inside the greenfield/ directory so that
// @greenfield/* workspace packages are resolvable from their pnpm virtual store.
const gfCron = {
  autorestart: false,
  exec_mode: 'fork',
  kill_timeout: 600_000,        // 10 min default grace; overridden per-job where needed
  interpreter: 'node',
  script: path.resolve(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  env: {
    ...dotenvVars,
    // Greenfield scripts read DATABASE_URL; point at the greenfield DB if a
    // separate GREENFIELD_DATABASE_URL is configured, else fall back to legacy.
    DATABASE_URL: dotenvVars.GREENFIELD_DATABASE_URL ?? dotenvVars.DATABASE_URL,
  },
  out_file: path.resolve(__dirname, 'logs', 'gf-out.log'),
  error_file: path.resolve(__dirname, 'logs', 'gf-err.log'),
  merge_logs: true,
  time: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'bharat-server',
      script: path.resolve(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      args: 'server.ts',
      interpreter: 'node',
      node_args: '--max-old-space-size=4096',
      max_memory_restart: '3500M',
    },
    {
      ...common,
      name: 'alphaquant-api',          // FastAPI on :8002 — the service that went silently down
      script: 'main.py',
      cwd: path.resolve(__dirname, 'backend-python'),
      interpreter: isWin
        ? path.resolve(__dirname, 'backend-python', 'venv', 'Scripts', 'python.exe')
        : path.resolve(__dirname, 'backend-python', 'venv', 'bin', 'python'),
    },
    {
      ...common,
      name: 'ml-api',
      script: path.resolve(__dirname, 'src', 'server', 'python_api.py'),
      interpreter: VENV_PY,
    },
    {
      ...common,
      name: 'chatbot',                 // FastAPI on :8001
      script: path.resolve(__dirname, 'src', 'server', 'chatbot', 'app.py'),
      interpreter: VENV_PY,
    },
    {
      ...common,
      name: 'engine-worker',           // FastAPI on :8005 — Ingestion Governor, MCP server & Engine Worker
      script: path.resolve(__dirname, 'src', 'server', 'worker_service.py'),
      interpreter: VENV_PY,
    },


    // ------------------------------------------------------------------
    // Greenfield shadow-ranker pipeline (one-shot cron jobs, local IST times — see gfCron's own comment)
    // Chain: bhavcopy → fii-dii → features → ranker (daily, weekdays)
    //        kayal screeners (weekly, Sunday) | fundamentals (weekly, Saturday)
    // ------------------------------------------------------------------

    {
      ...gfCron,
      name: 'gf-bhavcopy-daily',
      // 19:30 IST (14:00 UTC) — matches queues.ts's own proven margin ("bhavcopy and MTO
      // files land ~18:00 IST, so 19:30 left most of the post-close window"). Was 16:00 IST,
      // ~2h before NSE actually publishes; every weekday run 2026-08-24..08-28 hit a
      // too-early 404 and got permanently misrecorded as "non-trading day" (isRunAlreadyCompleted
      // treats status='skipped' as done forever, so nothing ever retried) — found + fixed 2026-08-30.
      cron_restart: '30 19 * * 1-5',
      args: 'greenfield/packages/ingestion/src/nse/run-daily-bhavcopy.ts',
    },
    {
      ...gfCron,
      name: 'gf-fii-dii-daily',
      // 21:00 IST (15:30 UTC) — shifted with the bhavcopy fix above; was 17:30 IST
      cron_restart: '0 21 * * 1-5',
      args: 'greenfield/packages/ingestion/src/stage3/run-daily-fii-dii.ts',
    },
    {
      ...gfCron,
      name: 'gf-features-daily',
      // 21:30 IST (16:00 UTC) — after bhavcopy + FII/DII land; was 18:00 IST
      cron_restart: '30 21 * * 1-5',
      args: 'greenfield/packages/ingestion/src/stage4/run-compute-features.ts',
    },
    {
      ...gfCron,
      name: 'gf-stage3-dq-daily',
      // 21:40 IST (16:10 UTC) — Task 3.7's 5 checks (corporate-actions/fundamentals/fii-dii/
      // screener-membership freshness+coverage) had evaluateAllStage3Checks/
      // persistStage3DqResult exported but no runner anywhere — dead code from
      // an operational standpoint. run-dq-checks.ts mirrors stage4's own runner.
      // Was 18:10 IST — shifted with the bhavcopy fix above.
      cron_restart: '40 21 * * 1-5',
      args: 'greenfield/packages/ingestion/src/stage3/run-dq-checks.ts',
    },
    {
      ...gfCron,
      name: 'gf-stage4-dq-daily',
      // 21:50 IST (16:20 UTC) — same gap, one stage over: run-dq-checks.ts existed and
      // called evaluateAllStage4Checks correctly, just never scheduled.
      // Was 18:20 IST — shifted with the bhavcopy fix above.
      cron_restart: '50 21 * * 1-5',
      args: 'greenfield/packages/ingestion/src/stage4/run-dq-checks.ts',
    },
    {
      ...gfCron,
      name: 'gf-ranker-daily',
      // 22:00 IST (16:30 UTC) — after features; shadow period clock ticks here
      // Was 18:30 IST — shifted with the bhavcopy fix above.
      cron_restart: '0 22 * * 1-5',
      args: 'greenfield/packages/ingestion/src/stage5/run-ranker.ts',
    },
    {
      ...gfCron,
      name: 'gf-divergence-daily',
      // 22:15 IST (16:45 UTC) — after ranker; compares shadow recs against legacy
      // unified_recommendations for the same session (descriptive only, per spec).
      // Needs OLD_DATABASE_URL like the weekly transfer jobs below -- reads legacy.
      // Was 18:45 IST — shifted with the bhavcopy fix above.
      cron_restart: '15 22 * * 1-5',
      args: 'greenfield/packages/ingestion/src/stage5/run-divergence-analysis.ts',
      env: {
        ...dotenvVars,
        DATABASE_URL: dotenvVars.GREENFIELD_DATABASE_URL ?? dotenvVars.DATABASE_URL,
        OLD_DATABASE_URL: dotenvVars.DATABASE_URL,
      },
    },
    {
      ...gfCron,
      name: 'gf-kayal-weekly',
      // 07:30 IST Saturday (02:00 UTC) — 1,052 screenpks × ~6s each
      cron_restart: '30 7 * * 6',
      kill_timeout: 7_200_000,  // 2h
      args: 'greenfield/packages/ingestion/src/stage3/transfer-screener-membership.ts',
      env: {
        ...dotenvVars,
        DATABASE_URL: dotenvVars.GREENFIELD_DATABASE_URL ?? dotenvVars.DATABASE_URL,
        // transfer-screener-membership reads legacy screener_appearances for
        // cross-reference; point it at the legacy bharat_intel DB.
        OLD_DATABASE_URL: dotenvVars.DATABASE_URL,
      },
    },
    {
      ...gfCron,
      name: 'gf-fundamentals-weekly',
      // 09:30 IST Saturday (04:00 UTC) — ET Stats + MarketsMojo (~180 symbols)
      cron_restart: '30 9 * * 6',
      kill_timeout: 3_600_000,  // 1h
      args: 'greenfield/packages/ingestion/src/stage3/transfer-fundamentals.ts',
    },
    // Phase 2 — analyst estimates + insider trades (one-shot Saturday morning).
    // Both read legacy bharat_intel DB; ran after fundamentals (09:30 IST)
    // so the connection pool is free.
    {
      ...gfCron,
      name: 'gf-analyst-estimates-weekly',
      // 11:30 IST Saturday (06:00 UTC)
      cron_restart: '30 11 * * 6',
      kill_timeout: 1_800_000,  // 30 min — bulk DB-to-DB copy, no live API calls
      args: 'greenfield/packages/ingestion/src/stage3/transfer-analyst-estimates.ts',
      env: {
        ...dotenvVars,
        DATABASE_URL: dotenvVars.GREENFIELD_DATABASE_URL ?? dotenvVars.DATABASE_URL,
        OLD_DATABASE_URL: dotenvVars.DATABASE_URL,
      },
    },
    {
      ...gfCron,
      name: 'gf-insider-activity-weekly',
      // 12:00 IST Saturday (06:30 UTC)
      cron_restart: '0 12 * * 6',
      kill_timeout: 1_800_000,  // 30 min
      args: 'greenfield/packages/ingestion/src/stage3/transfer-insider-activity.ts',
      env: {
        ...dotenvVars,
        DATABASE_URL: dotenvVars.GREENFIELD_DATABASE_URL ?? dotenvVars.DATABASE_URL,
        OLD_DATABASE_URL: dotenvVars.DATABASE_URL,
      },
    },

    // ------------------------------------------------------------------
    // Postgres logical backup (one-shot nightly)
    // ------------------------------------------------------------------
    // scripts/backup_pg.py existed since P5 hardening but was referenced by NOTHING —
    // not queues.ts, not jobRegistry.ts, not this file — so it had never run on a
    // schedule. An unscheduled backup script is indistinguishable from no backup.
    // It stamps job_heartbeat('pg-backup'), which dataQualityChecks' 'pg-backup-recency'
    // watches, so a silently-failing backup now surfaces the same day rather than on
    // restore day.
    {
      ...gfCron,
      name: 'pg-backup-nightly',
      // 23:15 IST (17:45 UTC) — daily after all rankers, digests, and DQ checks complete.
      cron_restart: '15 23 * * *',
      kill_timeout: 3_600_000,  // 1h — a full -Fc dump of a multi-GB TimescaleDB instance
      interpreter: VENV_PY,
      script: path.resolve(__dirname, 'scripts', 'backup_pg.py'),
      args: '',
      env: { ...dotenvVars, PYTHONUNBUFFERED: '1' },
    },

  ],
};
