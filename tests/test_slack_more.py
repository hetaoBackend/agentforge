"""Additional Slack channel coverage.

Focuses on branches not exercised by tests/test_slack_channel.py:
  - the _require_slack import guard (success + ImportError)
  - the start() / Socket Mode bootstrap (SDK fully mocked, no network)
  - _handle_socket_request error dispatch + unhandled event types
  - mention/app_home edge branches
  - send() default-channel fallback + reaction/reply error paths
  - low-level helper guards (no web client, postMessage failures)
"""

import sys
from types import SimpleNamespace
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

    channel = SlackChannel(
        bus=MessageBus(),
        db=db or StubDB(),
        scheduler=scheduler or StubScheduler(),
        bot_token="xoxb-test",
        app_token="xapp-test",
    )
    channel._web_client = MagicMock()
    channel._web_client.chat_postMessage.return_value = {"ts": "1700.0001"}
    channel._bot_user_id = "UBOT"
    return channel


# ── _require_slack import guard (lines 25-33) ────────────────────


def test_require_slack_returns_sdk_symbols():
    from channels.slack_channel import _require_slack

    WebClient, SocketModeClient, SocketModeResponse, SocketModeRequest = _require_slack()
    # The real slack_sdk is installed in this environment; just confirm callables.
    assert all(x is not None for x in (WebClient, SocketModeClient))
    assert SocketModeResponse is not None
    assert SocketModeRequest is not None


def test_require_slack_raises_on_missing_dependency(monkeypatch):
    from channels.slack_channel import _require_slack

    # Hide the slack_sdk package so the import inside _require_slack fails.
    for mod in list(sys.modules):
        if mod == "slack_sdk" or mod.startswith("slack_sdk."):
            monkeypatch.delitem(sys.modules, mod, raising=False)
    monkeypatch.setitem(sys.modules, "slack_sdk", None)

    try:
        _require_slack()
        raise AssertionError("expected ImportError")
    except ImportError as e:
        assert "slack-sdk is required" in str(e)


# ── start() Socket Mode bootstrap (lines 112-144) ────────────────


def _install_fake_slack_sdk(monkeypatch, *, auth_raises=False):
    """Build a stand-in slack_sdk so start() runs without a real connection."""
    web_instances = []

    class FakeWebClient:
        def __init__(self, token=None):
            self.token = token
            self._auth_raises = auth_raises
            web_instances.append(self)

        def auth_test(self):
            if self._auth_raises:
                raise RuntimeError("bad token")
            return {"user_id": "UBOT99", "team": "T1", "user": "agentbot"}

    class FakeSocketModeClient:
        def __init__(self, app_token=None, web_client=None):
            self.app_token = app_token
            self.web_client = web_client
            self.socket_mode_request_listeners = []
            self.connected = False

        def connect(self):
            # No-op: never opens a real socket, returns immediately.
            self.connected = True

        def disconnect(self):
            self.connected = False

    fake = SimpleNamespace(
        WebClient=FakeWebClient,
        SocketModeClient=FakeSocketModeClient,
        SocketModeResponse=MagicMock(),
        SocketModeRequest=MagicMock(),
    )
    from channels import slack_channel

    monkeypatch.setattr(
        slack_channel,
        "_require_slack",
        lambda: (
            fake.WebClient,
            fake.SocketModeClient,
            fake.SocketModeResponse,
            fake.SocketModeRequest,
        ),
    )
    return fake


def test_start_bootstraps_socket_mode(monkeypatch):
    from channels.slack_channel import SlackChannel

    _install_fake_slack_sdk(monkeypatch)
    channel = SlackChannel(
        bus=MessageBus(),
        db=StubDB(),
        scheduler=StubScheduler(),
        bot_token="xoxb-real",
        app_token="xapp-real",
    )
    channel.start()

    assert channel._running is True
    assert channel._bot_user_id == "UBOT99"
    # Connected (no real network) and our listener registered.
    assert channel._socket_client.connected is True
    assert channel._handle_socket_request in channel._socket_client.socket_mode_request_listeners


