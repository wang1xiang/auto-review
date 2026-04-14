#!/bin/bash
# Manual review: trigger Gemini review for a specific MR
# Usage: ./scripts/run_review.sh <MR_IID>
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

MR_IID="${1:?Usage: $0 <MR_IID>}"

cd "$PROJECT_DIR"

# Set proxy if not already set
if [ -z "$HTTPS_PROXY" ]; then
    export HTTPS_PROXY=http://127.0.0.1:7897
    export HTTP_PROXY=http://127.0.0.1:7897
fi

# Run with tsx (no build needed) or fall back to node dist
if [ -d "node_modules" ] && [ -f "node_modules/.bin/tsx" ]; then
    npx tsx src/index.ts review
else
    node dist/index.js review
fi
