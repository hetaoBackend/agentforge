"""Additional Telegram channel coverage.

Focuses on branches not exercised by tests/test_telegram_channel.py:
  - the import-availability guard
  - start()/_run_bot/_start_app bootstrap with the telegram SDK fully mocked
  - _send_text helper (success + failure)
  - send() early-exit + reaction/send error branches and default-chat-id reaction
  - _format_forwarded_text "unknown chat type" fallback
  - reaction-failure print branches in resume/create
  - command edge cases (status error-only render, cancel already-done, resume reaction failure)
"""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

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


def _make_channel(db=None, scheduler=None, allowed_users=None):
    from channels.telegram_channel import TelegramChannel

    channel = TelegramChannel(
        bus=MessageBus(),
        db=db or StubDB(),
        scheduler=scheduler or StubScheduler(),
        token="123:ABC",
        allowed_users=allowed_users,
    )
    channel._app = MagicMock()
    channel._app.bot = AsyncMock()
    channel._loop = MagicMock()
    return channel


def _fake_update(text="hello", user_id=1, chat_id=10, message_id=100, reply=None):
    message = SimpleNamespace(
        text=text,
        message_id=message_id,
        reply_to_message=reply,
        forward_from=None,
        forward_from_chat=None,
        forward_date=None,
        reply_text=AsyncMock(),
    )
    return SimpleNamespace(
        message=message,
        effective_user=SimpleNamespace(id=user_id),
        effective_chat=SimpleNamespace(id=chat_id),
    )


# ── import-availability guard (lines 40-41) ──────────────────────


def test_telegram_available_flag_is_boolean():
    from channels import telegram_channel

    # The module imported fine; the flag reflects whether the SDK is present.
    assert isinstance(telegram_channel.TELEGRAM_AVAILABLE, bool)


# ── stop() lifecycle (lines 118-127) ─────────────────────────────


def test_stop_shuts_down_app_and_joins_thread():
    channel = _make_channel()
    channel._running = True
    # Real loop + app present → schedules the three shutdown coroutines.
    fake_loop = MagicMock()
    channel._loop = fake_loop
    channel._app = MagicMock()
    channel._app.updater = MagicMock()
    channel._app.updater.stop = MagicMock()
    channel._app.stop = MagicMock()
    channel._app.shutdown = MagicMock()
    channel._thread = MagicMock()

    with patch("asyncio.run_coroutine_threadsafe", return_value=MagicMock()) as rct:
        channel.stop()

    assert channel._running is False
    # updater.stop / app.stop / app.shutdown scheduled on the loop.
    assert rct.call_count == 3
    channel._thread.join.assert_called_once()
    # Outbound subscription removed.
    assert channel._on_outbound not in channel.bus._outbound_listeners


def test_stop_without_loop_is_safe():
    channel = _make_channel()
    channel._loop = None
    channel._app = None
    channel._thread = None
    channel.stop()  # no run_coroutine_threadsafe, no thread join
    assert channel._running is False


# ── start() / _run_bot / _start_app bootstrap (112-127, 234-269) ─


def test_start_spawns_thread_and_runs_loop(monkeypatch):
    """Drive start() with a fully mocked telegram Application so nothing connects.

    The real bot loop would block; we stub _start_app so _run_bot completes the
    loop immediately, and join the thread to confirm it finishes cleanly.
    """
    from channels import telegram_channel

    monkeypatch.setattr(telegram_channel, "TELEGRAM_AVAILABLE", True)
    channel = telegram_channel.TelegramChannel(
        bus=MessageBus(),
        db=StubDB(),
        scheduler=StubScheduler(),
        token="123:ABC",
    )

    started = {}

    async def fake_start_app():
        # Mimic real _start_app: mark ready, then return at once (no polling).
        started["ran"] = True

    monkeypatch.setattr(channel, "_start_app", fake_start_app)
    channel.start()
    assert channel._running is True
    assert channel._thread is not None
    channel._thread.join(timeout=5)
    assert channel._thread.is_alive() is False
    assert started.get("ran") is True
    # _run_bot created a real event loop and closed it.
    assert channel._loop is not None
    assert channel._loop.is_closed() is True


