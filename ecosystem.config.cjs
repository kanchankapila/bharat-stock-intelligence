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

// Long-running Python services: the same kernel-enforced memory ceiling runPython children get
// (src/server/pyboot/sitecustomize.py puts the interpreter in a Windows Job Object). pm2's own
// max_memory_restart cannot do this here: it watches the PID it launched, and
// venv\Scripts\python.exe is a redirector that spawns the real interpreter -- measured
// 2026-09-11, pm2 reported 1MB per service while the interpreters held 2.0-2.6GB private.
// ml-api can retrain the ensemble in-process, the same shape as the dl_trainer runaway.
const pyService = {
  ...common,
  env: {
    ...common.env,
    PYTHONPATH: [path.resolve(__dirname, 'src', 'server', 'pyboot'), dotenvVars.PYTHONPATH]
      .filter(Boolean).join(path.delimiter),
    // Observe-first, same as runPython children (pythonRunner.ts): bites only on a runaway until
    // measured peaks justify tightening it (AF-20260911-12).
    BHARAT_PY_MEM_LIMIT_MB: '20480',
  },
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
      ...pyService,
      name: 'alphaquant-api',          // FastAPI on :8002 — the service that went silently down
      script: 'main.py',
      cwd: path.resolve(__dirname, 'backend-python'),
      interpreter: isWin
        ? path.resolve(__dirname, 'backend-python', 'venv', 'Scripts', 'python.exe')
        : path.resolve(__dirname, 'backend-python', 'venv', 'bin', 'python'),
    },
    {
      ...pyService,
      name: 'ml-api',
      script: path.resolve(__dirname, 'src', 'server', 'python_api.py'),
      interpreter: VENV_PY,
    },
    {
      ...pyService,
      name: 'chatbot',                 // FastAPI on :8001
      script: path.resolve(__dirname, 'src', 'server', 'chatbot', 'app.py'),
      interpreter: VENV_PY,
    },
    {
      ...pyService,
      name: 'engine-worker',           // FastAPI on :8005 — Ingestion Governor, MCP server & Engine Worker
      script: path.resolve(__dirname, 'src', 'server', 'worker_service.py'),
      interpreter: VENV_PY,
    },


    // ------------------------------------------------------------------
    // Greenfield shadow-ranker pipeline - DEREGISTERED 2026-09-10.
    // ------------------------------------------------------------------
    // The 11 gf-* cron_restart apps that used to sit here were removed from pm2, NOT
    // deleted: greenfield/ still exists in git and nothing about the rebuild was lost.
    // Why: measured 2026-09-10 - nothing in the live app imports greenfield/ (a grep for
    // greenfield imports across src/ + server.ts returns zero), its own database on
    // :5434 refuses connections, and all 11 apps were sitting at 'stopped'. A stopped
    // cron_restart app is indistinguishable from a healthily-idle one (see CLAUDE.md),
    // so registering 11 permanently-stopped apps only made `pm2 list` harder to read
    // and hid that the pipeline had gone dormant. Deregistering makes the config state
    // the truth. To revive: restore this block from git history, bring up the :5434 DB,
    // then `pm2 start ecosystem.config.cjs`.

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
