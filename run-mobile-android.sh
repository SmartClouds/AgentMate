#!/bin/bash
set -e

# Runova Mobile (Android) dev launcher for macOS (equivalent of run-mobile-android.bat)
cd "$(dirname "$0")"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Install it with: npm install -g pnpm"
  exit 1
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found on PATH. Install Android Studio / the Android SDK"
  echo "platform-tools and make sure \$ANDROID_HOME/platform-tools is on PATH."
  echo "e.g. export ANDROID_HOME=\$HOME/Library/Android/sdk"
  echo "     export PATH=\$ANDROID_HOME/platform-tools:\$PATH"
  exit 1
fi

echo "Checking for a connected Android device..."
ADB_OUTPUT=$(adb devices)
# Skip the first "List of devices attached" header line, look for "<serial> device"
FOUND_DEVICE=0
UNAUTHORIZED=""
while IFS= read -r line; do
  serial=$(echo "$line" | awk '{print $1}')
  state=$(echo "$line" | awk '{print $2}')
  if [ "$state" = "device" ]; then
    FOUND_DEVICE=1
  elif [ "$state" = "unauthorized" ]; then
    UNAUTHORIZED="$UNAUTHORIZED $serial"
    echo "Device $serial is connected but unauthorized."
    echo "Unlock the phone and accept the \"Allow USB debugging\" prompt."
  fi
done <<< "$(echo "$ADB_OUTPUT" | tail -n +2)"

if [ "$FOUND_DEVICE" = "0" ]; then
  echo "No authorized Android device found."
  echo "  1. Enable Developer Options: Settings -> About phone -> tap \"Build number\" 7 times."
  echo "  2. Enable USB debugging: Settings -> Developer options -> USB debugging."
  echo "  3. Plug the phone in via USB and accept the debugging prompt (or connect over Wi-Fi with \"adb connect\")."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  pnpm install || { echo "Failed to install dependencies."; exit 1; }
fi

echo "Building @runova/protocol..."
pnpm --filter @runova/protocol build || {
  echo "Failed to build @runova/protocol."
  exit 1
}

echo "Building and installing the Runova Mobile debug APK on your device..."
cd apps/mobile
if [ -d "android" ]; then
  echo "Refreshing the generated Android project so config plugins are applied..."
  npx expo prebuild --platform android --clean || {
    echo "Failed to sync the native Android project."
    exit 1
  }
fi
npx expo run:android --device || {
  echo "Failed to build/run the Android app. See the error above."
  exit 1
}
