"""Claude Code fix orchestrator for auto-review workflow."""

import json
import logging
import subprocess
from dataclasses import dataclass

from .gemini_review import ReviewResult, format_fix_prompt

logger = logging.getLogger(__name__)


@dataclass
class FixResult:
    success: bool
    changed: bool  # Were files actually modified?
    error: str = ""


def get_modified_files(work_dir: str) -> set[str]:
    """Get set of modified files in the working directory."""
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only"],
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return set(result.stdout.strip().split("\n")) if result.stdout.strip() else set()
    except Exception:
        return set()


def fix_issues(work_dir: str, review: ReviewResult, mr_iid: int) -> FixResult:
    """Run Claude Code to fix review issues, then commit and push."""
    prompt = format_fix_prompt(review)

    if "No critical or warning issues found" in prompt:
        return FixResult(success=True, changed=False)

    logger.info(f"Starting Claude Code fix for MR !{mr_iid}...")

    # Get current state
    before_changes = get_modified_files(work_dir)

    try:
        result = subprocess.run(
            [
                "claude",
                "-p",
                prompt,
                "--permission-mode",
                "acceptEdits",
                "--allowed-tools",
                "Read Edit Bash",
                "--output-format",
                "json",
                "--no-session-persistence",
            ],
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=600,  # 10 minutes
        )

        if result.returncode != 0:
            stderr = result.stderr[:1000]
            logger.error(f"Claude Code exited with code {result.returncode}: {stderr}")
            return FixResult(success=False, changed=False, error=f"Claude Code failed: {stderr}")

        logger.info("Claude Code completed successfully.")

    except subprocess.TimeoutExpired:
        logger.error("Claude Code timed out after 10 minutes")
        return FixResult(success=False, changed=False, error="Claude Code timed out")

    # Check if files were actually modified
    after_changes = get_modified_files(work_dir)
    new_or_modified = after_changes - before_changes

    if not new_or_modified:
        logger.info("No files were modified by Claude Code.")
        return FixResult(success=True, changed=False)

    logger.info(f"Files modified: {', '.join(sorted(new_or_modified))}")

    # Commit and push
    try:
        subprocess.run(["git", "add", "-A"], cwd=work_dir, check=True, capture_output=True, timeout=30)
        subprocess.run(
            ["git", "commit", "-m", f"auto-fix: address review comments for MR !{mr_iid}"],
            cwd=work_dir,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        subprocess.run(["git", "push"], cwd=work_dir, check=True, capture_output=True, timeout=60)
        logger.info("Changes committed and pushed successfully.")
        return FixResult(success=True, changed=True)

    except subprocess.CalledProcessError as e:
        stderr = e.stderr[:500] if hasattr(e, "stderr") and e.stderr else "unknown error"
        logger.error(f"Git operation failed: {stderr}")
        return FixResult(success=False, changed=False, error=f"Git operation failed: {stderr}")
