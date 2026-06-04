import threading
from unittest.mock import MagicMock, patch

from taskboard_bus import MessageBus, OutboundMessage, OutboundMessageType


class StubDB:
    def __init__(self):
        self.settings = {}
        self.tasks = {}
        self.updated = []

    def get_setting(self, key, default=None):
        return self.settings.get(key, default)

    def set_setting(self, key, value):
        self.settings[key] = value

    def get_task(self, task_id):
        return self.tasks.get(task_id)

    def update_task(self, task_id, **updates):
        self.updated.append((task_id, updates))
        self.tasks.setdefault(task_id, {"id": task_id}).update(updates)


class StubScheduler:
    def __init__(self):
        self.submitted = []

    def submit_task(self, task):
        self.submitted.append(task)
        return len(self.submitted)


def _make_channel(db=None, scheduler=None):
    from channels.slack_channel import SlackChannel

    bus = MessageBus()
    db = db or StubDB()
    scheduler = scheduler or StubScheduler()
    channel = SlackChannel(
        bus=bus,
        db=db,
        scheduler=scheduler,
        bot_token="xoxb-test",
        app_token="xapp-test",
    )
    # Inject a mock web client and bot id so helpers don't hit the network.
    channel._web_client = MagicMock()
    channel._web_client.chat_postMessage.return_value = {"ts": "1700.0001"}
    channel._bot_user_id = "UBOT"
    return channel


# ── construction / config ────────────────────────────────────────


def test_init_reads_tokens_and_subscribes():
    channel = _make_channel()
    assert channel.bot_token == "xoxb-test"
    assert channel.app_token == "xapp-test"
    assert channel.name == "slack"
    assert channel._on_outbound in channel.bus._outbound_listeners


def test_init_falls_back_to_env(monkeypatch):
    from channels.slack_channel import SlackChannel

    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-env")
    monkeypatch.setenv("SLACK_APP_TOKEN", "xapp-env")
    channel = SlackChannel(bus=MessageBus(), db=StubDB(), scheduler=StubScheduler())
    assert channel.bot_token == "xoxb-env"
    assert channel.app_token == "xapp-env"


def test_start_disabled_without_tokens(capsys):
    from channels.slack_channel import SlackChannel

    channel = SlackChannel(bus=MessageBus(), db=StubDB(), scheduler=StubScheduler())
    channel.bot_token = ""
    channel.app_token = ""
    channel.start()
    assert "disabled" in capsys.readouterr().out
    assert channel._running is False


def test_parse_task_id():
    from channels.slack_channel import SlackChannel

    assert SlackChannel._parse_task_id("#42") == 42
    assert SlackChannel._parse_task_id(" 7 ") == 7
    assert SlackChannel._parse_task_id("nope") is None
    assert SlackChannel._parse_task_id("") is None


# ── task creation ────────────────────────────────────────────────


def test_create_task_submits_and_tracks_origin(monkeypatch):
    from channels import slack_channel

    monkeypatch.setattr(slack_channel, "_require_slack", lambda: None, raising=False)
    scheduler = StubScheduler()
    channel = _make_channel(scheduler=scheduler)

    with patch("channels.dir_utils.resolve_working_dir", return_value="~/myapp"):
        channel._handle_user_message("fix login bug", "C1", None, "100.1")

    assert len(scheduler.submitted) == 1
    task = scheduler.submitted[0]
    assert task.prompt == "fix login bug"
    assert task.title == "[Slack] fix login bug"
    assert task.tags == "slack"
    assert task.working_dir == "~/myapp"
    # origin tracked: (channel_id, thread_ts, reaction_ts)
    assert channel._task_origin[1] == ("C1", "100.1", "100.1")
    assert channel._thread_ts_map["100.1"] == 1


def test_empty_message_replies_help():
    channel = _make_channel()
    channel._handle_user_message("", "C1", None, "100.1")
    sent = channel._web_client.chat_postMessage.call_args.kwargs["text"]
    assert "AgentForge Bot" in sent


def test_help_command_and_word():
    channel = _make_channel()
    channel._handle_user_message("/help", "C1", None, "1.0")
    channel._handle_user_message("help", "C1", None, "2.0")
    texts = [c.kwargs["text"] for c in channel._web_client.chat_postMessage.call_args_list]
    assert all("AgentForge Bot" in t for t in texts)


