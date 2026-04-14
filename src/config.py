"""Configuration loader for auto-review."""

import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel, Field


class Config(BaseModel):
    gitlab_url: str = Field(..., description="GitLab instance URL")
    gitlab_token: str = Field(..., description="GitLab Private Token with api scope")
    gitlab_project_id: str = Field(..., description="GitLab project ID or URL-encoded path")
    gemini_api_key: str = Field(..., description="Google AI Studio API key")
    gemini_model: str = Field(default="gemini-2.5-flash", description="Gemini model for review")
    claude_work_dir: str = Field(..., description="Local git repo path for Claude Code to fix")
    max_review_rounds: int = Field(default=2, description="Maximum review-fix rounds")
    webhook_port: int = Field(default=8080, description="Webhook server port")
    log_level: str = Field(default="INFO", description="Log level")

    @property
    def api_base(self) -> str:
        return self.gitlab_url.rstrip("/") + "/api/v4"


def load_config(env_path: str | None = None) -> Config:
    if env_path:
        load_dotenv(env_path)
    else:
        load_dotenv()

    required = ["GITLAB_URL", "GITLAB_TOKEN", "GITLAB_PROJECT_ID", "GEMINI_API_KEY", "CLAUDE_WORK_DIR"]
    missing = [k for k in required if not os.getenv(k)]
    if missing:
        raise ValueError(f"Missing required env vars: {', '.join(missing)}. Copy .env.example to .env and fill them in.")

    return Config(
        gitlab_url=os.environ["GITLAB_URL"],
        gitlab_token=os.environ["GITLAB_TOKEN"],
        gitlab_project_id=os.environ["GITLAB_PROJECT_ID"],
        gemini_api_key=os.environ["GEMINI_API_KEY"],
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        claude_work_dir=os.environ["CLAUDE_WORK_DIR"],
        max_review_rounds=int(os.getenv("MAX_REVIEW_ROUNDS", "2")),
        webhook_port=int(os.getenv("WEBHOOK_PORT", "8080")),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
    )
