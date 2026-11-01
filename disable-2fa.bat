@echo off
rem Turn off two-step login (2FA) for an admin who lost the phone with the authenticator app
rem (keep this file ASCII-only: cmd.exe misreads UTF-8 Thai text). Works while the system is running or stopped.
setlocal
title TopUp - Turn off two-step login (2FA)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node
node -e "var v=process.versions.node.split('.');process.exit(v[0]*1000+(+v[1])>=22013?0:1)" >nul 2>nul
if errorlevel 1 goto :old_node
if not exist "node_modules\" goto :no_packages

echo === Turn off two-step login (2FA) ===
echo Use this only when the phone with the 6-digit code app is lost.
echo Admin accounts:
node --disable-warning=ExperimentalWarning scripts/admin.js list
echo.

:ask
set "TOPUP_USER="
set /p "TOPUP_USER=Admin email or phone (press Enter to quit): "
if not defined TOPUP_USER goto :end
node --disable-warning=ExperimentalWarning scripts/admin.js disable-2fa --user "%TOPUP_USER%"
if errorlevel 1 goto :retry
echo.
echo Done. Log in with the password only, then turn two-step login on again in the admin page.
goto :end

:retry
echo.
echo Nothing changed - see the message above. Try again or press Enter to quit.
echo.
goto :ask

:no_node
echo [!] Node.js not found. Install Node.js 22.13 or newer from https://nodejs.org/ first.
goto :end

:old_node
echo [!] Your Node.js is too old. Install Node.js 22.13 or newer from https://nodejs.org/ first.
goto :end

:no_packages
echo [!] Packages are not installed yet. Run start.bat once first, then try again.
goto :end

:end
echo.
pause