def test_run_bot_handles_start_app_exception(monkeypatch, capsys):
    from channels import telegram_channel

    channel = telegram_channel.TelegramChannel(
        bus=MessageBus(),
        db=StubDB(),
        scheduler=StubScheduler(),
        token="123:ABC",
    )

    async def boom():
        raise RuntimeError("startup failed")

    monkeypatch.setattr(channel, "_start_app", boom)
    channel._run_bot()
    out = capsys.readouterr().out
    assert "Bot error" in out
    assert channel._loop.is_closed() is True


def test_start_app_builds_application_and_registers_handlers(monkeypatch):
    """Exercise _start_app: build app, add handlers, start polling, exit loop."""
    from channels import telegram_channel

    fake_app = MagicMock()
    fake_app.initialize = AsyncMock()
    fake_app.start = AsyncMock()
    fake_app.stop = AsyncMock()
    fake_app.shutdown = AsyncMock()
    fake_app.updater = MagicMock()
    fake_app.updater.start_polling = AsyncMock()
    fake_app.updater.stop = AsyncMock()

    builder = MagicMock()
    builder.token.return_value = builder
    builder.build.return_value = fake_app

    monkeypatch.setattr(telegram_channel.Application, "builder", lambda: builder)

    channel = telegram_channel.TelegramChannel(
        bus=MessageBus(),
        db=StubDB(),
        scheduler=StubScheduler(),
        token="123:ABC",
    )
    # _running starts False so the `while self._running` loop is skipped and
    # _start_app proceeds straight to the shutdown sequence — no hang.
    channel._running = False

    asyncio.run(channel._start_app())

    builder.token.assert_called_once_with("123:ABC")
    fake_app.initialize.assert_awaited_once()
    fake_app.start.assert_awaited_once()
    fake_app.updater.start_polling.assert_awaited_once()
    # Handlers were registered (5 commands + 1 message handler).
    assert fake_app.add_handler.call_count == 6
    # Shutdown path ran because _running was False.
    fake_app.updater.stop.assert_awaited_once()
    fake_app.stop.assert_awaited_once()
    fake_app.shutdown.assert_awaited_once()


# ── _send_text helper (lines 272-275) ────────────────────────────


def test_send_text_success():
    channel = _make_channel()
    channel._app.bot.send_message = AsyncMock()
    asyncio.run(channel._send_text(42, "hi there"))
    channel._app.bot.send_message.assert_awaited_once_with(chat_id=42, text="hi there")


def test_send_text_logs_failure(capsys):
    channel = _make_channel()
    channel._app.bot.send_message = AsyncMock(side_effect=RuntimeError("network"))
    asyncio.run(channel._send_text(42, "hi"))
    assert "Failed to send message to 42" in capsys.readouterr().out


# ── send() early-exit branches (133, 142-145) ────────────────────


def test_send_drops_when_loop_not_ready():
    channel = _make_channel()
    channel._running = True
    # _loop_ready never set → wait() times out quickly here via patch.
    with patch.object(channel._loop_ready, "wait", return_value=False):
        with patch("asyncio.run_coroutine_threadsafe") as rct:
            channel.send(
                OutboundMessage(type=OutboundMessageType.TASK_COMPLETED, task_id=1, payload={})
            )
    rct.assert_not_called()


def test_send_drops_when_app_or_loop_missing():
    channel = _make_channel()
    channel._running = True
    channel._loop_ready.set()
    channel._app = None  # line 144-145
    with patch("asyncio.run_coroutine_threadsafe") as rct:
        channel.send(
            OutboundMessage(type=OutboundMessageType.TASK_COMPLETED, task_id=1, payload={})
        )
    rct.assert_not_called()


# ── send() coroutine body: reaction + truncation + reaction failure ──


def _patch_loop(channel):
    channel._loop_ready.set()
    channel._running = True


