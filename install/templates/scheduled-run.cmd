@echo off
rem Activity Sync — scheduled run wrapper
rem Path-portable: uses %USERPROFILE% and reads REPO_PATH from env file
setlocal

set STATE_DIR=%USERPROFILE%\.activity-sync
set LOG=%STATE_DIR%\scheduled-run.log
set ENV_FILE=%STATE_DIR%\config.env

rem Load REPO_PATH and VPN_NAME from %STATE_DIR%\config.env (KEY=VALUE format)
if exist "%ENV_FILE%" (
  for /f "usebackq tokens=1,2 delims==" %%a in ("%ENV_FILE%") do (
    if /i "%%a"=="REPO_PATH" set REPO_PATH=%%b
    if /i "%%a"=="VPN_NAME" set VPN_NAME=%%b
    if /i "%%a"=="NODE_EXE" set NODE_EXE=%%b
  )
)
if not defined REPO_PATH (
  echo [error] REPO_PATH not set. Run install\setup.ps1 first. >> "%LOG%"
  exit /b 2
)
if not defined VPN_NAME set VPN_NAME=MSFT-AzVPN-Manual
if not defined NODE_EXE set NODE_EXE=node

echo ===== Activity Sync Run: %date% %time% ===== >> "%LOG%"
cd /d "%REPO_PATH%"

rem --- Auto-connect Azure VPN (cert auth, no MFA) ---
set VPN_DIALED=0
powershell -NoProfile -Command "(Get-VpnConnection '%VPN_NAME%').ConnectionStatus" 2>nul | findstr /C:"Connected" >nul
if errorlevel 1 (
  echo [vpn] Dialing %VPN_NAME%... >> "%LOG%"
  rasdial "%VPN_NAME%" >> "%LOG%" 2>&1
  if not errorlevel 1 set VPN_DIALED=1
) else (
  echo [vpn] Already connected >> "%LOG%"
)

rem --- Run sync ---
set REPO_PATH=%REPO_PATH%
"%NODE_EXE%" "%STATE_DIR%\catchup.js" >> "%LOG%" 2>&1
set SYNC_EXIT=%errorlevel%

rem --- Publish summary to reports-repo (best effort) ---
if exist "%STATE_DIR%\reports-repo\.git" (
  echo [publish] Pushing summary to reports-repo... >> "%LOG%"
  "%NODE_EXE%" "%REPO_PATH%\tools\post-run-summary.js" >> "%LOG%" 2>&1
)

rem --- Notify if action required (best effort, never fails the run) ---
if exist "%REPO_PATH%\tools\notify.ps1" (
  echo [notify] Checking for action items... >> "%LOG%"
  powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO_PATH%\tools\notify.ps1" -ReportsDir "%REPO_PATH%\reports" >> "%LOG%" 2>&1
)

rem --- Disconnect VPN only if we dialed it ---
if %VPN_DIALED%==1 (
  echo [vpn] Disconnecting %VPN_NAME%... >> "%LOG%"
  rasdial "%VPN_NAME%" /disconnect >> "%LOG%" 2>&1
)

echo Exit code: %SYNC_EXIT% >> "%LOG%"
echo. >> "%LOG%"
exit /b %SYNC_EXIT%
