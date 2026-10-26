@echo off
setlocal

cd /d "%~dp0"

where pnpm >nul 2>&1
if errorlevel 1 (
    echo pnpm not found. Install it with: npm install -g pnpm
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing dependencies...
    call pnpm install
    if errorlevel 1 (
        echo Failed to install dependencies.
        pause
        exit /b 1
    )
)

echo Verifying Electron binary...
call pnpm --filter @runova/desktop exec install-electron
if errorlevel 1 (
    echo Failed to download the Electron binary. Check your network connection and try again.
    pause
    exit /b 1
)

echo Starting Runova...
call pnpm dev

pause
