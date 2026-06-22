@echo off
echo ===================================================
echo   Starting Bharat Stock Intelligence (PM2 stack)
echo ===================================================

echo.
echo [1/4] Starting Redis (BullMQ + Cache broker)...
set REDIS_EXE=%LOCALAPPDATA%\Microsoft\WinGet\Packages\taizod1024.redis-windows-fork_Microsoft.Winget.Source_8wekyb3d8bbwe\Redis-8.8.0-Windows-x64-msys2\redis-server.exe
if exist "%REDIS_EXE%" (
    start "Redis" /min cmd /c "%REDIS_EXE% --loglevel warning"
    timeout /t 1 /nobreak >nul
    echo       Redis started.
) else (
    echo       WARNING: Redis not found. BullMQ jobs will not run.
    echo       Install with: winget install taizod1024.redis-windows-fork
)

echo.
echo [2/4] Ensuring TimescaleDB ^(Postgres :5433^) container is up...
docker compose up -d timescaledb
if errorlevel 1 (
    echo       WARNING: could not start TimescaleDB. Is Docker Desktop running?
    echo       The stack runs on Postgres ^(USE_POSTGRES=true^); it will not work without it.
)

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
