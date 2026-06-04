"""Final mop-up coverage for still-uncovered, reachable branches in taskboard.py.

Everything here constructs ``TaskDB`` + ``TaskScheduler`` directly, never starts
the background loop, and mocks every agent / subprocess / network call. The
``run_server`` tests patch ``serve_forever`` (and bind/activate) to no-ops so
nothing real spawns or blocks.

Targets (current source line numbers):
* run_server ENABLED-channel wiring + shutdown() closure (5064-5167)
* env-var auto-enable for Telegram / Slack (5080-5081, 5103-5104)
* _run_agent_command subprocess branches (OSError, timeout, codex/claude parse)
* skill-draft worker error path + approve_skill invalid-name guard
* output-listener error swallow + remove_output_listener ValueError
* DAG _on_task_completed / _on_task_failed edge branches
"""

import json
import os
from unittest import mock

import pytest

import taskboard
from taskboard import (
    ScheduleType,
    Task,
    TaskDB,
    TaskScheduler,
)


def make_db(tmp_path):
    return TaskDB(str(tmp_path / "t.db"))


# ── run_server: every channel ENABLED ───────────────────────────────────────
def _run_server_with_enabled_channels(tmp_path, env, settings):
    """Drive run_server with the given env + settings, all channel classes mocked.

    Returns a dict of the mock constructors / instances so the caller can assert
    on .start() calls and exercise the shutdown() closure (captured via the
    registered SIGINT signal handler).
    """
    db = TaskDB(str(tmp_path / "t.db"))
    for key, val in settings.items():
        db.set_setting(key, val)

    feishu_inst = mock.Mock(name="feishu_inst")
    slack_inst = mock.Mock(name="slack_inst")
    weixin_inst = mock.Mock(name="weixin_inst")
    telegram_inst = mock.Mock(name="telegram_inst")
    ui_inst = mock.Mock(name="ui_inst")
    scheduler_inst = mock.Mock(name="scheduler_inst")

    feishu_cls = mock.Mock(return_value=feishu_inst)
    slack_cls = mock.Mock(return_value=slack_inst)
    weixin_cls = mock.Mock(return_value=weixin_inst)
    telegram_factory = mock.Mock(return_value=telegram_inst)
    ui_cls = mock.Mock(return_value=ui_inst)
    scheduler_cls = mock.Mock(return_value=scheduler_inst)

    captured = {}

    def fake_signal(sig, handler):
        captured[sig] = handler

    with (
        mock.patch.dict(os.environ, env, clear=True),
        mock.patch.object(taskboard, "_kill_stale_process_on_port"),
        mock.patch.object(taskboard, "TaskDB", return_value=db),
        mock.patch.object(taskboard, "FEISHU_CHANNEL_AVAILABLE", True),
        mock.patch.object(taskboard, "TELEGRAM_CHANNEL_AVAILABLE", True),
        mock.patch.object(taskboard, "SLACK_CHANNEL_AVAILABLE", True),
        mock.patch.object(taskboard, "WEIXIN_CHANNEL_AVAILABLE", True),
        mock.patch.object(taskboard, "FeishuChannel", feishu_cls),
        mock.patch.object(taskboard, "create_telegram_channel", telegram_factory),
        mock.patch.object(taskboard, "SlackChannel", slack_cls),
        mock.patch.object(taskboard, "WeixinChannel", weixin_cls),
        mock.patch.object(taskboard, "UIChannel", ui_cls),
        mock.patch.object(taskboard, "TaskScheduler", scheduler_cls),
        mock.patch.object(taskboard.QuietHTTPServer, "serve_forever", return_value=None) as serve,
        mock.patch.object(taskboard.QuietHTTPServer, "server_bind", return_value=None),
        mock.patch.object(taskboard.QuietHTTPServer, "server_activate", return_value=None),
        mock.patch.object(taskboard.QuietHTTPServer, "shutdown", return_value=None) as srv_shutdown,
        mock.patch.object(taskboard.signal, "signal", side_effect=fake_signal),
    ):
        taskboard.run_server(port=0)

        serve.assert_called_once()

        # Exercise the shutdown() closure via the registered SIGINT handler.
        handler = captured[taskboard.signal.SIGINT]
        with mock.patch.object(taskboard.sys, "exit") as sys_exit:
            handler(taskboard.signal.SIGINT, None)
            sys_exit.assert_called_once_with(0)
        srv_shutdown.assert_called_once()

    return {
        "feishu_cls": feishu_cls,
        "feishu_inst": feishu_inst,
        "slack_cls": slack_cls,
        "slack_inst": slack_inst,
        "weixin_cls": weixin_cls,
        "weixin_inst": weixin_inst,
        "telegram_factory": telegram_factory,
        "telegram_inst": telegram_inst,
        "ui_inst": ui_inst,
        "scheduler_inst": scheduler_inst,
        "serve": serve,
    }