def test_start_aborts_when_auth_test_fails(monkeypatch):
    from channels.slack_channel import SlackChannel

    _install_fake_slack_sdk(monkeypatch, auth_raises=True)
    channel = SlackChannel(
        bus=MessageBus(),
        db=StubDB(),
        scheduler=StubScheduler(),
        bot_token="xoxb-real",
        app_token="xapp-real",
    )
    channel.start()

    # auth_test failed → bootstrap returns before creating the socket client.
    assert channel._bot_user_id is None
    assert channel._socket_client is None


# ── _handle_socket_request dispatch branches (lines 192-200) ─────


def test_socket_request_dispatches_mention(monkeypatch):
    channel = _make_channel()
    client = MagicMock()

    class Req:
        type = "events_api"
        envelope_id = "envelope-mention-1"
        payload = {
            "event": {
                "type": "app_mention",
                "user": "U1",
                "text": "<@UBOT> do the thing",
                "channel": "C1",
                "ts": "1.0",
            }
        }

    with patch("channels.dir_utils.resolve_working_dir", return_value="~"):
        channel._handle_socket_request(client, Req())
    assert len(channel.scheduler.submitted) == 1
    assert channel.scheduler.submitted[0].prompt == "do the thing"


def test_socket_request_dispatches_app_home_opened():
    channel = _make_channel()
    channel._web_client.conversations_open.return_value = {"channel": {"id": "D9"}}
    client = MagicMock()

    class Req:
        type = "events_api"
        envelope_id = "envelope-home-12345"
        payload = {"event": {"type": "app_home_opened", "user": "U2", "tab": "home"}}

    channel._handle_socket_request(client, Req())
    text = channel._web_client.chat_postMessage.call_args.kwargs["text"]
    assert "AgentForge Bot" in text


def test_socket_request_unhandled_event_type():
    channel = _make_channel()
    client = MagicMock()

    class Req:
        type = "events_api"
        envelope_id = "envelope-unknown-99"
        payload = {"event": {"type": "reaction_added"}}

    channel._handle_socket_request(client, Req())
    client.send_socket_mode_response.assert_called_once()
    assert len(channel.scheduler.submitted) == 0


def test_socket_request_swallows_handler_exception():
    channel = _make_channel()
    client = MagicMock()

    class Req:
        type = "events_api"
        envelope_id = "envelope-boom-123"
        payload = {"event": {"type": "message", "channel_type": "im"}}

    # Force the message handler to blow up so the except branch (198-200) runs.
    with patch.object(channel, "_handle_message_event", side_effect=RuntimeError("kaboom")):
        channel._handle_socket_request(client, Req())
    # Ack still sent; exception is caught, not propagated.
    client.send_socket_mode_response.assert_called_once()


# ── message/mention strip-prefix branches (245->250, 247->250, 263, 273) ──


def test_mention_without_prefix_keeps_text():
    channel = _make_channel()
    with patch("channels.dir_utils.resolve_working_dir", return_value="~"):
        # No leading "<@UBOT>" so the strip branch is skipped.
        channel._handle_mention_event(
            {"user": "U1", "text": "just build it", "channel": "C1", "ts": "2.0"}
        )
    assert channel.scheduler.submitted[0].prompt == "just build it"


def test_mention_when_bot_user_id_unset():
    channel = _make_channel()
    channel._bot_user_id = None  # skip the "if self._bot_user_id" strip block
    with patch("channels.dir_utils.resolve_working_dir", return_value="~"):
        channel._handle_mention_event(
            {"user": "U1", "text": "<@UX> hi", "channel": "C1", "ts": "3.0"}
        )
    assert channel.scheduler.submitted[0].prompt == "<@UX> hi"


def test_app_home_opened_ignores_self_and_empty_user():
    channel = _make_channel()
    channel._handle_app_home_opened({"user": "UBOT", "tab": "home"})  # self
    channel._handle_app_home_opened({"user": "", "tab": "home"})  # empty
    channel._web_client.chat_postMessage.assert_not_called()


def test_app_home_opened_dm_open_fails(capsys):
    channel = _make_channel()
    channel._web_client.conversations_open.side_effect = RuntimeError("nope")
    channel._handle_app_home_opened({"user": "U7", "tab": "home"})
    # _open_dm_channel returned None → the else branch (273) logs a failure.
    assert "Failed to open DM channel" in capsys.readouterr().out
    channel._web_client.chat_postMessage.assert_not_called()


