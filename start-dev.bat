@echo off
REM ========================================================================
REM  TinTin V3 Electron - One-Click Dev Starter (ASCII-safe for all Windows locales)
REM  Double-click this file to launch: Vite (frontend HMR) + Electron (desktop shell)
REM  Place: project root (next to ./electron/package.json)
REM ========================================================================

SETLOCAL EnableExtensions
TITLE TinTin V3 - Dev Mode

REM ---- Resolve paths relative to script location (avoids wrong CWD when double-clicked)
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "ELECTRON_DIR=%SCRIPT_DIR%\electron"

echo.
echo ============================================================
echo   TinTin V3 - Development Mode Launcher
echo ============================================================
echo   Project  : %SCRIPT_DIR%
echo   Electron : %ELECTRON_DIR%
echo ============================================================
echo.

REM ---- 1. Check Node.js / npm ------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo         Install Node.js ^>=18 from https://nodejs.org/
  echo.
  PAUSE
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found in PATH (should ship with Node.js installer).
  echo.
  PAUSE
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v
for /f "delims=" %%v in ('npm -v')  do echo [OK] npm %%v
echo.

REM ---- 2. Install dependencies on first run ----------------------------------
if NOT EXIST "%ELECTRON_DIR%\node_modules\" (
  echo [1/4] First run detected - running npm install ...
  echo       (CN users: recommend mirror for faster download)
  echo         npm config set registry https://registry.npmmirror.com
  echo         set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  echo.
  pushd "%ELECTRON_DIR%"
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    echo         Hints:
    echo           - Delete electron\node_modules and electron\package-lock.json, then retry.
    echo           - Set mirror (see above) if download is too slow or times out.
    echo           - For Electron package install failure specifically:
    echo               cd electron
    echo               rmdir /s /q node_modules\electron
    echo               set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    echo               npm install electron --save-dev
    popd
    echo.
    PAUSE
    exit /b 1
  )
  popd
  echo [OK] Dependencies installed.
  echo.
) else (
  echo [OK] node_modules present - skipping install.
  echo.
)

REM ---- 3. Free port 5173 (clean up orphaned Vite dev servers) -----------------
echo [2/4] Checking port 5173 ...
set "PORT_KILLED=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5173 " ^| findstr LISTENING') do (
  if NOT "%%p"=="" (
    echo       -> Found occupying PID=%%p, terminating.
    taskkill /PID %%p /F >nul 2>nul
    set "PORT_KILLED=1"
  )
)
if %PORT_KILLED%==0 (echo       Port free.) else (echo       Cleaned up.)
REM small cooldown to let socket fully close
ping 127.0.0.1 -n 2 >nul
echo.

REM ---- 4. Launch Vite + Electron via concurrently -----------------------------
echo [3/4] Starting Vite (http://localhost:5173) + Electron shell ...
echo.
echo ------------------------------------------------------------
echo   Run logs:
echo     - Vite    : http://localhost:5173   (hot module reload)
echo     - wait-on : waits for Vite READY, then launches Electron
echo     - Electron: NODE_ENV=development, loads http://localhost:5173
echo   Stop: close this console window or press Ctrl+C
echo ------------------------------------------------------------
echo.

pushd "%ELECTRON_DIR%"
REM Prefer CN mirror in case of late electron-builder asset downloads
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"
popd

echo.
echo [4/4] Process exited (code=%EXIT_CODE%).
if NOT %EXIT_CODE%==0 (
  echo.
  echo [WARN] Common failure fixes:
  echo          - Port 5173 still occupied? Run this script again (it auto-cleans).
  echo          - Electron package corrupt (see top of script for reinstall steps).
  echo          - Vite HMR websocket error: close browser tabs on :5173 and retry.
)
echo.
PAUSE
ENDLOCAL
exit /b %EXIT_CODE%
