"""GitLab API client wrapper for auto-review workflow."""

import logging

import requests

logger = logging.getLogger(__name__)


class GitLabClient:
    """Thin wrapper around GitLab REST API for MR review operations."""

    def __init__(self, base_url: str, token: str, project_id: str):
        self.base_url = base_url.rstrip("/")
        self.project_id = project_id
        self.session = requests.Session()
        self.session.headers["PRIVATE-TOKEN"] = token

    def _url(self, path: str) -> str:
        return f"{self.base_url}/api/v4{path}"

    def _project_path(self) -> str:
        return f"/projects/{requests.utils.quote(self.project_id, safe='')}"

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        url = self._url(path)
        resp = self.session.request(method, url, **kwargs)
        if resp.status_code >= 400:
            logger.error(f"GitLab API error {resp.status_code}: {resp.text[:500]}")
            resp.raise_for_status()
        return resp

    def get_mr(self, iid: int) -> dict:
        """Get single MR details."""
        resp = self._request("GET", f"{self._project_path()}/merge_requests/{iid}")
        return resp.json()

    def get_mr_diffs(self, iid: int) -> list[dict]:
        """Get MR diffs. Returns list of {old_path, new_path, diff, ...}.
        Tries /diffs first, falls back to /changes for self-hosted GitLab."""
        try:
            resp = self._request("GET", f"{self._project_path()}/merge_requests/{iid}/diffs", params={"unidiff": True})
            return resp.json()
        except Exception:
            # Fallback: use /changes endpoint (works on older GitLab versions)
            logger.info(f"Diff endpoint failed, falling back to /changes for MR !{iid}")
            resp = self._request("GET", f"{self._project_path()}/merge_requests/{iid}/changes")
            data = resp.json()
            return data.get("changes", [])

    def get_mr_diff_text(self, iid: int) -> str:
        """Get concatenated diff text from all files in the MR."""
        diffs = self.get_mr_diffs(iid)
        parts = []
        for d in diffs:
            if d.get("diff"):
                parts.append(f"--- {d.get('old_path', 'dev/null')}\n+++ {d.get('new_path', 'dev/null')}\n{d['diff']}")
        return "\n\n".join(parts)

    def get_mr_notes(self, iid: int) -> list[dict]:
        """List all notes (comments) on an MR."""
        resp = self._request("GET", f"{self._project_path()}/merge_requests/{iid}/notes")
        return resp.json()

    def post_note(self, iid: int, body: str) -> dict:
        """Post a comment/note on an MR."""
        resp = self._request("POST", f"{self._project_path()}/merge_requests/{iid}/notes", json={"body": body})
        return resp.json()

    def create_discussion(self, iid: int, body: str) -> dict:
        """Create a new discussion thread on an MR."""
        resp = self._request("POST", f"{self._project_path()}/merge_requests/{iid}/discussions", json={"body": body})
        return resp.json()

    def test_connection(self) -> bool:
        """Test API connectivity by fetching project info."""
        try:
            resp = self._request("GET", self._project_path())
            project = resp.json()
            logger.info(f"Connected to GitLab project: {project.get('name')} ({project.get('path_with_namespace')})")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to GitLab: {e}")
            return False
