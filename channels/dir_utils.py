"""
Shared utilities for working-directory management across all channels.

Two features:
1. /dir (or cd) command  — explicit path switch, persists to DB.
2. Claude-based extraction — ask claude-haiku to pull a path from a
   free-text prompt so the user can say "在 ~/myproject 里帮我…"
   without typing a /dir command first.
"""

from __future__ import annotations

import json
import os
import re
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from taskboard import TaskDB


# ── 1. Explicit /dir / cd command ─────────────────────────────────────────

# Patterns we recognise as "switch directory" commands:
#   /dir ~/foo      cd ~/foo      /cd ~/foo
_DIR_CMD_RE = re.compile(
    r"^(?:/dir|/cd|cd)\s+(\S+)\s*$",
    re.IGNORECASE,
)


def parse_dir_command(text: str) -> Optional[str]:
    """Return the path argument if `text` is a /dir or cd command, else None."""
    m = _DIR_CMD_RE.match(text.strip())
    return m.group(1) if m else None


def handle_dir_command(
    text: str,
    channel_key: str,
    db: "TaskDB",
) -> Optional[str]:
    """
    If `text` is a /dir command, persist the new path to DB and return a
    confirmation string.  Returns None if `text` is not a dir command.

    `channel_key` is the settings key prefix, e.g. "telegram", "slack", "feishu".
    """
    path = parse_dir_command(text)
    if path is None:
        return None

    setting_key = f"{channel_key}_default_working_dir"
    db.set_setting(setting_key, path)
    return f"📁 Working directory set to: {path}"


# ── 2. Claude-based path extraction ───────────────────────────────────────

_EXTRACT_SYSTEM = (
    "You are a path-extraction assistant. "
    "Given a user message, decide if it explicitly mentions a filesystem path "
    "where some work should be done (e.g. ~/projects/foo, /home/user/bar, "
    "./myapp, C:\\\\Users\\\\foo). "
    "Reply with a JSON object and nothing else:\n"
    '  {"path": "<extracted path>"}  — if a path is found\n'
    '  {"path": null}               — if no path is mentioned\n'
    "Do NOT invent a path. Only return one that is clearly stated in the message."
)


def extract_working_dir_with_claude(prompt: str) -> Optional[str]:
    """
    Call the Anthropic Messages API (claude-haiku) to extract an explicit
    working directory from `prompt`.
    Returns the path string, or None if none found / on any error.

    Uses `requests` (already a project dependency) so no extra SDK needed.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return None

    try:
        import requests  # already in pyproject.toml

        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-haiku-4-5",
                "max_tokens": 64,
                "system": _EXTRACT_SYSTEM,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=15,
        )
        if resp.status_code != 200:
            return None

        data = resp.json()
        text = data.get("content", [{}])[0].get("text", "").strip()
        parsed = json.loads(text)
        path = parsed.get("path")
        if path and isinstance(path, str):
            return path.strip()
    except Exception:
        pass
    return None


def resolve_working_dir(
    prompt: str,
    channel_key: str,
    db: "TaskDB",
) -> str:
    """
    Determine the working directory for a new task:
    1. Try to extract an explicit path from `prompt` via Claude.
    2. Fall back to the channel's default_working_dir in DB.
    3. Fall back to "~".
    """
    extracted = extract_working_dir_with_claude(prompt)
    if extracted:
        return extracted

    setting_key = f"{channel_key}_default_working_dir"
    return db.get_setting(setting_key) or "~"
