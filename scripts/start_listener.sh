#!/bin/bash
# Start the auto-review webhook listener daemon
# Usage: ./scripts/start_listener.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Set proxy if not already set
if [ -z "$HTTPS_PROXY" ]; then
    export HTTPS_PROXY=http://127.0.0.1:7897
    export HTTP_PROXY=http://127.0.0.1:7897
fi

# Run with tsx (no build needed) or fall back to node dist
if [ -d "node_modules" ] && [ -f "node_modules/.bin/tsx" ]; then
    npx tsx src/index.ts listener
else
    node dist/index.js listener
fi
