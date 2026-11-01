@echo off
rem Set a new password for an admin account (keep this file ASCII-only: cmd.exe misreads UTF-8 Thai text)
rem Works while the system is running or stopped. All devices logged in to that account are logged out.
setlocal
title TopUp - Reset admin password
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node
node -e "var v=process.versions.node.split('.');process.exit(v[0]*1000+(+v[1])>=22013?0:1)" >nul 2>nul
if errorlevel 1 goto :old_node
if not exist "node_modules\" goto :no_packages

echo === Reset admin password ===
echo Admin accounts:
node --disable-warning=ExperimentalWarning scripts/admin.js list
echo.

:ask
set "TOPUP_USER="
set "TOPUP_NEW_PASSWORD="
set /p "TOPUP_USER=Admin email or phone (press Enter to quit): "
if not defined TOPUP_USER goto :end
echo Password rules: at least 8 characters, English letters AND numbers, not easy to guess.
set /p "TOPUP_NEW_PASSWORD=New password: "
if not defined TOPUP_NEW_PASSWORD goto :end
rem The password is passed in an environment variable so special characters are kept exactly
node --disable-warning=ExperimentalWarning scripts/admin.js reset-password --user "%TOPUP_USER%"
if errorlevel 1 goto :retry
echo.
echo Done. Log in at the admin page with the new password.
goto :end

:retry
echo.
echo Password NOT changed - see the message above. Try again or press Enter to quit.
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
set "TOPUP_NEW_PASSWORD="
echo.
pause
