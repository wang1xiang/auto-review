# Auto-Review

Automated code review workflow: **Gemini reviews MR diffs → Claude Code fixes issues → loop up to N rounds → human makes final merge decision**.

## Architecture

```
┌──────────────┐     webhook      ┌──────────────────┐
│   GitLab     │ ────────────────>│  webhook-server    │
│  (MR opened) │                  │     (Express)      │
└──────────────┘                  └────────┬─────────┘
                                          │
                                          ▼
                                   ┌──────────────┐
                                   │   runner.ts   │
                                   │  (orchestrator)│
                                   └──┬─────────┬──┘
                                      │         │
                    ┌─────────────────┘         └─────────────────┐
                    ▼                                             ▼
            ┌───────────────┐                          ┌──────────────────┐
            │ gitlab-client  │                          │   gemini-review   │
            │  .getMrDiffText()│                        │   .reviewDiff()   │
            └───────┬───────┘                          └────────┬─────────┘
                    │                                          │
                    ▼                                          ▼
            [MR diff]                               [ReviewResult]
                                                              │
                                              ┌───────────────┼──────────────┐
                                              ▼               ▼              ▼
                                     post to GitLab     claude-fix.fix   update state
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
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your values:
# - GITLAB_URL: Your GitLab instance URL
# - GITLAB_TOKEN: Private Token with `api` scope
# - GITLAB_PROJECT_ID: Project ID or URL-encoded path (e.g. "937")
# - GEMINI_API_KEY: Google AI Studio API key
# - GEMINI_MODEL: Model for code review (default: gemini-2.5-flash-lite)
# - CLAUDE_WORK_DIR: Path to your local git clone of the project
# - HTTPS_PROXY: Proxy URL if behind a firewall (e.g. http://127.0.0.1:7897)
```

### 3. Build

```bash
npm run build
```

Or use tsx for development without building:

```bash
npm run dev review
npm run dev listener
```

### 4. Test connectivity

```bash
npm run review
```

This will test GitLab connection and process all open MRs.

### 5. Start the webhook listener

```bash
npm run start:listener
```

### 6. Configure GitLab webhook

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

### Manual review (process all open MRs)

```bash
npm run review
```

### Start webhook listener

```bash
npm run start:listener
```

### Development mode (no build needed)

```bash
npm run dev           # same as review
npm run dev review    # review mode
npm run dev listener  # listener mode
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
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | Model for code review |
| `CLAUDE_WORK_DIR` | - | Local git repo path for Claude to fix |
| `MAX_REVIEW_ROUNDS` | `2` | Maximum review-fix cycles |
| `WEBHOOK_PORT` | `8080` | Port for webhook server |
| `HTTPS_PROXY` | - | Proxy URL (required if behind firewall) |
| `HTTP_PROXY` | - | Proxy URL (required if behind firewall) |
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
│   ├── config.ts            # Configuration loader (Zod)
│   ├── gitlab-client.ts     # GitLab API wrapper
│   ├── gemini-review.ts     # Gemini review engine
│   ├── claude-fix.ts        # Claude Code fix orchestrator
│   ├── runner.ts            # Main review-fix loop
│   ├── webhook-server.ts    # Express webhook endpoint
│   └── index.ts             # CLI entry point
├── scripts/
│   ├── run_review.sh        # Manual review trigger
│   └── start_listener.sh    # Start webhook listener
└── .env                     # Configuration (not committed)
```

## Tech Stack

- **Runtime**: Node.js 18+
- **Language**: TypeScript
- **Webhook Server**: Express
- **GitLab API**: Custom client with https-proxy-agent support
- **Gemini API**: Direct HTTPS POST with structured JSON output
- **Claude Code**: `claude -p` non-interactive mode with `--permission-mode acceptEdits`
