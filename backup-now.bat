@echo off
rem Back up the database right now into data\backups (keep this file ASCII-only: cmd.exe misreads UTF-8 Thai text)
rem Safe to run while the system is running. Old backups are removed automatically (see README).
setlocal
title TopUp - Backup now
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node
node -e "var v=process.versions.node.split('.');process.exit(v[0]*1000+(+v[1])>=22013?0:1)" >nul 2>nul
if errorlevel 1 goto :old_node
if not exist "node_modules\" goto :no_packages

echo === Backup now ===
node --disable-warning=ExperimentalWarning scripts/admin.js backup
if errorlevel 1 goto :failed
echo.
echo Done. Copy the backup file to a USB drive or cloud storage too, in case this computer breaks.
rem Open the backups folder so the file is easy to copy (only for the default data folder)
if exist "data\backups\" start "" "data\backups"
goto :end

:failed
echo.
echo [!] Backup failed - see the message above.
goto :end

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
