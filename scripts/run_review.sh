#!/bin/bash
# Manual review: trigger Gemini review for a specific MR
# Usage: ./scripts/run_review.sh <MR_IID>
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

MR_IID="${1:?Usage: $0 <MR_IID>}"

cd "$PROJECT_DIR"

# Use venv python if available, otherwise fall back to python3
if [ -f ".venv/bin/python" ]; then
    PYTHON=".venv/bin/python"
else
    PYTHON="python3"
fi

# Set proxy if not already set
if [ -z "$HTTPS_PROXY" ]; then
    export HTTPS_PROXY=http://127.0.0.1:7897
    export HTTP_PROXY=http://127.0.0.1:7897
fi

$PYTHON -c "
import logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')

from src.config import load_config
from src.gitlab_client import GitLabClient
from src.gemini_review import review_diff, format_review_summary

config = load_config()
client = GitLabClient(config.gitlab_url, config.gitlab_token, config.gitlab_project_id)

print(f'Reviewing MR !${MR_IID}...')
diff_text = client.get_mr_diff_text(${MR_IID})
if not diff_text.strip():
    print('No diffs found.')
    exit(0)

review = review_diff(diff_text, config.gemini_api_key, config.gemini_model)
print(format_review_summary(review))
print()
print(f'Verdict: {review.overall_verdict}')
print(f'Issues found: {len(review.comments)}')
"
