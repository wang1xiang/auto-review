# Auto-Review

Automated code review workflow: **Gemini reviews MR diffs → Claude Code fixes issues → loop up to N rounds → human makes final merge decision**.

## Architecture

```
┌──────────────┐     webhook      ┌──────────────────┐
│   GitLab     │ ────────────────>│  webhook_server   │
│  (MR opened) │                  │     (Flask)       │
└──────────────┘                  └────────┬─────────┘
                                          │
                                          ▼
                                   ┌──────────────┐
                                   │   runner.py   │
                                   │  (orchestrator)│
                                   └──┬─────────┬──┘
                                      │         │
                    ┌─────────────────┘         └─────────────────┐
                    ▼                                             ▼
            ┌───────────────┐                          ┌──────────────────┐
            │ gitlab_client  │                          │   gemini_review   │
            │  .get_mr_diffs()│                         │   .review(diff)   │
            └───────┬───────┘                          └────────┬─────────┘
                    │                                          │
                    ▼                                          ▼
            [MR diff]                               [ReviewResult]
                                                              │
                                              ┌───────────────┼──────────────┐
                                              ▼               ▼              ▼
                                     post to GitLab     claude_fix.fix   update state
                                     (review comment)   (if not approved)
                                                              │
                                                              ▼
                                                    [git add/commit/push]
                                                              │
                                                              ▼
                                                    GitLab sends MR update webhook
                                                              │
                                                              ▼
                                                    runner processes -> re-review
                                                              │
                                                    (loop until approved or max rounds)
```

## Setup

### 1. Clone and install dependencies

```bash
cd projects/auto-review
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your values:
# - GITLAB_URL: Your GitLab instance URL
# - GITLAB_TOKEN: Private Token with `api` scope
# - GITLAB_PROJECT_ID: Project ID or URL-encoded path (e.g. "group%2Fproject")
# - GEMINI_API_KEY: Google AI Studio API key
# - CLAUDE_WORK_DIR: Path to your local git clone of the project
```

### 3. Test connectivity

```bash
python -m src.runner
```

This will test GitLab connection and process all open MRs.

### 4. Start the webhook listener

```bash
./scripts/start_listener.sh
```

### 5. Configure GitLab webhook

In your GitLab project: **Settings > Webhooks**

- **URL**: `http://<your-machine-ip>:8080/webhook`
- **Trigger**: Check "Merge request events"
- **Secret token**: (leave empty for V1)
- Click "Add webhook"

If your machine is behind NAT, use `ngrok`:
```bash
ngrok http 8080
```
Then set the webhook URL to the ngrok URL.

## Usage

### Manual review (one-shot)

```bash
./scripts/run_review.sh <MR_IID>
```

### Process all open MRs

```bash
python -m src.runner
```

### Start webhook listener

```bash
./scripts/start_listener.sh
```

## Workflow

1. Developer creates an MR (or pushes new commits to an existing MR)
2. GitLab sends a webhook event to our listener
3. **Gemini** reviews the MR diff and posts a summary comment
4. If issues are found (critical/warning severity), **Claude Code** automatically fixes them
5. Claude commits and pushes the fixes, which triggers a new MR update webhook
6. Loop repeats (up to `MAX_REVIEW_ROUNDS`, default 2)
7. Human reviews the final state and decides whether to merge

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GITLAB_URL` | - | GitLab instance URL |
| `GITLAB_TOKEN` | - | Private Token with `api` scope |
| `GITLAB_PROJECT_ID` | - | Project ID or URL-encoded path |
| `GEMINI_API_KEY` | - | Google AI Studio API key |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model for code review |
| `CLAUDE_WORK_DIR` | - | Local git repo path for Claude to fix |
| `MAX_REVIEW_ROUNDS` | `2` | Maximum review-fix cycles |
| `WEBHOOK_PORT` | `8080` | Port for webhook server |
| `LOG_LEVEL` | `INFO` | Logging level |

## V1 Limitations

- Review comments are posted as a single summary note (not inline comments)
- No webhook HMAC verification
- JSON file state storage (not database)
- Processes MRs sequentially
- No Docker support yet

## Project Structure

```
auto-review/
├── src/
│   ├── config.py            # Configuration loader
│   ├── gitlab_client.py     # GitLab API wrapper
│   ├── gemini_review.py     # Gemini review engine
│   ├── claude_fix.py        # Claude Code fix orchestrator
│   ├── runner.py            # Main review-fix loop
│   └── webhook_server.py    # Flask webhook endpoint
├── scripts/
│   ├── run_review.sh        # Manual review trigger
│   └── start_listener.sh    # Start webhook listener
└── tests/fixtures/
    ├── mr_webhook.json      # Sample webhook payload
    └── mr_diff_sample.json  # Sample MR diff
```
