import os

from channels.agent_utils import (
    SUPPORTED_AGENTS,
    handle_agent_command,
    parse_agent_command,
    resolve_agent,
)
from channels.dir_utils import handle_dir_command, parse_dir_command, resolve_working_dir
from taskboard import _get_env


class StubDB:
    def __init__(self):
        self.settings = {}

    def set_setting(self, key, value):
        self.settings[key] = value

    def get_setting(self, key, default=None):
        return self.settings.get(key, default)


def test_parse_dir_command_accepts_supported_forms():
    assert parse_dir_command("/dir ~/repo") == "~/repo"
    assert parse_dir_command("/cd ./repo") == "./repo"
    assert parse_dir_command("cd /tmp/work") == "/tmp/work"
    assert parse_dir_command("pwd") is None


def test_handle_dir_command_persists_setting():
    db = StubDB()

    result = handle_dir_command("/dir ~/repo", "telegram", db)

    assert result == "📁 Working directory set to: ~/repo"
    assert db.get_setting("telegram_default_working_dir") == "~/repo"


def test_resolve_working_dir_uses_saved_default_when_no_explicit_path(monkeypatch):
    db = StubDB()
    db.set_setting("slack_default_working_dir", "~/saved")
    monkeypatch.setattr("channels.dir_utils.extract_working_dir_with_claude", lambda prompt: None)

    assert resolve_working_dir("please help", "slack", db) == "~/saved"


def test_resolve_working_dir_prefers_extracted_path(monkeypatch):
    db = StubDB()
    db.set_setting("slack_default_working_dir", "~/saved")
    monkeypatch.setattr(
        "channels.dir_utils.extract_working_dir_with_claude",
        lambda prompt: "~/explicit",
    )

    assert resolve_working_dir("work in ~/explicit", "slack", db) == "~/explicit"


def test_parse_agent_command_normalizes_name():
    assert parse_agent_command("/agent codex") == "codex"
    assert parse_agent_command("/agent CLAUDE") == "claude"
    assert parse_agent_command("/help") is None


def test_handle_agent_command_rejects_unknown_agent():
    db = StubDB()

    result = handle_agent_command("/agent unknown", "telegram", db)

    assert result == "❌ Unknown agent `unknown`. Supported: `claude`, `codex`"


def test_handle_agent_command_persists_default_agent():
    db = StubDB()

    result = handle_agent_command("/agent codex", "telegram", db)

    assert result == f"🤖 Default agent switched to: **{SUPPORTED_AGENTS['codex']}**"
    assert db.get_setting("default_agent") == "codex"
    assert resolve_agent("telegram", db) == "codex"


def test_get_env_prepends_common_tool_paths(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setattr(os.path, "expanduser", lambda path: path.replace("~", "/Users/tester"))

    env = _get_env()

    assert env["PATH"].startswith(
        "/Users/tester/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/local/opt/node/bin:"
        "/Users/tester/.npm/bin:/Users/tester/.nvm/current/bin:/usr/bin:/bin"
    )