def test_unknown_command_replies_help():
    channel = _make_channel()
    channel._handle_user_message("/bogus", "C1", None, "1.0")
    sent = channel._web_client.chat_postMessage.call_args.kwargs["text"]
    assert "AgentForge Bot" in sent


# ── commands ─────────────────────────────────────────────────────


def test_cmd_status_usage_and_not_found():
    channel = _make_channel()
    channel._cmd_status("", "C1", "1.0")
    assert "Usage" in channel._web_client.chat_postMessage.call_args.kwargs["text"]

    channel._cmd_status("99", "C1", "1.0")
    assert "not found" in channel._web_client.chat_postMessage.call_args.kwargs["text"]


def test_cmd_status_renders_task():
    db = StubDB()
    db.tasks[5] = {
        "id": 5,
        "title": "Build feature",
        "status": "completed",
        "created_at": "2026-01-01",
        "last_run_at": "2026-01-02",
        "result": "all green",
        "error": None,
    }
    channel = _make_channel(db=db)
    channel._cmd_status("#5", "C1", "1.0")
    text = channel._web_client.chat_postMessage.call_args.kwargs["text"]
    assert ":white_check_mark:" in text
    assert "Task #5" in text
    assert "Build feature" in text
    assert "all green" in text


def test_cmd_cancel_paths():
    db = StubDB()
    db.tasks[1] = {"id": 1, "title": "t", "status": "running"}
    db.tasks[2] = {"id": 2, "title": "t", "status": "completed"}
    channel = _make_channel(db=db)

    channel._cmd_cancel("", "C1", "1.0")
    assert "Usage" in channel._web_client.chat_postMessage.call_args.kwargs["text"]

    channel._cmd_cancel("99", "C1", "1.0")
    assert "not found" in channel._web_client.chat_postMessage.call_args.kwargs["text"]

    channel._cmd_cancel("2", "C1", "1.0")
    assert "already" in channel._web_client.chat_postMessage.call_args.kwargs["text"]

    channel._cmd_cancel("1", "C1", "1.0")
    assert db.updated[-1] == (1, {"status": "cancelled"})
    assert "cancelled" in channel._web_client.chat_postMessage.call_args.kwargs["text"]


def test_cmd_resume_paths():
    db = StubDB()
    db.tasks[1] = {"id": 1, "title": "t", "status": "completed", "session_id": "s1"}
    db.tasks[2] = {"id": 2, "title": "t", "status": "completed"}  # no session
    channel = _make_channel(db=db)

    channel._cmd_resume("", "C1", "1.0")
    assert "Usage" in channel._web_client.chat_postMessage.call_args.kwargs["text"]

    channel._cmd_resume("1", "C1", "1.0")
    assert "provide a message" in channel._web_client.chat_postMessage.call_args.kwargs["text"]

    channel._cmd_resume("2 keep going", "C1", "1.0")
    assert "no saved session" in channel._web_client.chat_postMessage.call_args.kwargs["text"]

    channel._cmd_resume("#1 keep going", "C1", "1.0")
    assert db.updated[-1][0] == 1
    assert db.updated[-1][1]["prompt"] == "keep going"
    assert db.updated[-1][1]["status"] == "pending"
    assert channel._task_origin[1] == ("C1", "1.0", "1.0")


def test_slash_command_dispatch_dir_and_agent():
    db = StubDB()
    channel = _make_channel(db=db)

    channel._handle_user_message("/dir ~/proj", "C1", None, "1.0")
    assert db.get_setting("slack_default_working_dir") == "~/proj"

    channel._handle_user_message("/agent codex", "C1", None, "2.0")
    assert db.get_setting("default_agent") == "codex"


# ── resume by thread reply ───────────────────────────────────────


def test_thread_reply_resumes_task():
    db = StubDB()
    db.tasks[8] = {"id": 8, "title": "t", "status": "completed", "session_id": "s8"}
    channel = _make_channel(db=db)
    channel._notification_map["root.1"] = 8

    channel._handle_user_message("continue please", "C1", "root.1", "200.1")

    assert db.updated[-1][0] == 8
    assert db.updated[-1][1]["prompt"] == "continue please"
    assert channel._task_origin[8] == ("C1", "root.1", "200.1")


