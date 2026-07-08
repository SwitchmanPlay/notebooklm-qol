#!/usr/bin/env bash
# Build the extension into ./dist (bundled JS) + static files.
set -euo pipefail
cd "$(dirname "$0")"
BIN=${ESBUILD:-esbuild}

mkdir -p dist

"$BIN" src/content/index.ts --bundle --format=iife --target=chrome120 --outfile=dist/content.js --log-level=warning
"$BIN" src/background.ts    --bundle --format=iife --target=chrome120 --outfile=dist/background.js --log-level=warning
"$BIN" src/popup.ts         --bundle --format=iife --target=chrome120 --outfile=dist/popup.js --log-level=warning
cp src/content/content.css dist/content.css

echo "Build OK -> dist/"
