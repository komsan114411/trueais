@echo off
rem TopUp system launcher (keep this file ASCII-only: cmd.exe misreads UTF-8 Thai text in .bat files)
title TopUp System
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node
rem Node.js 22.13 or newer is required (built-in SQLite database)
node -e "var v=process.versions.node.split('.');process.exit(v[0]*1000+(+v[1])>=22013?0:1)" >nul 2>nul
if errorlevel 1 goto :old_node

if not exist "node_modules\" (
  echo Installing packages for the first time...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo [!] Package install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created .env from .env.example - you can edit it later.
)

rem Read PORT the same way the system does (comments and quotes in .env are handled)
set "TOPUP_PORT="
for /f "usebackq delims=" %%p in (`node -p "require('./src/config').port" 2^>nul`) do set "TOPUP_PORT=%%p"

echo.
if defined TOPUP_PORT (
  echo Starting... Website: http://localhost:%TOPUP_PORT%   Admin: http://localhost:%TOPUP_PORT%/admin
) else (
  echo Starting... Open the website address shown below when the system is ready.
)
echo Press Ctrl+C to stop.
echo.
rem Same as "npm start", run directly so errors are not buried under npm messages
node --disable-warning=ExperimentalWarning src/server.js
echo.
echo The system has stopped. If there is an error message above, fix it and run start.bat again.
pause
exit /b 0

:no_node
echo [!] Node.js not found. Please install Node.js 22.13 or newer (LTS) from https://nodejs.org/ then run this file again.
pause
exit /b 1

:old_node
echo [!] Your Node.js version is too old:
node -v
echo     This system needs Node.js 22.13 or newer. Install the LTS version from https://nodejs.org/ then run this file again.
pause
exit /b 1
