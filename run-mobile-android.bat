@echo off
setlocal

cd /d "%~dp0"

where pnpm >nul 2>&1
if errorlevel 1 (
    echo pnpm not found. Install it with: npm install -g pnpm
    pause
    exit /b 1
)

where adb >nul 2>&1
if errorlevel 1 (
    echo adb not found on PATH. Install Android Studio / the Android SDK
    echo platform-tools and make sure ANDROID_HOME\platform-tools is on PATH.
    pause
    exit /b 1
)

echo Checking for a connected Android device...
set FOUND_DEVICE=0
for /f "skip=1 tokens=1,2" %%A in ('adb devices') do (
    if "%%B"=="device" set FOUND_DEVICE=1
    if "%%B"=="unauthorized" (
        echo Device %%A is connected but unauthorized.
        echo Unlock the phone and accept the "Allow USB debugging" prompt.
    )
)
if "%FOUND_DEVICE%"=="0" (
    echo No authorized Android device found.
    echo   1. Enable Developer Options: Settings - About phone - tap "Build number" 7 times.
    echo   2. Enable USB debugging: Settings - Developer options - USB debugging.
    echo   3. Plug the phone in via USB and accept the debugging prompt ^(or connect over Wi-Fi with "adb connect"^).
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

echo Building @runova/protocol...
call pnpm --filter @runova/protocol build
if errorlevel 1 (
    echo Failed to build @runova/protocol.
    pause
    exit /b 1
)

echo Building and installing the Runova Mobile debug APK on your device...
cd apps\mobile
if exist "android" (
    echo Refreshing the generated Android project so config plugins are applied...
    call npx expo prebuild --platform android --clean
    if errorlevel 1 (
        echo Failed to sync the native Android project.
        pause
        exit /b 1
    )
)
call npx expo run:android --device
if errorlevel 1 (
    echo Failed to build/run the Android app. See the error above.
    pause
    exit /b 1
)

pause
