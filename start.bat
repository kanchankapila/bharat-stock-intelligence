@echo off
echo ===================================================
echo   Starting Bharat Stock Intelligence (PM2 stack)
echo ===================================================

echo.
echo [1/5] Ensuring Redis ^(Docker bharat_redis :6379^) + TimescaleDB ^(:5433^) containers are up...
REM Single Redis broker: the Docker container (password-protected, AOF-persisted, restart:unless-stopped).
REM Stop stray native redis-server.exe to avoid split-brain port binding on 6379.
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='redis-server.exe'\" | Where-Object { $_.ExecutablePath -notlike '*docker*' } | ForEach-Object { Write-Host ('      Stopping stray native redis-server.exe PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
docker compose up -d redis timescaledb
if errorlevel 1 (
    echo       WARNING: could not start Redis/TimescaleDB containers. Is Docker Desktop running?
    echo       The stack runs on Postgres ^(USE_POSTGRES=true^) + Redis broker; it will not work without them.
)

echo.
echo [2/5] Waiting for Redis ^(:6379^) and TimescaleDB ^(:5433^) to accept TCP connections...
REM Prevents "Registered != running" bug: cron_restart jobs fail their first launch if PM2 boots before containers accept connections.
node -e "const net = require('net'); function check(port) { return new Promise(res => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); }); } (async () => { for (let i = 0; i < 30; i++) { const r = await check(6379), p = await check(5433); if (r && p) { console.log('      Containers ready (Redis:6379, Postgres:5433)'); process.exit(0); } await new Promise(r => setTimeout(r, 1000)); } console.warn('      WARNING: Timeout waiting for Redis/Postgres'); })();"

echo.
echo [3/5] Cleaning orphan processes and validating port assignments...
node scripts/check_port_drift.mjs

echo.
echo [4/5] Ensuring PM2 is installed...
where pm2 >nul 2>nul
if errorlevel 1 (
    echo       PM2 not found - installing globally...
    call npm i -g pm2
)

echo.
echo [5/5] Starting/Reloading all services via PM2 ^(idempotent startOrReload^)...
REM ecosystem.config.cjs injects .env into every service, so all four share the Postgres engine.
REM pm2 startOrReload ensures clean startup without creating duplicate process IDs.
call npx pm2 startOrReload ecosystem.config.cjs
call npx pm2 save >nul 2>&1

echo.
node scripts/check_deploy_drift.mjs

echo.
echo ===================================================
echo   Stack launched (managed by PM2):
echo     bharat-server    http://localhost:3000
echo     alphaquant-api   http://localhost:8002   (FastAPI)
echo     ml-api           http://localhost:8000   (FastAPI)
echo     chatbot          http://localhost:8001   (FastAPI)
echo ===================================================
echo.
call npx pm2 status
echo.
echo   Stop:             npm run pm2:stop
echo   Start on reboot:  pm2 save ^&^& pm2 startup
echo.
echo ===================================================
echo   Streaming live logs (last 50 lines + follow)...
echo   Press Ctrl+C to stop viewing - services keep running under PM2.
echo ===================================================
echo.
call npx pm2 logs --lines 50