# ── _cmd_status error/result rendering (418, 419->422) ───────────


def test_cmd_status_renders_error_only():
    db = StubDB()
    db.tasks[3] = {
        "id": 3,
        "title": "Broke",
        "status": "failed",
        "created_at": "2026-01-01",
        "last_run_at": None,
        "error": "stack trace here",
        "result": None,
    }
    channel = _make_channel(db=db)
    channel._cmd_status("#3", "C1", "1.0")
    text = channel._web_client.chat_postMessage.call_args.kwargs["text"]
    assert "Error:" in text
    assert "stack trace here" in text
    assert "Result:" not in text


# ── send() default-channel fallback message format (line 550) ────


def test_send_default_channel_failure_prefixes_x_emoji():
    db = StubDB()
    db.settings["slack_default_channel"] = "C-DEF"
    channel = _make_channel(db=db)

    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_FAILED,
            task_id=21,
            payload={"title": "Job", "error": "broke"},
        )
    )
    # _send_and_track runs in a thread; drain it.
    import threading

    for t in threading.enumerate():
        if t is not threading.current_thread() and t.daemon:
            t.join(timeout=2)

    call = channel._web_client.chat_postMessage.call_args
    assert call.kwargs["channel"] == "C-DEF"
    assert ":x:" in call.kwargs["text"]
    assert "broke" in call.kwargs["text"]
    # The sent ts was tracked back to the task.
    assert channel._notification_map.get("1700.0001") == 21


def test_send_dm_fallback_fails_to_open_skips(capsys):
    db = StubDB()
    db.settings["slack_default_user"] = "U-DM"
    channel = _make_channel(db=db)
    channel._web_client.conversations_open.side_effect = RuntimeError("denied")

    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=22,
            payload={"title": "Job", "result": "ok"},
        )
    )
    import threading

    for t in threading.enumerate():
        if t is not threading.current_thread() and t.daemon:
            t.join(timeout=2)

    out = capsys.readouterr().out
    assert "Failed to open DM" in out
    channel._web_client.chat_postMessage.assert_not_called()


# ── _on_outbound passthrough (line 563) ──────────────────────────


def test_on_outbound_delegates_to_send():
    channel = _make_channel()
    with patch.object(channel, "send") as send:
        msg = OutboundMessage(type=OutboundMessageType.TASK_STARTED, task_id=1, payload={})
        channel._on_outbound(msg)
    send.assert_called_once_with(msg)


# ── helper no-web-client / failure guards ────────────────────────


def test_open_dm_channel_returns_none_without_web_client():
    channel = _make_channel()
    channel._web_client = None  # line 572
    assert channel._open_dm_channel("U1") is None


def test_add_reaction_noop_without_web_client():
    channel = _make_channel()
    channel._web_client = None  # line 586
    # Should simply return without spawning a thread or raising.
    channel._add_reaction("C1", "1.0", "eyes")


def test_add_reaction_handles_already_reacted_and_errors():
    channel = _make_channel()

    # already_reacted is swallowed silently (lines 596-597).
    channel._web_client.reactions_add.side_effect = RuntimeError("already_reacted")
    channel._add_reaction("C1", "1.0", "eyes")

    # other errors are logged (lines 598-599).
    channel._web_client.reactions_add.side_effect = RuntimeError("rate_limited")
    channel._add_reaction("C1", "1.0", "eyes")

    import threading

    for t in threading.enumerate():
        if t is not threading.current_thread() and t.daemon:
            t.join(timeout=2)
    assert channel._web_client.reactions_add.call_count == 2


def test_reply_skips_without_web_client(capsys):
    channel = _make_channel()
    channel._web_client = None  # lines 605-606
    channel._reply("C1", None, "hi")
    assert "no web_client" in capsys.readouterr().out


def test_reply_logs_postmessage_failure(capsys):
    channel = _make_channel()
    channel._web_client.chat_postMessage.side_effect = RuntimeError("api down")
    channel._reply("C1", None, "hi")  # lines 618-620
    assert "chat_postMessage FAILED" in capsys.readouterr().out


def test_reply_return_ts_none_without_web_client():
    channel = _make_channel()
    channel._web_client = None  # line 627
    assert channel._reply_return_ts("C1", None, "hi") is None
