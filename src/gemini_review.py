"""Gemini API code review engine."""

import json
import logging
import os
import urllib3
from typing import Optional

import requests
from pydantic import BaseModel, Field

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logger = logging.getLogger(__name__)

REVIEW_SYSTEM_PROMPT = """你是一个资深高级软件工程师，正在进行代码审查。你必须全程使用中文进行回复。

审查以下代码 diff。对于发现的每个问题：
1. 指出文件和大致行号
2. 分类严重程度：critical（必须修复）、warning（应该修复）、suggestion（建议）、nitpick（细节）
3. 分类问题类型：bug、security、performance、style（代码风格）、maintainability（可维护性）、test（测试）
4. 用中文清晰说明问题
5. 给出具体的中文修复建议（含代码示例）

附加规则：
- 关注正确性、安全性和可维护性
- 除非严重影响可读性，否则不要只评论格式
- 如果 diff 没问题，请直接说「代码看起来没问题」
- 不要标记明显是有意设计的决策
- 你必须全程使用中文，包括 summary、comment 和 suggestion 字段
- 要具体、可操作"""

# Schema descriptions in Chinese to encourage Chinese output
REVIEW_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "summary": {"type": "STRING", "description": "代码变更的中文概述"},
        "overall_verdict": {
            "type": "STRING",
            "enum": ["approved", "needs_changes", "minor_suggestions"],
        },
        "comments": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "file": {"type": "STRING", "description": "文件路径"},
                    "line_number": {"type": "INTEGER", "nullable": True, "description": "行号"},
                    "severity": {
                        "type": "STRING",
                        "enum": ["critical", "warning", "suggestion", "nitpick"],
                    },
                    "category": {
                        "type": "STRING",
                        "enum": ["bug", "security", "performance", "style", "maintainability", "test"],
                    },
                    "comment": {"type": "STRING", "description": "用中文描述问题"},
                    "suggestion": {"type": "STRING", "nullable": True, "description": "用中文给出修复建议"},
                },
                "required": ["file", "severity", "category", "comment"],
            },
        },
    },
    "required": ["summary", "overall_verdict", "comments"],
}


class ReviewComment(BaseModel):
    file: str
    line_number: Optional[int] = None
    severity: str  # critical, warning, suggestion, nitpick
    category: str  # bug, security, performance, style, maintainability, test
    comment: str
    suggestion: Optional[str] = None


class ReviewResult(BaseModel):
    summary: str
    overall_verdict: str  # approved, needs_changes, minor_suggestions
    comments: list[ReviewComment] = Field(default_factory=list)

    @property
    def fixable_comments(self) -> list[ReviewComment]:
        """Return comments that should be auto-fixed (critical + warning)."""
        return [c for c in self.comments if c.severity in ("critical", "warning")]


def review_diff(diff_text: str, api_key: str, model: str = "gemini-2.5-flash") -> ReviewResult:
    """Send a code diff to Gemini and get back a structured review."""
    if not diff_text.strip():
        return ReviewResult(summary="No changes to review.", overall_verdict="approved")

    import time

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

    prompt = f"""请用中文审查以下代码 diff，并输出结构化的 JSON 反馈。

```diff
{diff_text}
```"""

    payload = {
        "system_instruction": {"parts": [{"text": REVIEW_SYSTEM_PROMPT}]},
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "response_mime_type": "application/json",
            "response_schema": REVIEW_SCHEMA,
        },
    }

    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    proxies = {"https": proxy, "http": proxy} if proxy else None

    last_error = None
    for attempt in range(3):
        try:
            # 通过代理时可能有证书问题，关掉 SSL 验证
            resp = requests.post(
                url,
                json=payload,
                params={"key": api_key},
                timeout=120,
                proxies=proxies,
                verify=False,
            )
            if resp.status_code == 503:
                raise RuntimeError(f"Gemini API 服务繁忙 (503)，请稍后重试")
            if resp.status_code >= 400:
                logger.error(f"Gemini API error {resp.status_code}: {resp.text[:500]}")
                resp.raise_for_status()

            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            parsed = json.loads(text)
            return ReviewResult(**parsed)
        except (requests.exceptions.SSLError, requests.exceptions.ConnectionError, RuntimeError) as e:
            last_error = e
            if attempt < 2:
                wait = 3 * (attempt + 1)
                logger.warning(f"Gemini call failed (attempt {attempt+1}/3), retrying in {wait}s: {e}")
                time.sleep(wait)

    logger.error(f"Gemini API error after 3 retries: {last_error}")
    raise RuntimeError(f"Failed to call Gemini API after 3 retries: {last_error}")


def format_review_summary(review: ReviewResult) -> str:
    """Format a ReviewResult into a readable Markdown comment for GitLab MR."""
    lines = []

    verdict_emoji = {"approved": "✅", "needs_changes": "🔍", "minor_suggestions": "💡"}
    emoji = verdict_emoji.get(review.overall_verdict, "📋")

    lines.append(f"## {emoji} Auto Review Summary\n")
    lines.append(review.summary)
    lines.append(f"\n\n**Verdict**: `{review.overall_verdict}`")

    if review.comments:
        lines.append(f"\n\n### Issues Found ({len(review.comments)})\n")
        for i, c in enumerate(review.comments, 1):
            severity_badge = {"critical": "🔴", "warning": "🟡", "suggestion": "🔵", "nitpick": "⚪"}.get(
                c.severity, "⚪"
            )
            location = f"`{c.file}`"
            if c.line_number:
                location += f" (line {c.line_number})"
            lines.append(f"{i}. {severity_badge} **[{c.severity}]** [{c.category}] {location}\n   {c.comment}")
            if c.suggestion:
                lines.append(f"   \n   **Suggestion**: {c.suggestion}")
            lines.append("")
    else:
        lines.append("\n\nNo issues found. Code looks good!")

    lines.append("\n---\n*This review was generated automatically by Gemini AI.*")
    return "\n".join(lines)


def format_fix_prompt(review: ReviewResult) -> str:
    """Format review comments into a prompt for Claude Code to fix."""
    fixable = review.fixable_comments
    if not fixable:
        return "No critical or warning issues found. No fixes needed."

    lines = [
        "You are fixing code review issues in the current project.",
        "",
        "Below are the issues found by an automated code reviewer.",
        "Fix each issue carefully. After fixing, the code should be correct.",
        "",
        "## Issues to Fix",
        "",
    ]

    for i, c in enumerate(fixable, 1):
        location = f"`{c.file}`"
        if c.line_number:
            location += f" (line {c.line_number})"
        lines.append(f"### Issue {i}: [{c.severity}] {c.category} - {location}")
        lines.append(c.comment)
        if c.suggestion:
            lines.append(f"Suggested fix: {c.suggestion}")
        lines.append("")

    lines.extend([
        "## Instructions",
        "1. Read each file mentioned in the comments",
        "2. Make the necessary fixes using the Edit tool",
        "3. Do NOT change files not mentioned in the comments",
        "4. Run any existing tests to verify your changes don't break things",
        "5. After fixing all issues, reply with a summary of what you changed",
    ])

    return "\n".join(lines)
