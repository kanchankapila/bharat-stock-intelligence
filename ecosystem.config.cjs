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

// Inject .env into EVERY service. The Node app loads dotenv itself, but the three Python
// services (AlphaQuant, ml-api, chatbot) only see what we hand them — without USE_POSTGRES
// they default to SQLite and write/read the abandoned database.sqlite while the app is on
// Postgres (the split-brain incident). Parsing .env here keeps all four on one DB engine.
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
// without pm2 restarting it immediately.  All cron times are UTC -- IST = UTC+5:30.
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

    // ------------------------------------------------------------------
    // Greenfield shadow-ranker pipeline (one-shot cron jobs, UTC times)
    // Chain: bhavcopy → fii-dii → features → ranker (daily, weekdays)
    //        kayal screeners (weekly, Sunday) | fundamentals (weekly, Saturday)
    // ------------------------------------------------------------------

    {
      ...gfCron,
      name: 'gf-bhavcopy-daily',
      // 10:30 UTC = 16:00 IST — NSE bhavcopy published by ~15:30 IST
      cron_restart: '30 10 * * 1-5',
      args: 'greenfield/packages/ingestion/src/nse/run-daily-bhavcopy.ts',
    },
    {
      ...gfCron,
      name: 'gf-fii-dii-daily',
      // 12:00 UTC = 17:30 IST — NSE publishes FII/DII after market close
      cron_restart: '0 12 * * 1-5',
      args: 'greenfield/packages/ingestion/src/stage3/run-daily-fii-dii.ts',
    },
    {
      ...gfCron,
      name: 'gf-features-daily',
      // 12:30 UTC = 18:00 IST — after bhavcopy + FII/DII land
      cron_restart: '30 12 * * 1-5',
      args: 'greenfield/packages/ingestion/src/stage4/run-compute-features.ts',
    },
    {
      ...gfCron,
      name: 'gf-ranker-daily',
      // 13:00 UTC = 18:30 IST — after features; shadow period clock ticks here
      cron_restart: '0 13 * * 1-5',
      args: 'greenfield/packages/ingestion/src/stage5/run-ranker.ts',
    },
    {
      ...gfCron,
      name: 'gf-kayal-weekly',
      // 02:00 UTC Sunday = 07:30 IST Sunday — 1,052 screenpks × ~6s each
      cron_restart: '0 2 * * 0',
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
      // 04:00 UTC Saturday = 09:30 IST Saturday — ET Stats + MarketsMojo (~180 symbols)
      cron_restart: '0 4 * * 6',
      kill_timeout: 3_600_000,  // 1h
      args: 'greenfield/packages/ingestion/src/stage3/transfer-fundamentals.ts',
    },
    // Phase 2 — analyst estimates + insider trades (one-shot Saturday morning).
    // Both read legacy bharat_intel DB; ran after fundamentals (04:00 UTC)
    // so the connection pool is free.
    {
      ...gfCron,
      name: 'gf-analyst-estimates-weekly',
      // 06:00 UTC Saturday = 11:30 IST Saturday
      cron_restart: '0 6 * * 6',
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
      // 06:30 UTC Saturday = 12:00 IST Saturday
      cron_restart: '30 6 * * 6',
      kill_timeout: 1_800_000,  // 30 min
      args: 'greenfield/packages/ingestion/src/stage3/transfer-insider-activity.ts',
      env: {
        ...dotenvVars,
        DATABASE_URL: dotenvVars.GREENFIELD_DATABASE_URL ?? dotenvVars.DATABASE_URL,
        OLD_DATABASE_URL: dotenvVars.DATABASE_URL,
      },
    },
  ],
};
