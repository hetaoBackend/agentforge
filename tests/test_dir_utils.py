"""Tests for channels.dir_utils — /dir command parsing and Claude path extraction."""

from unittest.mock import Mock

import pytest

from channels import dir_utils

# ── parse_dir_command / handle_dir_command ────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [
        ("/dir ~/foo", "~/foo"),
        ("cd /home/user/bar", "/home/user/bar"),
        ("/cd ./app", "./app"),
        ("  CD ~/spaced  ", "~/spaced"),
        ("just a normal message", None),
        ("/dir", None),  # no argument
        ("/dir a b", None),  # too many args
    ],
)
def test_parse_dir_command(text, expected):
    assert dir_utils.parse_dir_command(text) == expected


def test_handle_dir_command_persists_and_confirms():
    db = Mock()
    out = dir_utils.handle_dir_command("/dir ~/proj", "telegram", db)
    db.set_setting.assert_called_once_with("telegram_default_working_dir", "~/proj")
    assert out == "📁 Working directory set to: ~/proj"


def test_handle_dir_command_ignores_non_command():
    db = Mock()
    assert dir_utils.handle_dir_command("hello there", "slack", db) is None
    db.set_setting.assert_not_called()


# ── extract_working_dir_with_claude ───────────────────────────────────────


def _resp(status=200, payload=None):
    r = Mock()
    r.status_code = status
    r.json.return_value = payload or {}
    return r


def test_extract_returns_none_without_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert dir_utils.extract_working_dir_with_claude("work in ~/x") is None


def test_extract_parses_path_from_claude(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    import requests

    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["model"] = json["model"]
        return _resp(200, {"content": [{"text": '{"path": "~/projects/foo"}'}]})

    monkeypatch.setattr(requests, "post", fake_post)
    assert (
        dir_utils.extract_working_dir_with_claude("在 ~/projects/foo 帮我跑测试")
        == "~/projects/foo"
    )
    assert captured["url"] == "https://api.anthropic.com/v1/messages"
    assert captured["model"] == "claude-haiku-4-5"


def test_extract_returns_none_on_null_path(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    import requests

    monkeypatch.setattr(
        requests, "post", lambda *a, **k: _resp(200, {"content": [{"text": '{"path": null}'}]})
    )
    assert dir_utils.extract_working_dir_with_claude("no path here") is None


def test_extract_returns_none_on_non_200(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    import requests

    monkeypatch.setattr(requests, "post", lambda *a, **k: _resp(500, {}))
    assert dir_utils.extract_working_dir_with_claude("anything") is None


def test_extract_swallows_exceptions(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    import requests

    def boom(*a, **k):
        raise RuntimeError("network down")

    monkeypatch.setattr(requests, "post", boom)
    assert dir_utils.extract_working_dir_with_claude("anything") is None


def test_extract_returns_none_on_malformed_json(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    import requests

    monkeypatch.setattr(
        requests, "post", lambda *a, **k: _resp(200, {"content": [{"text": "not json"}]})
    )
    assert dir_utils.extract_working_dir_with_claude("anything") is None


# ── resolve_working_dir ───────────────────────────────────────────────────


def test_resolve_prefers_extracted_path(monkeypatch):
    monkeypatch.setattr(dir_utils, "extract_working_dir_with_claude", lambda p: "~/extracted")
    db = Mock()
    assert dir_utils.resolve_working_dir("prompt", "telegram", db) == "~/extracted"
    db.get_setting.assert_not_called()


def test_resolve_falls_back_to_db_default(monkeypatch):
    monkeypatch.setattr(dir_utils, "extract_working_dir_with_claude", lambda p: None)
    db = Mock()
    db.get_setting.return_value = "~/from-db"
    assert dir_utils.resolve_working_dir("prompt", "slack", db) == "~/from-db"
    db.get_setting.assert_called_once_with("slack_default_working_dir")


def test_resolve_falls_back_to_home(monkeypatch):
    monkeypatch.setattr(dir_utils, "extract_working_dir_with_claude", lambda p: None)
    db = Mock()
    db.get_setting.return_value = None
    assert dir_utils.resolve_working_dir("prompt", "feishu", db) == "~"