def test_run_server_starts_all_channels_via_settings(tmp_path):
    """Every channel ENABLED through DB settings → each constructor + .start()
    is called, the API handler is wired, and shutdown() stops each channel."""
    env = {}  # no auto-enable env vars; settings drive everything
    settings = {
        "feishu_enabled": "true",
        "telegram_enabled": "true",
        "telegram_bot_token": "tg-token",
        "telegram_allowed_users": "u1,u2",
        "slack_enabled": "true",
        "slack_bot_token": "xoxb-bot",
        "slack_app_token": "xapp-app",
        "weixin_enabled": "true",
    }
    m = _run_server_with_enabled_channels(tmp_path, env, settings)

    # Each channel constructed + started.
    m["feishu_cls"].assert_called_once()
    m["feishu_inst"].start.assert_called_once()
    m["telegram_factory"].assert_called_once()
    m["telegram_inst"].start.assert_called_once()
    m["slack_cls"].assert_called_once()
    m["slack_inst"].start.assert_called_once()
    m["weixin_cls"].assert_called_once()
    m["weixin_inst"].start.assert_called_once()
    m["ui_inst"].start.assert_called_once()
    m["scheduler_inst"].start.assert_called_once()

    # Telegram factory received the configured token + allowed users.
    _, kwargs = m["telegram_factory"].call_args
    assert kwargs["token"] == "tg-token"
    assert kwargs["allowed_users_str"] == "u1,u2"

    # Slack got both tokens.
    _, sl_kwargs = m["slack_cls"].call_args
    assert sl_kwargs["bot_token"] == "xoxb-bot"
    assert sl_kwargs["app_token"] == "xapp-app"

    # API handler wired with the started channel instances.
    assert taskboard.TaskAPIHandler.feishu_channel is m["feishu_inst"]
    assert taskboard.TaskAPIHandler.telegram_channel is m["telegram_inst"]
    assert taskboard.TaskAPIHandler.slack_channel is m["slack_inst"]
    assert taskboard.TaskAPIHandler.weixin_channel is m["weixin_inst"]
    assert taskboard.TaskAPIHandler.scheduler is m["scheduler_inst"]

    # shutdown() closure stopped each channel + the scheduler.
    m["feishu_inst"].stop.assert_called_once()
    m["telegram_inst"].stop.assert_called_once()
    m["slack_inst"].stop.assert_called_once()
    m["scheduler_inst"].stop.assert_called_once()


def test_run_server_auto_enables_telegram_and_slack_via_env(tmp_path):
    """Env vars (but no enabling settings) auto-enable Telegram + Slack."""
    env = {
        "TELEGRAM_BOT_TOKEN": "env-tg",
        "SLACK_BOT_TOKEN": "env-bot",
        "SLACK_APP_TOKEN": "env-app",
    }
    settings = {}  # nothing enabled in DB — env must flip them on
    m = _run_server_with_enabled_channels(tmp_path, env, settings)

    m["telegram_factory"].assert_called_once()
    m["telegram_inst"].start.assert_called_once()
    m["slack_cls"].assert_called_once()
    m["slack_inst"].start.assert_called_once()

    # Tokens came from the environment.
    _, tg_kwargs = m["telegram_factory"].call_args
    assert tg_kwargs["token"] == "env-tg"
    _, sl_kwargs = m["slack_cls"].call_args
    assert sl_kwargs["bot_token"] == "env-bot"
    assert sl_kwargs["app_token"] == "env-app"

    # Feishu / Weixin not enabled → not constructed, and the handler refs are None.
    m["feishu_cls"].assert_not_called()
    m["weixin_cls"].assert_not_called()
    assert taskboard.TaskAPIHandler.feishu_channel is None
    assert taskboard.TaskAPIHandler.weixin_channel is None


