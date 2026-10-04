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

// bharat_alpha has its OWN venv on purpose. Installing it into backend-python/venv would pull
// numpy/pandas/lightgbm upgrades into the interpreter the four production Python services run
// on, and on Windows pip cannot replace a .pyd a running service holds open (the [WinError 5]
// half-upgrade in bugs-testing-env.md). Separate venv = zero interaction with production.
const BQA_DIR = path.resolve(__dirname, 'bharat_alpha');
const BQA_PY = isWin
  ? path.resolve(BQA_DIR, '.venv', 'Scripts', 'python.exe')
  : path.resolve(BQA_DIR, '.venv', 'bin', 'python');

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
    // No GPU for the long-running services (2026-09-30). ml-api and alphaquant-api import torch
    // at startup, so each held a CUDA context for its whole life -- host commit plus VRAM on the
    // 8GB WDDM card dl_trainer trains on -- with no live GPU caller: pythonApi.trainDL/inferDL
    // have zero call sites; DL train/infer run as runPython subprocesses of bharat-server,
    // whose env this does not touch.
    CUDA_VISIBLE_DEVICES: '-1',
  },
};

// Shared config for one-shot cron jobs (pg-backup-nightly, bqa-daily).
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
const cronApp = {
  autorestart: false,
  exec_mode: 'fork',
  kill_timeout: 600_000,        // 10 min default grace; overridden per-job where needed
  interpreter: 'node',
  script: path.resolve(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  env: {
    ...dotenvVars,
  },
  // Log file names kept as gf-*.log: pg-backup-nightly's history lives there.
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

    // (The 11 greenfield `gf-*` cron_restart apps were deregistered 2026-09-10 and the
    // greenfield/ tree removed 2026-10-03; both are recoverable from git history.)

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
      ...cronApp,
      name: 'pg-backup-nightly',
      // 23:15 IST (17:45 UTC) — daily after all rankers, digests, and DQ checks complete.
      cron_restart: '15 23 * * *',
      kill_timeout: 3_600_000,  // 1h — a full -Fc dump of a multi-GB TimescaleDB instance
      interpreter: VENV_PY,
      script: path.resolve(__dirname, 'scripts', 'backup_pg.py'),
      args: '',
      env: {
        ...dotenvVars,
        PYTHONUNBUFFERED: '1',
        // Was the one Python app with no ceiling -- invisible while the guard test used a
        // hand-kept list of four service names (found 2026-09-29 when that list was replaced
        // by an interpreter-derived one). A -Fc dump is subprocess-bound and memory-light, so
        // this is a backstop rather than a bound anyone expects to bite; sitecustomize fails
        // open, so it cannot stop a backup from running.
        PYTHONPATH: [path.resolve(__dirname, 'src', 'server', 'pyboot'), dotenvVars.PYTHONPATH]
          .filter(Boolean).join(path.delimiter),
        BHARAT_PY_MEM_LIMIT_MB: '4096',
      },
    },

    // bharat_alpha's daily cycle: ingest -> features -> inference -> publish -> self-grade.
    //
    // 06:00 IST, chosen from measured occupancy over 21 days of job_run_history rather than a
    // guess. Overlap-aware concurrency (a 210-min job started at 01:05 is still resident at
    // 04:00, which run-COUNTS hide) bottoms out overnight, and the heavy jobs bound the gap:
    // screener-performance 22:48->01:58, ml-daily-ops 01:05->04:35 (210 min), dl-trainer
    // make-ups 02:45/05:09 up to 195 min, then the pre-market chain from 07:30. That leaves
    // 04:35-07:30, and hour 06 has the SHORTEST maximum resident job of any hour (4.9 min),
    // so nothing long normally lives there. Market opens 09:15.
    //
    // It reads the previous session: features enforce a 19:00 IST knowability cutoff, so a
    // 06:00 run publishes for the session about to open, with ~3h of slack.
    //
    // ⚠ kill_timeout is 3h and is NOT a measured steady-state budget. The only full run so far
    // (2026-09-29) took >3.5h, but that was a COLD START: investsights_estimates 94 min and
    // investsights_fundamentals 83 min were backfilling full history (33,836 + 36,617 rows).
    // Those are now loaded, so incremental runs should be far shorter. CHECK THE FIRST
    // SCHEDULED RUN's duration and re-cut this budget against it -- a budget with no headroom
    // over its real runtime is AF-20260929-04's exact failure (killed at the cap, reported as
    // a slow job).
    {
      ...cronApp,
      name: 'bqa-daily',
      cron_restart: '0 6 * * *',
      kill_timeout: 10_800_000,          // 3h; see the warning above before trusting it
      interpreter: BQA_PY,
      script: path.resolve(BQA_DIR, 'src', 'bharat_alpha', 'cli.py'),
      args: 'daily',
      cwd: BQA_DIR,
      env: {
        ...dotenvVars,
        PYTHONUNBUFFERED: '1',
        // Explicit rather than relying on bharat_alpha/.env, which is gitignored: the schedule
        // must be reproducible from this file alone. Same instance, its own database, so
        // nothing it does can touch bharat_intel.
        BQA_DATABASE_URL: (dotenvVars.POSTGRES_URL || '').replace(/\/bharat_intel(\?|$)/, '/bharat_alpha$1'),
        // Same kernel-enforced ceiling as every other Python process here, and for the same
        // measured reason: pm2's max_memory_restart watches the redirector, not the real
        // interpreter (1MB reported vs 2.0-2.6GB held, 2026-09-11). This job does a full
        // feature build over 3.4M bars plus LightGBM inference, which is exactly the shape
        // that put dl_trainer at 38-52.7GB of commit on a 24GB host. sitecustomize is stdlib +
        // ctypes and fails open, so it works from bharat_alpha's own venv unchanged.
        PYTHONPATH: [path.resolve(__dirname, 'src', 'server', 'pyboot'), dotenvVars.PYTHONPATH]
          .filter(Boolean).join(path.delimiter),
        BHARAT_PY_MEM_LIMIT_MB: '8192',   // observe-first; re-cut once a scheduled run's peak is known
      },
      out_file: path.resolve(__dirname, 'logs', 'bqa-daily-out.log'),
      error_file: path.resolve(__dirname, 'logs', 'bqa-daily-err.log'),
    },

  ],
};
