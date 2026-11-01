@echo off
rem TopUp system launcher (keep this file ASCII-only: cmd.exe misreads UTF-8 Thai text in .bat files)
title TopUp System
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js not found. Please install Node.js 22.13 or newer from https://nodejs.org then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules" (
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

echo.
echo Starting... Website: http://localhost:3000   Admin: http://localhost:3000/admin
echo Press Ctrl+C to stop.
echo.
call npm start
pause
