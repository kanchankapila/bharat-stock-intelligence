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
  ? path.join('backend-python', 'venv', 'Scripts', 'python.exe')
  : path.join('backend-python', 'venv', 'bin', 'python');

// Inject .env into EVERY service. The Node app loads dotenv itself, but the three Python
// services (AlphaQuant, ml-api, chatbot) only see what we hand them — without USE_POSTGRES
// they default to SQLite and write/read the abandoned database.sqlite while the app is on
// Postgres (the split-brain incident). Parsing .env here keeps all four on one DB engine.
let dotenvVars = {};
try {
  dotenvVars = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '.env')));
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
  out_file: 'logs/pm2-out.log',
  error_file: 'logs/pm2-err.log',
  merge_logs: true,
  time: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'bharat-server',
      script: path.join('node_modules', 'tsx', 'dist', 'cli.mjs'),
      args: 'server.ts',
      interpreter: 'node',
      node_args: '--max-old-space-size=4096',
    },
    {
      ...common,
      name: 'alphaquant-api',          // FastAPI on :8002 — the service that went silently down
      script: 'main.py',
      cwd: 'backend-python',
      interpreter: isWin
        ? path.join('venv', 'Scripts', 'python.exe')
        : path.join('venv', 'bin', 'python'),
    },
    {
      ...common,
      name: 'ml-api',
      script: path.join('src', 'server', 'python_api.py'),
      interpreter: VENV_PY,
    },
    {
      ...common,
      name: 'chatbot',                 // FastAPI on :8001
      script: path.join('src', 'server', 'chatbot', 'app.py'),
      interpreter: VENV_PY,
    },
  ],
};