def test_run_server_telegram_factory_returns_none_no_start(tmp_path):
    """When create_telegram_channel returns None, .start() is never reached.

    Also enables Feishu while leaving Telegram/Slack off so the shutdown()
    closure exercises the "channel is None → skip stop" branches for
    telegram_channel and slack_channel.
    """
    db = TaskDB(str(tmp_path / "t.db"))
    db.set_setting("telegram_enabled", "true")
    db.set_setting("telegram_bot_token", "tok")
    db.set_setting("feishu_enabled", "true")

    scheduler_inst = mock.Mock()
    feishu_inst = mock.Mock()
    telegram_factory = mock.Mock(return_value=None)  # factory declines

    captured = {}

    def fake_signal(sig, handler):
        captured[sig] = handler

    with (
        mock.patch.dict(os.environ, {}, clear=True),
        mock.patch.object(taskboard, "_kill_stale_process_on_port"),
        mock.patch.object(taskboard, "TaskDB", return_value=db),
        mock.patch.object(taskboard, "TELEGRAM_CHANNEL_AVAILABLE", True),
        mock.patch.object(taskboard, "FEISHU_CHANNEL_AVAILABLE", True),
        mock.patch.object(taskboard, "FeishuChannel", mock.Mock(return_value=feishu_inst)),
        mock.patch.object(taskboard, "create_telegram_channel", telegram_factory),
        mock.patch.object(taskboard, "UIChannel", mock.Mock()),
        mock.patch.object(taskboard, "TaskScheduler", mock.Mock(return_value=scheduler_inst)),
        mock.patch.object(taskboard.QuietHTTPServer, "serve_forever", return_value=None),
        mock.patch.object(taskboard.QuietHTTPServer, "server_bind", return_value=None),
        mock.patch.object(taskboard.QuietHTTPServer, "server_activate", return_value=None),
        mock.patch.object(taskboard.QuietHTTPServer, "shutdown", return_value=None),
        mock.patch.object(taskboard.signal, "signal", side_effect=fake_signal),
    ):
        taskboard.run_server(port=0)

        # Run shutdown() with telegram/slack absent → those stop branches skip.
        handler = captured[taskboard.signal.SIGTERM]
        with mock.patch.object(taskboard.sys, "exit"):
            handler(taskboard.signal.SIGTERM, None)

    telegram_factory.assert_called_once()
    assert taskboard.TaskAPIHandler.telegram_channel is None
    assert taskboard.TaskAPIHandler.slack_channel is None
    feishu_inst.stop.assert_called_once()  # feishu present → stopped
    scheduler_inst.stop.assert_called_once()


# ── _run_agent_command: subprocess branches (Popen mocked) ───────────────────
class _FakePopen:
    def __init__(self, returncode=0, stdout_lines=None, stderr_lines=None, wait_raises=None):
        self.returncode = returncode
        self.stdout = list(stdout_lines or [])
        self.stderr = list(stderr_lines or [])
        self._wait_raises = wait_raises
        self.killed = False

    def wait(self, timeout=None):
        if self._wait_raises is not None:
            raise self._wait_raises
        return self.returncode

    def kill(self):
        self.killed = True


def test_run_agent_command_filenotfound(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    monkeypatch.setattr(
        "taskboard.subprocess.Popen", lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError())
    )
    ok, out = sched._run_agent_command("claude", ["claude"], ".")
    assert ok is False
    assert "not found" in out