def test_thread_reply_via_thread_ts_map():
    db = StubDB()
    db.tasks[9] = {"id": 9, "title": "t", "status": "completed", "session_id": "s9"}
    channel = _make_channel(db=db)
    channel._thread_ts_map["root.9"] = 9

    channel._handle_user_message("more work", "C1", "root.9", "300.1")
    assert db.updated[-1][0] == 9


def test_thread_reply_no_session_warns():
    db = StubDB()
    db.tasks[10] = {"id": 10, "title": "t", "status": "completed"}  # no session
    channel = _make_channel(db=db)
    channel._notification_map["root.10"] = 10

    channel._handle_user_message("go", "C1", "root.10", "400.1")
    assert db.updated == []
    assert "no saved session" in channel._web_client.chat_postMessage.call_args.kwargs["text"]


# ── event dispatch ───────────────────────────────────────────────


def test_handle_message_event_dm():
    db = StubDB()
    channel = _make_channel(db=db)
    with patch("channels.dir_utils.resolve_working_dir", return_value="~"):
        channel._handle_message_event(
            {
                "channel_type": "im",
                "user": "U1",
                "text": "do something",
                "channel": "D1",
                "ts": "10.1",
            }
        )
    assert len(channel.scheduler.submitted) == 1


def test_handle_message_event_skips_non_dm_and_bot():
    channel = _make_channel()
    channel._handle_message_event({"channel_type": "channel", "text": "x"})
    channel._handle_message_event({"channel_type": "im", "bot_id": "B1", "text": "x"})
    channel._handle_message_event(
        {"channel_type": "im", "user": "UBOT", "text": "x", "channel": "D1", "ts": "1"}
    )
    assert len(channel.scheduler.submitted) == 0


def test_handle_mention_event_strips_prefix():
    channel = _make_channel()
    with patch("channels.dir_utils.resolve_working_dir", return_value="~"):
        channel._handle_mention_event(
            {
                "user": "U1",
                "text": "<@UBOT> build the thing",
                "channel": "C9",
                "ts": "50.1",
            }
        )
    task = channel.scheduler.submitted[0]
    assert task.prompt == "build the thing"


def test_handle_mention_event_skips_bot():
    channel = _make_channel()
    channel._handle_mention_event({"bot_id": "B1", "text": "x"})
    channel._handle_mention_event({"user": "UBOT", "text": "x"})
    assert len(channel.scheduler.submitted) == 0


def test_app_home_opened_sends_help():
    channel = _make_channel()
    channel._web_client.conversations_open.return_value = {"channel": {"id": "D5"}}
    channel._handle_app_home_opened({"user": "U7", "tab": "home"})
    text = channel._web_client.chat_postMessage.call_args.kwargs["text"]
    assert "AgentForge Bot" in text


def test_app_home_opened_ignores_non_home_tab():
    channel = _make_channel()
    channel._handle_app_home_opened({"user": "U7", "tab": "messages"})
    channel._web_client.chat_postMessage.assert_not_called()


def test_handle_socket_request_dispatches_message():
    channel = _make_channel()
    client = MagicMock()

    class Req:
        type = "events_api"
        envelope_id = "envelope-1234567890"
        payload = {
            "event": {
                "type": "message",
                "channel_type": "im",
                "user": "U1",
                "text": "hello there",
                "channel": "D1",
                "ts": "9.9",
            }
        }

    with patch("channels.dir_utils.resolve_working_dir", return_value="~"):
        channel._handle_socket_request(client, Req())
    client.send_socket_mode_response.assert_called_once()
    assert len(channel.scheduler.submitted) == 1


def test_handle_socket_request_ignores_non_events_api():
    channel = _make_channel()
    client = MagicMock()

    class Req:
        type = "hello"
        envelope_id = "envelope-abcdefghijkl"
        payload = {}

    channel._handle_socket_request(client, Req())
    client.send_socket_mode_response.assert_called_once()
    assert len(channel.scheduler.submitted) == 0


# ── outbound send ────────────────────────────────────────────────


