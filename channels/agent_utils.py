"""
Shared utilities for switching the default coding agent across all channels.

Usage from any channel:
    /agent claude   — switch to Claude Code
    /agent codex    — switch to Codex CLI
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from taskboard import TaskDB


# Supported agent names
SUPPORTED_AGENTS = {
    "claude": "Claude Code (claude CLI)",
    "codex": "Codex CLI (openai/codex)",
}

# Regex: /agent <name>
_AGENT_CMD_RE = re.compile(
    r"^/agent\s+(\S+)\s*$",
    re.IGNORECASE,
)


def parse_agent_command(text: str) -> Optional[str]:
    """Return the agent name argument if `text` is a /agent command, else None."""
    m = _AGENT_CMD_RE.match(text.strip())
    return m.group(1).lower() if m else None


def handle_agent_command(
    text: str,
    channel_key: str,
    db: "TaskDB",
) -> Optional[str]:
    """
    If `text` is a /agent command, persist the choice to DB and return a
    confirmation string.  Returns None if `text` is not an agent command.

    The setting is stored as global `default_agent` (shared across all channels
    and the Forge desktop app).
    """
    agent = parse_agent_command(text)
    if agent is None:
        return None

    if agent not in SUPPORTED_AGENTS:
        names = ", ".join(f"`{k}`" for k in SUPPORTED_AGENTS)
        return f"❌ Unknown agent `{agent}`. Supported: {names}"

    db.set_setting("default_agent", agent)
    label = SUPPORTED_AGENTS[agent]
    return f"🤖 Default agent switched to: **{label}**"


def resolve_agent(channel_key: str, db: "TaskDB") -> str:
    """
    Return the current default agent from settings.
    Falls back to "claude" if not set.
    """
    return db.get_setting("default_agent", "claude")
