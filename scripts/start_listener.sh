#!/bin/bash
# Start the auto-review webhook listener daemon
# Usage: ./scripts/start_listener.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

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

exec $PYTHON -c "
import logging
import threading
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')

from src.config import load_config
from src.gitlab_client import GitLabClient
from src.runner import run_review_fix_cycle, StateManager
from src.webhook_server import start_webhook_server

config = load_config()
client = GitLabClient(config.gitlab_url, config.gitlab_token, config.gitlab_project_id)
state = StateManager()

if not client.test_connection():
    raise RuntimeError('Cannot connect to GitLab')

def on_mr_event(mr_iid, action):
    '''Callback when MR is opened or updated.'''
    print(f'Triggering review for MR !{mr_iid} (action: {action})')
    try:
        run_review_fix_cycle(client, config, mr_iid, state)
    except Exception as e:
        print(f'Error processing MR !{mr_iid}: {e}')

print(f'Starting auto-review listener on port {config.webhook_port}...')
print(f'GitLab: {config.gitlab_url}/{config.gitlab_project_id}')
print(f'Max rounds: {config.max_review_rounds}')
print()
print('Configure your GitLab webhook to point to:')
print(f'  http://<your-ip>:{config.webhook_port}/webhook')
print('Events: Merge request events (open, update, reopen)')
print()

start_webhook_server(config.webhook_port, config, client, state, on_mr_event)
"