def _wait_threads():
    for t in threading.enumerate():
        if t is not threading.current_thread() and t.daemon:
            t.join(timeout=2)


def test_send_completion_to_origin():
    db = StubDB()
    channel = _make_channel(db=db)
    channel._task_origin[3] = ("C1", "100.1", "100.1")

    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=3,
            payload={"title": "Fix login", "result": "all done"},
        )
    )
    _wait_threads()
    # Reaction added + reply posted with the result text.
    react_names = [c.kwargs.get("name") for c in channel._web_client.reactions_add.call_args_list]
    assert "white_check_mark" in react_names
    posted = [c.kwargs["text"] for c in channel._web_client.chat_postMessage.call_args_list]
    assert any("all done" in t for t in posted)
    # Notification ts mapped to task and origin freed.
    assert channel._notification_map.get("1700.0001") == 3
    assert 3 not in channel._task_origin


def test_send_failure_to_origin_adds_x_reaction():
    db = StubDB()
    channel = _make_channel(db=db)
    channel._task_origin[4] = ("C1", "100.1", "100.1")

    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_FAILED,
            task_id=4,
            payload={"title": "Broke", "error": "boom"},
        )
    )
    _wait_threads()
    react_names = [c.kwargs.get("name") for c in channel._web_client.reactions_add.call_args_list]
    assert "x" in react_names
    posted = [c.kwargs["text"] for c in channel._web_client.chat_postMessage.call_args_list]
    assert any("boom" in t for t in posted)


def test_send_ignores_non_terminal_types():
    channel = _make_channel()
    channel.send(OutboundMessage(type=OutboundMessageType.TASK_STARTED, task_id=1, payload={}))
    channel._web_client.chat_postMessage.assert_not_called()


def test_send_fallback_to_default_channel():
    db = StubDB()
    db.settings["slack_default_channel"] = "C-DEFAULT"
    channel = _make_channel(db=db)

    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=11,
            payload={"title": "Job", "result": "ok"},
        )
    )
    _wait_threads()
    call = channel._web_client.chat_postMessage.call_args
    assert call.kwargs["channel"] == "C-DEFAULT"
    assert "Job" in call.kwargs["text"]


def test_send_fallback_to_dm_user():
    db = StubDB()
    db.settings["slack_default_user"] = "U-DM"
    channel = _make_channel(db=db)
    channel._web_client.conversations_open.return_value = {"channel": {"id": "D-DM"}}

    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=12,
            payload={"title": "Job", "result": "ok"},
        )
    )
    _wait_threads()
    call = channel._web_client.chat_postMessage.call_args
    assert call.kwargs["channel"] == "D-DM"


def test_send_no_origin_no_default_skips(capsys):
    channel = _make_channel()
    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=13,
            payload={"title": "Job", "result": "ok"},
        )
    )
    _wait_threads()
    channel._web_client.chat_postMessage.assert_not_called()


# ── low-level helpers ────────────────────────────────────────────


def test_open_dm_channel_caches():
    channel = _make_channel()
    channel._web_client.conversations_open.return_value = {"channel": {"id": "D1"}}
    assert channel._open_dm_channel("U1") == "D1"
    # Second call should hit the cache, not the API.
    channel._web_client.conversations_open.reset_mock()
    assert channel._open_dm_channel("U1") == "D1"
    channel._web_client.conversations_open.assert_not_called()


def test_open_dm_channel_handles_error():
    channel = _make_channel()
    channel._web_client.conversations_open.side_effect = RuntimeError("nope")
    assert channel._open_dm_channel("U2") is None


def test_reply_return_ts():
    channel = _make_channel()
    channel._web_client.chat_postMessage.return_value = {"ts": "999.1"}
    assert channel._reply_return_ts("C1", None, "hi") == "999.1"

    channel._web_client.chat_postMessage.side_effect = RuntimeError("fail")
    assert channel._reply_return_ts("C1", None, "hi") is None


def test_stop_unsubscribes():
    channel = _make_channel()
    channel._socket_client = MagicMock()
    channel.stop()
    assert channel._running is False
    channel._socket_client.disconnect.assert_called_once()
    assert channel._on_outbound not in channel.bus._outbound_listeners
