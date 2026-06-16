@echo off
echo ===================================================
echo   Starting Bharat Stock Intelligence Services...
echo ===================================================

echo Starting Redis (BullMQ + Cache broker)...
set REDIS_EXE=%LOCALAPPDATA%\Microsoft\WinGet\Packages\taizod1024.redis-windows-fork_Microsoft.Winget.Source_8wekyb3d8bbwe\Redis-8.8.0-Windows-x64-msys2\redis-server.exe
if exist "%REDIS_EXE%" (
    start "Redis" /min cmd /c "%REDIS_EXE% --loglevel warning"
    timeout /t 1 /nobreak >nul
    echo Redis started.
) else (
    echo WARNING: Redis not found at expected path. BullMQ jobs will not run.
    echo Install with: winget install taizod1024.redis-windows-fork
)

echo Starting Node/Vite Server (Port 3000)...
start "Node + Vite Server" cmd /k "npm run dev"

echo Starting Python Backend API (Port 8000)...
start "Python API" cmd /k "npm run api"

echo Starting ML Python API...
start "ML API" cmd /k "npm run ml-api"

echo Starting Stock AI Chatbot (Port 8001)...
start "Stock AI Chatbot" cmd /k "npm run chatbot"

echo.
echo All services have been launched in separate windows!
echo Close this window at any time.
pause
