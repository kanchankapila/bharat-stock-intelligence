@echo off
echo ===================================================
echo   Starting Bharat Stock Intelligence (PM2 stack)
echo ===================================================

echo.
echo [1/4] Ensuring Redis ^(Docker bharat_redis :6379^) + TimescaleDB ^(:5433^) are up...
REM Single Redis broker: the Docker container (password-protected, AOF-persisted,
REM restart:unless-stopped). The old winget redis-server.exe was retired -- running both
REM bound 6379 simultaneously (split-brain) and connections landed on either one
REM nondeterministically, which broke BullMQ stalled-job recovery. If a stray native
REM redis-server.exe is still running from a previous launch, stop it so it can't re-bind
REM the port ahead of the container.
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='redis-server.exe'\" | Where-Object { $_.ExecutablePath -notlike '*docker*' } | ForEach-Object { Write-Host ('      Stopping stray native redis-server.exe PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
docker compose up -d redis timescaledb
if errorlevel 1 (
    echo       WARNING: could not start Redis/TimescaleDB containers. Is Docker Desktop running?
    echo       The stack runs on Postgres ^(USE_POSTGRES=true^) + Redis broker; it will not work without them.
)

echo.
echo [2/4] TimescaleDB started with Redis above.

echo.
echo [3/4] Ensuring PM2 is installed...
where pm2 >nul 2>nul
if errorlevel 1 (
    echo       PM2 not found - installing globally...
    call npm i -g pm2
)

echo.
echo [4/4] Starting all services via PM2 ^(auto-restart enabled^)...
REM ecosystem.config.cjs injects .env into every service, so all four share the
REM Postgres engine (no SQLite split-brain). PM2 restarts any service that crashes.
call npm run pm2:start

echo.
echo ===================================================
echo   Stack launched (managed by PM2):
echo     bharat-server    http://localhost:3000
echo     alphaquant-api   http://localhost:8002   (FastAPI - ~30s to bind)
echo     ml-api
echo     chatbot          http://localhost:8001
echo ===================================================
echo.
call pm2 status
echo.
echo   Stop:   npm run pm2:stop
echo   Start on reboot:  pm2 save ^&^& pm2 startup
echo.
echo ===================================================
echo   Streaming live logs (last 50 lines + follow)...
echo   Press Ctrl+C to stop viewing - services keep running under PM2.
echo ===================================================
echo.
call pm2 logs --lines 50