def test_run_agent_command_oserror(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    monkeypatch.setattr(
        "taskboard.subprocess.Popen", lambda *a, **k: (_ for _ in ()).throw(OSError("boom"))
    )
    ok, out = sched._run_agent_command("claude", ["claude"], ".")
    assert ok is False
    assert "boom" in out


def test_run_agent_command_timeout_kills_proc(tmp_path, monkeypatch):
    import subprocess as _sp

    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    proc = _FakePopen(wait_raises=_sp.TimeoutExpired(["claude"], 1))
    monkeypatch.setattr("taskboard.subprocess.Popen", lambda *a, **k: proc)
    ok, out = sched._run_agent_command("claude", ["claude"], ".")
    assert ok is False
    assert "timed out" in out
    assert proc.killed is True


def test_run_agent_command_nonzero_returns_stderr(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    proc = _FakePopen(returncode=2, stdout_lines=[], stderr_lines=["the error\n"])
    monkeypatch.setattr("taskboard.subprocess.Popen", lambda *a, **k: proc)
    ok, out = sched._run_agent_command("claude", ["claude"], ".")
    assert ok is False
    assert "the error" in out


def test_run_agent_command_codex_parses_agent_message(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    lines = [
        "\n",  # blank → skipped
        "not json\n",  # JSONDecodeError → skipped
        json.dumps({"type": "thread.started", "thread_id": "t1"}) + "\n",
        json.dumps(
            {"type": "item.completed", "item": {"type": "agent_message", "text": "CODEX FINAL"}}
        )
        + "\n",
    ]
    proc = _FakePopen(returncode=0, stdout_lines=lines)
    monkeypatch.setattr("taskboard.subprocess.Popen", lambda *a, **k: proc)
    ok, out = sched._run_agent_command("codex", ["codex"], ".")
    assert ok is True
    assert out == "CODEX FINAL"


def test_run_agent_command_claude_parses_result_and_assistant(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    lines = [
        "\n",  # blank → skipped
        "garbage\n",  # JSONDecodeError → skipped
        json.dumps(
            {
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "thinking"}, "raw-str"]},
            }
        )
        + "\n",
        json.dumps({"type": "result", "result": "CLAUDE RESULT"}) + "\n",
    ]
    proc = _FakePopen(returncode=0, stdout_lines=lines)
    monkeypatch.setattr("taskboard.subprocess.Popen", lambda *a, **k: proc)
    ok, out = sched._run_agent_command("claude", ["claude"], ".")
    assert ok is True
    assert out == "CLAUDE RESULT"


def test_run_agent_command_claude_falls_back_to_assistant_text(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    # No result event → falls back to the last assistant text.
    lines = [
        json.dumps(
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "ONLY TEXT"}]}}
        )
        + "\n",
    ]
    proc = _FakePopen(returncode=0, stdout_lines=lines)
    monkeypatch.setattr("taskboard.subprocess.Popen", lambda *a, **k: proc)
    ok, out = sched._run_agent_command("claude", ["claude"], ".")
    assert ok is True
    assert out == "ONLY TEXT"


# ── skill draft worker error path + approve_skill guards ─────────────────────
def _make_pattern(db, key="pk"):
    db.upsert_skill_pattern(key, "recipe", "summary", 1)
    return db.conn.execute("SELECT id FROM skill_patterns WHERE pattern_key=?", (key,)).fetchone()[
        "id"
    ]


def test_trigger_skill_draft_worker_records_error(tmp_path, monkeypatch):
    import time as _time

    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    pid = _make_pattern(db)

    def boom(*a, **k):
        raise RuntimeError("distill kaboom")

    monkeypatch.setattr(sched, "distill_skill_draft", boom)
    assert sched.trigger_skill_draft(pid) is True

    # Poll until the background worker persists the error to the draft row.
    for _ in range(50):
        draft = db.get_skill_draft(pid)
        if draft and draft["status"] == "error":
            break
        _time.sleep(0.02)
    draft = db.get_skill_draft(pid)
    assert draft["status"] == "error"
    assert "distill kaboom" in (draft["error"] or "")


