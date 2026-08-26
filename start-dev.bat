@echo off
chcp 65001 >nul 2>nul
title TinTin V3 - Dev Mode
color 0E

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "ELECTRON_DIR=%SCRIPT_DIR%\desktop"

echo.
echo ============================================================
echo   TinTin V3 - Development Mode
echo ============================================================
echo   Project  : %SCRIPT_DIR%
echo   Electron : %ELECTRON_DIR%
echo   Press Ctrl+C or close this window to stop
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js ^>=18 from https://nodejs.org/
  goto :end
)

for /f "delims=" %%v in ('node -v') do echo [OK] Node.js: %%v
for /f "delims=" %%v in ('npm -v')  do echo [OK] npm:    %%v
echo.

if not exist "%ELECTRON_DIR%\node_modules\" (
  echo [1/3] First run - installing dependencies ...
  pushd "%ELECTRON_DIR%"
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Try:
    echo           1. Delete node_modules and retry
    echo           2. Use mirror: npm config set registry https://registry.npmmirror.com
    popd
    goto :end
  )
  popd
  echo [OK] Dependencies installed.
) else (
  echo [OK] node_modules found - skipping install.
)
echo.

echo [2/3] Cleaning port 5173 ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5173 " ^| findstr LISTENING 2^>nul') do (
  if not "%%p"=="" (
    echo       Terminating PID=%%p ...
    taskkill /PID %%p /F >nul 2>nul
  )
)
ping 127.0.0.1 -n 2 >nul
echo [OK] Port 5173 ready.
echo.

echo [3/3] Launching Vite + Electron ...
echo.
echo       Vite:    http://localhost:5173
echo       Electron: will auto-start after Vite is ready
echo.
echo ------------------------------------------------------------
echo   Running ... (Ctrl+C to stop)
echo ------------------------------------------------------------
echo.

pushd "%ELECTRON_DIR%"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"
popd

echo.
echo ------------------------------------------------------------
echo   Process exited with code: %EXIT_CODE%
echo ------------------------------------------------------------

:end
echo.
pause