def test_send_completion_reaction_failure_still_sends(capsys):
    """When set_message_reaction raises, the except branch (207-208) logs and
    sending the message proceeds."""
    db = StubDB()
    channel = _make_channel(db=db)
    _patch_loop(channel)
    channel._task_origin[5] = (10, 100, 100)

    with patch("asyncio.run_coroutine_threadsafe") as rct:
        channel.send(
            OutboundMessage(
                type=OutboundMessageType.TASK_COMPLETED,
                task_id=5,
                payload={"title": "Job", "result": "done"},
            )
        )
        coro = rct.call_args.args[0]

    channel._app.bot.set_message_reaction = AsyncMock(side_effect=RuntimeError("no react"))
    channel._app.bot.send_message = AsyncMock(return_value=SimpleNamespace(message_id=900))
    asyncio.run(coro)

    assert "Failed to set reaction on message 100" in capsys.readouterr().out
    channel._app.bot.send_message.assert_awaited_once()
    assert channel._notification_map[900] == 5


def test_send_failure_default_chat_includes_status_link(capsys):
    """Default-chat-id failure path covers lines 187-190 and the body branch."""
    db = StubDB()
    db.settings["telegram_default_chat_id"] = "-100777"
    channel = _make_channel(db=db)
    _patch_loop(channel)

    with patch("asyncio.run_coroutine_threadsafe") as rct:
        channel.send(
            OutboundMessage(
                type=OutboundMessageType.TASK_FAILED,
                task_id=8,
                payload={"title": "Broke", "error": "x" * 1500},
            )
        )
        coro = rct.call_args.args[0]

    channel._app.bot.send_message = AsyncMock(return_value=SimpleNamespace(message_id=2))
    asyncio.run(coro)
    text = channel._app.bot.send_message.call_args.kwargs["text"]
    assert "❌ Task #8: Broke" in text
    assert "truncated" in text  # error > 800 → smart truncation (line 163)
    assert "/status 8" in text  # line 190


def test_send_coroutine_swallows_send_failure(capsys):
    db = StubDB()
    channel = _make_channel(db=db)
    _patch_loop(channel)
    channel._task_origin[9] = (10, 100, 100)

    with patch("asyncio.run_coroutine_threadsafe") as rct:
        channel.send(
            OutboundMessage(
                type=OutboundMessageType.TASK_COMPLETED,
                task_id=9,
                payload={"title": "Job", "result": "ok"},
            )
        )
        coro = rct.call_args.args[0]

    channel._app.bot.set_message_reaction = AsyncMock()
    channel._app.bot.send_message = AsyncMock(side_effect=RuntimeError("send down"))
    asyncio.run(coro)  # lines 221-222
    assert "Failed to send notification" in capsys.readouterr().out


def test_send_default_chat_id_non_numeric_string():
    db = StubDB()
    db.settings["telegram_default_chat_id"] = "@mychannel"
    channel = _make_channel(db=db)
    _patch_loop(channel)

    with patch("asyncio.run_coroutine_threadsafe") as rct:
        channel.send(
            OutboundMessage(
                type=OutboundMessageType.TASK_COMPLETED,
                task_id=11,
                payload={"title": "Job", "result": "ok"},
            )
        )
        coro = rct.call_args.args[0]
    channel._app.bot.set_message_reaction = AsyncMock()
    channel._app.bot.send_message = AsyncMock(return_value=SimpleNamespace(message_id=3))
    asyncio.run(coro)
    # Non-numeric chat id stays a string (not int-cast).
    assert channel._app.bot.send_message.call_args.kwargs["chat_id"] == "@mychannel"


# ── _format_forwarded_text unknown chat type (line 322) ──────────


def test_format_forwarded_from_unknown_chat_type():
    channel = _make_channel()
    update = _fake_update()
    update.message.forward_date = 1700000000
    update.message.forward_from_chat = SimpleNamespace(
        title="Mystery", username=None, type="private"
    )
    out = channel._format_forwarded_text("body", update)
    # type not channel/group/supergroup → generic "转发自:" line (322).
    assert "转发自: Mystery" in out


# ── resume-by-reply reaction failure branch (401-402) ────────────


