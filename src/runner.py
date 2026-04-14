"""Main event loop / orchestrator for auto-review workflow."""

import json
import logging
import time
from pathlib import Path

from .config import Config, load_config
from .gitlab_client import GitLabClient
from .gemini_review import ReviewResult, review_diff, format_review_summary
from .claude_fix import fix_issues

logger = logging.getLogger(__name__)

STATE_FILE = Path(__file__).parent.parent / "state.json"


class StateManager:
    """Simple JSON file-based state tracker for MR review rounds."""

    def __init__(self, state_path: Path = STATE_FILE):
        self.state_path = state_path
        self.state = self._load()

    def _load(self) -> dict:
        if self.state_path.exists():
            try:
                with open(self.state_path) as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                logger.warning(f"State file corrupted, resetting.")
                return {}
        return {}

    def save(self):
        with open(self.state_path, "w") as f:
            json.dump(self.state, f, indent=2)

    def get_round(self, mr_iid: int) -> int:
        return self.state.get(str(mr_iid), {}).get("round", 0)

    def increment_round(self, mr_iid: int):
        key = str(mr_iid)
        if key not in self.state:
            self.state[key] = {"round": 0, "status": "idle"}
        self.state[key]["round"] += 1
        self.state[key]["status"] = "reviewing"
        self.save()

    def set_status(self, mr_iid: int, status: str):
        key = str(mr_iid)
        if key not in self.state:
            self.state[key] = {"round": 0}
        self.state[key]["status"] = status
        self.save()

    def is_processing(self, mr_iid: int) -> bool:
        return self.state.get(str(mr_iid), {}).get("status") in ("reviewing", "fixing")


def review_mr(client: GitLabClient, config: Config, mr_iid: int) -> ReviewResult:
    """Step 1: Fetch MR diff, send to Gemini, post review comment."""
    logger.info(f"Reviewing MR !{mr_iid}...")

    diff_text = client.get_mr_diff_text(mr_iid)
    if not diff_text.strip():
        logger.info(f"MR !{mr_iid} has no diffs, skipping review.")
        return ReviewResult(summary="No changes detected.", overall_verdict="approved")

    review = review_diff(diff_text, config.gemini_api_key, config.gemini_model)

    # Post review summary as a note on the MR
    summary = format_review_summary(review)
    client.post_note(mr_iid, summary)
    logger.info(f"Posted review for MR !{mr_iid}: verdict={review.overall_verdict}, issues={len(review.comments)}")

    return review


def run_review_fix_cycle(client: GitLabClient, config: Config, mr_iid: int, state: StateManager):
    """Run one full review-fix cycle for an MR."""
    if state.is_processing(mr_iid):
        logger.info(f"MR !{mr_iid} is already being processed, skipping.")
        return

    current_round = state.get_round(mr_iid)
    if current_round >= config.max_review_rounds:
        logger.info(f"MR !{mr_iid} has reached max rounds ({config.max_review_rounds}), stopping.")
        client.post_note(mr_iid, f"⏹️ Auto-review stopped: reached maximum {config.max_review_rounds} rounds.")
        state.set_status(mr_iid, "max_rounds_reached")
        return

    # Step 1: Review
    state.increment_round(mr_iid)
    try:
        review = review_mr(client, config, mr_iid)
    except Exception as e:
        logger.error(f"Review failed for MR !{mr_iid}: {e}")
        state.set_status(mr_iid, "failed")
        return

    if review.overall_verdict == "approved" or not review.fixable_comments:
        logger.info(f"MR !{mr_iid} approved after round {state.get_round(mr_iid)}.")
        state.set_status(mr_iid, "approved")
        return

    # Step 2: Fix
    state.set_status(mr_iid, "fixing")
    try:
        result = fix_issues(config.claude_work_dir, review, mr_iid)
    except Exception as e:
        logger.error(f"Fix failed for MR !{mr_iid}: {e}")
        client.post_note(mr_iid, f"❌ Auto-fix failed: {e}")
        state.set_status(mr_iid, "failed")
        return

    if not result.success:
        logger.error(f"Fix failed for MR !{mr_iid}: {result.error}")
        client.post_note(mr_iid, f"❌ Auto-fix failed: {result.error}")
        state.set_status(mr_iid, "failed")
        return

    if result.changed:
        logger.info(f"MR !{mr_iid} fixed and pushed. GitLab will trigger re-review.")
        state.set_status(mr_iid, "fixed_waiting_for_re_review")
    else:
        logger.info(f"MR !{mr_iid} no changes made by Claude, marking as done.")
        state.set_status(mr_iid, "done")


def main():
    """Entry point: load config, test connection, run review-fix cycle for the latest open MR."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    config = load_config()
    logger.info(f"Config loaded: GitLab={config.gitlab_url}, Project={config.gitlab_project_id}")

    client = GitLabClient(config.gitlab_url, config.gitlab_token, config.gitlab_project_id)
    if not client.test_connection():
        logger.error("Cannot connect to GitLab. Check your configuration.")
        return

    state = StateManager()

    # Get all open MRs
    try:
        resp = client._request("GET", f"{client._project_path()}/merge_requests", params={"state": "opened"})
        open_mrs = resp.json()
    except Exception as e:
        logger.error(f"Failed to list MRs: {e}")
        return

    if not open_mrs:
        logger.info("No open MRs found.")
        return

    for mr in open_mrs:
        mr_iid = mr["iid"]
        logger.info(f"Processing MR !{mr_iid}: {mr['title']}")
        run_review_fix_cycle(client, config, mr_iid, state)
        # Small delay between MRs
        time.sleep(5)

    logger.info("All open MRs processed.")


if __name__ == "__main__":
    main()
