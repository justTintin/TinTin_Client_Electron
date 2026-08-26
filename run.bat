@echo off
chcp 65001 >nul 2>nul
title TinTin V3 - Launcher
color 0A

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "EXE_PATH=%SCRIPT_DIR%\desktop\dist\win-unpacked\tintin-client-electron.exe"

echo.
echo ============================================================
echo   TinTin V3 - Launching Application
echo ============================================================
echo.

if not exist "%EXE_PATH%" (
  echo [ERROR] Executable not found:
  echo         %EXE_PATH%
  echo.
  echo   Please run 'npm run build:dir:no-native' first to generate the app.
  echo.
  pause
  exit /b 1
)

echo [OK] Found: %EXE_PATH%
echo.
echo   Starting ...
echo.

start "" "%EXE_PATH%"

echo [OK] Application launched. You can close this window.
echo.
timeout /t 3 >nul
exit /b 0