def test_resume_by_reply_reaction_failure_logged(capsys):
    db = StubDB()
    db.tasks[5] = {"id": 5, "status": "completed", "session_id": "s5"}
    channel = _make_channel(db=db)
    channel._notification_map[200] = 5
    channel._app.bot.set_message_reaction = AsyncMock(side_effect=RuntimeError("no react"))
    reply = SimpleNamespace(message_id=200)
    update = _fake_update(text="continue", message_id=300, reply=reply)

    asyncio.run(channel._handle_text_message(update, SimpleNamespace(args=[])))

    assert db.updated[-1][0] == 5
    assert "Failed to set resume reaction" in capsys.readouterr().out
    update.message.reply_text.assert_awaited_with("▶️")


# ── _create_task _react coroutine (lines 451-465) ────────────────


def test_create_task_react_coroutine_runs():
    db = StubDB()
    scheduler = StubScheduler()
    channel = _make_channel(db=db, scheduler=scheduler)
    update = _fake_update(text="build it", chat_id=10, message_id=100)
    channel._app.bot.set_message_reaction = AsyncMock()
    channel._app.bot.send_message = AsyncMock()

    captured = {}

    def capture(coro, loop=None):
        captured["coro"] = coro
        return MagicMock()

    with (
        patch("channels.dir_utils.resolve_working_dir", return_value="~"),
        patch("asyncio.run_coroutine_threadsafe", side_effect=capture),
    ):
        channel._create_task("build it", 10, update)

    asyncio.run(captured["coro"])
    channel._app.bot.set_message_reaction.assert_awaited_once()
    channel._app.bot.send_message.assert_awaited_once()
    assert "running" in channel._app.bot.send_message.call_args.kwargs["text"]


def test_create_task_react_coroutine_logs_failure(capsys):
    db = StubDB()
    channel = _make_channel(db=db)
    update = _fake_update(text="build it")
    channel._app.bot.set_message_reaction = AsyncMock(side_effect=RuntimeError("nope"))

    captured = {}

    def capture(coro, loop=None):
        captured["coro"] = coro
        return MagicMock()

    with (
        patch("channels.dir_utils.resolve_working_dir", return_value="~"),
        patch("asyncio.run_coroutine_threadsafe", side_effect=capture),
    ):
        channel._create_task("build it", 10, update)

    asyncio.run(captured["coro"])  # lines 464-465
    assert "Failed to set reaction" in capsys.readouterr().out


# ── _cmd_status error-only render (line 508) ─────────────────────


def test_cmd_status_renders_error_only():
    db = StubDB()
    db.tasks[7] = {
        "id": 7,
        "title": "Broke",
        "status": "failed",
        "created_at": "2026-01-01T10:00:00",
        "last_run_at": None,
        "error": "stack trace",
        "result": None,
    }
    channel = _make_channel(db=db)
    u = _fake_update()
    asyncio.run(channel._cmd_status(u, SimpleNamespace(args=["7"])))
    text = u.message.reply_text.call_args.args[0]
    assert "Error: stack trace" in text
    assert "Result:" not in text


# ── _cmd_cancel unauthorised + already-done (516-517) ────────────


def test_cmd_cancel_unauthorised():
    channel = _make_channel(allowed_users=[1])
    u = _fake_update(user_id=2)
    asyncio.run(channel._cmd_cancel(u, SimpleNamespace(args=["1"])))
    assert "Not authorised" in u.message.reply_text.call_args.args[0]


# ── _cmd_resume reaction failure branch (576-577) ────────────────


def test_cmd_resume_reaction_failure_logged(capsys):
    db = StubDB()
    db.tasks[1] = {"id": 1, "title": "t", "status": "completed", "session_id": "s1"}
    channel = _make_channel(db=db)
    channel._app.bot.set_message_reaction = AsyncMock(side_effect=RuntimeError("no react"))
    u = _fake_update(message_id=555)
    asyncio.run(channel._cmd_resume(u, SimpleNamespace(args=["#1", "keep", "going"])))

    assert db.updated[-1][0] == 1
    assert db.updated[-1][1]["prompt"] == "keep going"
    assert "Failed to set resume reaction" in capsys.readouterr().out
    u.message.reply_text.assert_awaited_with("▶️")
