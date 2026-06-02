@echo off
echo ===================================================
echo   Starting Bharat Stock Intelligence Services...
echo ===================================================

echo Starting Node/Vite Server (Port 3000)...
start "Node + Vite Server" cmd /k "npm run dev"

echo Starting Python Backend API (Port 8000)...
start "Python API" cmd /k "npm run api"

echo Starting ML Python API...
start "ML API" cmd /k "npm run ml-api"

echo.
echo All services have been launched in separate windows!
echo Close this window at any time.
pause
