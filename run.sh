#!/bin/bash
set -e

# Runova dev launcher for macOS (equivalent of run.bat)
cd "$(dirname "$0")"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Install it with: npm install -g pnpm"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  pnpm install || { echo "Failed to install dependencies."; exit 1; }
fi

echo "Verifying Electron binary..."
pnpm --filter @runova/desktop exec install-electron || {
  echo "Failed to download the Electron binary. Check your network connection and try again."
  exit 1
}

echo "Starting Runova..."
pnpm dev