def test_trigger_skill_draft_unknown_pattern_returns_false(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    assert sched.trigger_skill_draft(99999) is False


def test_approve_skill_invalid_name_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    pid = _make_pattern(db, key="!!!")  # sanitizes to empty
    # Body with frontmatter whose name also sanitizes to empty.
    body = "---\nname: !!!\n---\nbody"
    with pytest.raises(ValueError, match="invalid skill name"):
        sched.approve_skill(pid, name="!!!", description="d", body=body)


def test_approve_skill_empty_body_raises(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    pid = _make_pattern(db)
    with pytest.raises(ValueError, match="skill body is empty"):
        sched.approve_skill(pid, name="ok", description="d", body="   ")


# ── output listeners: error swallow + remove edge ────────────────────────────
def test_fire_output_listeners_swallows_callback_error(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    calls = []

    def bad(task_id, run_id, event_type, content):
        raise RuntimeError("listener boom")

    def good(task_id, run_id, event_type, content):
        calls.append((task_id, content))

    sched.add_output_listener(bad)
    sched.add_output_listener(good)
    # Must not raise even though `bad` throws; `good` still runs.
    sched._fire_output_listeners(1, 2, "assistant", "hello")
    assert calls == [(1, "hello")]


def test_remove_output_listener_unregistered_is_noop(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    # Removing a callback that was never added hits the ValueError branch.
    sched.remove_output_listener(lambda *a: None)  # must not raise


# ── DAG hooks: edge branches ─────────────────────────────────────────────────
def test_on_task_completed_skips_when_downstream_deleted(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    up = db.add_task(Task(title="up", prompt="p", working_dir="."))
    down = sched.submit_task(Task(title="down", prompt="p", working_dir="."), depends_on=[up])
    assert db.get_task(down)["status"] == "blocked"

    db.update_task(up, status="completed")
    # get_task(downstream) returns None → the `continue` branch is taken.
    real_get_task = db.get_task

    def get_task_none_for_down(task_id):
        if task_id == down:
            return None
        return real_get_task(task_id)

    with mock.patch.object(db, "get_task", side_effect=get_task_none_for_down):
        sched._on_task_completed(up)
    # Downstream never updated because it "vanished" mid-hook.
    assert db.get_task(down)["status"] == "blocked"


def test_on_task_completed_unknown_schedule_type_defaults_pending(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    up = db.add_task(Task(title="up", prompt="p", working_dir="."))
    down = sched.submit_task(Task(title="down", prompt="p", working_dir="."), depends_on=[up])
    # Force an unrecognized schedule_type so the else-branch (pending) runs.
    db.conn.execute("UPDATE tasks SET schedule_type='weird' WHERE id=?", (down,))
    db.conn.commit()
    db.update_task(up, status="completed")
    sched._on_task_completed(up)
    assert db.get_task(down)["status"] == "pending"


def test_on_task_failed_diamond_visits_shared_downstream_once(tmp_path):
    # root → a, root → b, both a & b → leaf. The `already visited` continue
    # branch fires for leaf the second time it's reached.
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    root = db.add_task(Task(title="root", prompt="p", working_dir="."))
    a = db.add_task(Task(title="a", prompt="p", working_dir="."))
    b = db.add_task(Task(title="b", prompt="p", working_dir="."))
    leaf = db.add_task(Task(title="leaf", prompt="p", working_dir="."))
    db.add_dependency(a, root)
    db.add_dependency(b, root)
    db.add_dependency(leaf, a)
    db.add_dependency(leaf, b)
    for t in (a, b, leaf):
        db.update_task(t, status="blocked")
    sched._on_task_failed(root)
    assert db.get_task(a)["status"] == "cancelled"
    assert db.get_task(b)["status"] == "cancelled"
    assert db.get_task(leaf)["status"] == "cancelled"


# ── _schedule_delayed transitions pending → scheduled with next_run_at ───────
def test_schedule_delayed_sets_scheduled_and_next_run(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(
        Task(
            title="t",
            prompt="p",
            working_dir=".",
            schedule_type=ScheduleType.DELAYED,
            delay_seconds=30,
        )
    )
    sched._schedule_delayed(db.get_task(tid))
    row = db.get_task(tid)
    assert row["status"] == "scheduled"
    assert row["next_run_at"] is not None
