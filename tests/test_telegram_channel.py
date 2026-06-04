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
    # Give it a fake app/loop so async helpers can run without a real bot.
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


def _ctx(args=None):
    return SimpleNamespace(args=args or [])


def _consume_coro(coro, loop=None):
    """Drain a coroutine scheduled via run_coroutine_threadsafe to avoid warnings."""
    coro.close()
    return MagicMock()


# ── construction / factory ───────────────────────────────────────


def test_init_sets_allowed_users():
    channel = _make_channel(allowed_users=[1, 2])
    assert channel._allowed_users == {1, 2}
    assert channel.name == "telegram"
    assert channel._on_outbound in channel.bus._outbound_listeners


def test_create_telegram_channel_no_token_returns_none(monkeypatch):
    from channels.telegram_channel import create_telegram_channel

    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    assert create_telegram_channel(StubDB(), StubScheduler(), token="") is None


def test_create_telegram_channel_parses_allowed_users():
    from channels.telegram_channel import create_telegram_channel

    channel = create_telegram_channel(
        StubDB(),
        StubScheduler(),
        token="123:ABC",
        allowed_users_str="10, 20 , bad, 30",
    )
    assert channel is not None
    assert channel._allowed_users == {10, 20, 30}


def test_create_telegram_channel_empty_allowed_users():
    from channels.telegram_channel import create_telegram_channel

    channel = create_telegram_channel(
        StubDB(), StubScheduler(), token="123:ABC", allowed_users_str=""
    )
    assert channel._allowed_users == set()


def test_create_telegram_channel_from_env(monkeypatch):
    from channels.telegram_channel import create_telegram_channel

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "999:ZZZ")
    monkeypatch.setenv("TELEGRAM_ALLOWED_USERS", "5,6")
    channel = create_telegram_channel(StubDB(), StubScheduler())
    assert channel is not None
    assert channel._token == "999:ZZZ"
    assert channel._allowed_users == {5, 6}


def test_create_telegram_channel_makes_bus_when_none():
    from channels.telegram_channel import create_telegram_channel

    channel = create_telegram_channel(StubDB(), StubScheduler(), token="123:ABC")
    assert channel.bus is not None


# ── allowed-user check ───────────────────────────────────────────


def test_is_allowed():
    open_channel = _make_channel()
    assert open_channel._is_allowed(999) is True  # no allowlist → all allowed

    restricted = _make_channel(allowed_users=[42])
    assert restricted._is_allowed(42) is True
    assert restricted._is_allowed(7) is False


# ── escape helper ────────────────────────────────────────────────


def test_escape_md():
    from channels.telegram_channel import _escape_md

    assert _escape_md("a.b-c!") == "a\\.b\\-c\\!"
    assert _escape_md("plain") == "plain"


# ── forwarded-message formatting ─────────────────────────────────


def test_format_forwarded_not_forwarded_returns_text():
    channel = _make_channel()
    update = _fake_update(text="just text")
    assert channel._format_forwarded_text("just text", update) == "just text"


def test_format_forwarded_from_user_with_username():
    channel = _make_channel()
    update = _fake_update()
    update.message.forward_from = SimpleNamespace(
        username="alice", first_name="Alice", last_name=None
    )
    update.message.forward_date = 1700000000
    out = channel._format_forwarded_text("body", update)
    assert "📨 [转发消息]" in out
    assert "转发自: @alice" in out
    assert "--- 转发内容 ---" in out
    assert out.endswith("body")
    assert "时间:" in out


def test_format_forwarded_from_user_without_username():
    channel = _make_channel()
    update = _fake_update()
    update.message.forward_from = SimpleNamespace(username=None, first_name="Bob", last_name="Lee")
    update.message.forward_date = None
    out = channel._format_forwarded_text("body", update)
    assert "转发自: Bob Lee" in out


def test_format_forwarded_from_channel_chat():
    channel = _make_channel()
    update = _fake_update()
    update.message.forward_from = None
    update.message.forward_date = 1700000000
    update.message.forward_from_chat = SimpleNamespace(
        title="News", username="news", type="channel"
    )
    out = channel._format_forwarded_text("body", update)
    assert "转发自频道: News" in out


def test_format_forwarded_from_group_chat():
    channel = _make_channel()
    update = _fake_update()
    update.message.forward_from = None
    update.message.forward_date = 1700000000
    update.message.forward_from_chat = SimpleNamespace(
        title="Devs", username=None, type="supergroup"
    )
    out = channel._format_forwarded_text("body", update)
    assert "转发自群组: Devs" in out


# ── text message handler ─────────────────────────────────────────


def test_handle_text_message_unauthorised():
    channel = _make_channel(allowed_users=[42])
    update = _fake_update(user_id=7)
    asyncio.run(channel._handle_text_message(update, _ctx()))
    update.message.reply_text.assert_awaited_once()
    assert "not authorised" in update.message.reply_text.call_args.args[0]


def test_handle_text_message_empty_ignored():
    channel = _make_channel()
    update = _fake_update(text="   ")
    asyncio.run(channel._handle_text_message(update, _ctx()))
    assert len(channel.scheduler.submitted) == 0
    update.message.reply_text.assert_not_awaited()


def test_handle_text_message_dir_command():
    db = StubDB()
    channel = _make_channel(db=db)
    update = _fake_update(text="/dir ~/proj")
    asyncio.run(channel._handle_text_message(update, _ctx()))
    assert db.get_setting("telegram_default_working_dir") == "~/proj"
    update.message.reply_text.assert_awaited_once()


def test_handle_text_message_agent_command():
    db = StubDB()
    channel = _make_channel(db=db)
    update = _fake_update(text="/agent codex")
    asyncio.run(channel._handle_text_message(update, _ctx()))
    assert db.get_setting("default_agent") == "codex"


def test_handle_text_message_creates_task():
    db = StubDB()
    scheduler = StubScheduler()
    channel = _make_channel(db=db, scheduler=scheduler)
    update = _fake_update(text="fix the bug")
    with (
        patch("channels.dir_utils.resolve_working_dir", return_value="~/app"),
        patch("asyncio.run_coroutine_threadsafe", side_effect=_consume_coro),
    ):
        asyncio.run(channel._handle_text_message(update, _ctx()))
    assert len(scheduler.submitted) == 1
    task = scheduler.submitted[0]
    assert task.prompt == "fix the bug"
    assert task.title == "[Telegram] fix the bug"
    assert task.tags == "telegram"
    assert task.working_dir == "~/app"
    assert channel._task_origin[1] == (10, 100, 100)


def test_handle_text_message_resume_by_reply():
    db = StubDB()
    db.tasks[5] = {"id": 5, "status": "completed", "session_id": "s5"}
    channel = _make_channel(db=db)
    channel._notification_map[200] = 5
    reply = SimpleNamespace(message_id=200)
    update = _fake_update(text="continue", message_id=300, reply=reply)
    asyncio.run(channel._handle_text_message(update, _ctx()))
    assert db.updated[-1][0] == 5
    assert db.updated[-1][1]["prompt"] == "continue"
    assert channel._task_origin[5] == (10, 300, 300)
    channel._app.bot.set_message_reaction.assert_awaited()
    update.message.reply_text.assert_awaited_with("▶️")


def test_handle_text_message_resume_no_session():
    db = StubDB()
    db.tasks[6] = {"id": 6, "status": "completed"}  # no session_id
    channel = _make_channel(db=db)
    channel._notification_map[201] = 6
    reply = SimpleNamespace(message_id=201)
    update = _fake_update(text="continue", reply=reply)
    asyncio.run(channel._handle_text_message(update, _ctx()))
    assert db.updated == []
    assert "no saved session" in update.message.reply_text.call_args.args[0]


def test_handle_text_message_reply_unknown_notification_creates_task():
    db = StubDB()
    scheduler = StubScheduler()
    channel = _make_channel(db=db, scheduler=scheduler)
    reply = SimpleNamespace(message_id=12345)  # not in notification_map
    update = _fake_update(text="new task", reply=reply)
    with (
        patch("channels.dir_utils.resolve_working_dir", return_value="~"),
        patch("asyncio.run_coroutine_threadsafe", side_effect=_consume_coro),
    ):
        asyncio.run(channel._handle_text_message(update, _ctx()))
    assert len(scheduler.submitted) == 1


def test_create_task_forwarded_tags():
    db = StubDB()
    scheduler = StubScheduler()
    channel = _make_channel(db=db, scheduler=scheduler)
    update = _fake_update(text="forwarded body")
    update.message.forward_date = 1700000000
    with (
        patch("channels.dir_utils.resolve_working_dir", return_value="~"),
        patch("asyncio.run_coroutine_threadsafe", side_effect=_consume_coro),
    ):
        channel._create_task("forwarded body", 10, update)
    task = scheduler.submitted[0]
    assert "forwarded" in task.tags
    assert task.title.startswith("[Telegram] 📨")


# ── command handlers ─────────────────────────────────────────────


def test_cmd_help_authorised_and_not():
    channel = _make_channel(allowed_users=[1])
    ok = _fake_update(user_id=1)
    asyncio.run(channel._cmd_help(ok, _ctx()))
    ok.message.reply_text.assert_awaited_once()

    denied = _fake_update(user_id=99)
    asyncio.run(channel._cmd_help(denied, _ctx()))
    assert "not authorised" in denied.message.reply_text.call_args.args[0]


def test_cmd_status_usage_and_not_found():
    db = StubDB()
    channel = _make_channel(db=db)
    u = _fake_update()
    asyncio.run(channel._cmd_status(u, _ctx(args=[])))
    assert "Usage" in u.message.reply_text.call_args.args[0]

    u2 = _fake_update()
    asyncio.run(channel._cmd_status(u2, _ctx(args=["99"])))
    assert "not found" in u2.message.reply_text.call_args.args[0]


def test_cmd_status_renders():
    db = StubDB()
    db.tasks[7] = {
        "id": 7,
        "title": "Build it",
        "status": "completed",
        "created_at": "2026-01-01T10:00:00",
        "last_run_at": "2026-01-02T11:00:00",
        "result": "green",
        "error": None,
    }
    channel = _make_channel(db=db)
    u = _fake_update()
    asyncio.run(channel._cmd_status(u, _ctx(args=["#7"])))
    text = u.message.reply_text.call_args.args[0]
    assert "✅" in text
    assert "Task #7" in text
    assert "green" in text


def test_cmd_status_unauthorised():
    channel = _make_channel(allowed_users=[1])
    u = _fake_update(user_id=2)
    asyncio.run(channel._cmd_status(u, _ctx(args=["1"])))
    assert "Not authorised" in u.message.reply_text.call_args.args[0]


def test_cmd_cancel_paths():
    db = StubDB()
    db.tasks[1] = {"id": 1, "title": "t", "status": "running"}
    db.tasks[2] = {"id": 2, "title": "t", "status": "completed"}
    channel = _make_channel(db=db)

    u = _fake_update()
    asyncio.run(channel._cmd_cancel(u, _ctx(args=[])))
    assert "Usage" in u.message.reply_text.call_args.args[0]

    u = _fake_update()
    asyncio.run(channel._cmd_cancel(u, _ctx(args=["99"])))
    assert "not found" in u.message.reply_text.call_args.args[0]

    u = _fake_update()
    asyncio.run(channel._cmd_cancel(u, _ctx(args=["2"])))
    assert "already" in u.message.reply_text.call_args.args[0]

    u = _fake_update()
    asyncio.run(channel._cmd_cancel(u, _ctx(args=["1"])))
    assert db.updated[-1] == (1, {"status": "cancelled"})
    assert "cancelled" in u.message.reply_text.call_args.args[0]


def test_cmd_resume_paths():
    db = StubDB()
    db.tasks[1] = {"id": 1, "title": "t", "status": "completed", "session_id": "s1"}
    db.tasks[2] = {"id": 2, "title": "t", "status": "completed"}
    channel = _make_channel(db=db)

    u = _fake_update()
    asyncio.run(channel._cmd_resume(u, _ctx(args=[])))
    assert "Usage" in u.message.reply_text.call_args.args[0]

    u = _fake_update()
    asyncio.run(channel._cmd_resume(u, _ctx(args=["1"])))
    assert "provide a message" in u.message.reply_text.call_args.args[0]

    u = _fake_update()
    asyncio.run(channel._cmd_resume(u, _ctx(args=["2", "go"])))
    assert "no saved session" in u.message.reply_text.call_args.args[0]

    u = _fake_update(message_id=555)
    asyncio.run(channel._cmd_resume(u, _ctx(args=["#1", "keep", "going"])))
    assert db.updated[-1][0] == 1
    assert db.updated[-1][1]["prompt"] == "keep going"
    assert channel._task_origin[1] == (10, 555, 555)
    u.message.reply_text.assert_awaited_with("▶️")


def test_cmd_resume_unauthorised():
    channel = _make_channel(allowed_users=[1])
    u = _fake_update(user_id=2)
    asyncio.run(channel._cmd_resume(u, _ctx(args=["1", "x"])))
    assert "Not authorised" in u.message.reply_text.call_args.args[0]


# ── outbound send ────────────────────────────────────────────────


def _patch_loop(channel):
    channel._loop_ready.set()
    channel._running = True


def test_send_completion_to_origin():
    db = StubDB()
    channel = _make_channel(db=db)
    _patch_loop(channel)
    channel._task_origin[3] = (10, 100, 100)

    with patch("asyncio.run_coroutine_threadsafe") as rct:
        channel.send(
            OutboundMessage(
                type=OutboundMessageType.TASK_COMPLETED,
                task_id=3,
                payload={"title": "Fix login", "result": "done"},
            )
        )
        coro = rct.call_args.args[0]
    sent = SimpleNamespace(message_id=777)
    channel._app.bot.send_message = AsyncMock(return_value=sent)
    asyncio.run(coro)

    channel._app.bot.send_message.assert_awaited_once()
    call = channel._app.bot.send_message.call_args
    assert "✅ Task #3: Fix login" in call.kwargs["text"]
    assert "done" in call.kwargs["text"]
    assert channel._notification_map[777] == 3
    assert 3 not in channel._task_origin


def test_send_failure_to_origin():
    db = StubDB()
    channel = _make_channel(db=db)
    _patch_loop(channel)
    channel._task_origin[4] = (10, 100, 100)

    with patch("asyncio.run_coroutine_threadsafe") as rct:
        channel.send(
            OutboundMessage(
                type=OutboundMessageType.TASK_FAILED,
                task_id=4,
                payload={"title": "Broke", "error": "boom"},
            )
        )
        coro = rct.call_args.args[0]
    channel._app.bot.send_message = AsyncMock(return_value=SimpleNamespace(message_id=1))
    asyncio.run(coro)
    text = channel._app.bot.send_message.call_args.kwargs["text"]
    assert "❌ Task #4: Broke" in text
    assert "boom" in text
    assert "/status 4" in text


def test_send_not_running_drops():
    channel = _make_channel()
    channel._running = False
    with patch("asyncio.run_coroutine_threadsafe") as rct:
        channel.send(
            OutboundMessage(type=OutboundMessageType.TASK_COMPLETED, task_id=1, payload={})
        )
    rct.assert_not_called()


def test_send_ignores_non_terminal():
    channel = _make_channel()
    _patch_loop(channel)
    with patch("asyncio.run_coroutine_threadsafe") as rct:
        channel.send(OutboundMessage(type=OutboundMessageType.TASK_STARTED, task_id=1, payload={}))
    rct.assert_not_called()


def test_send_uses_default_chat_id():
    db = StubDB()
    db.settings["telegram_default_chat_id"] = "-100123"
    channel = _make_channel(db=db)
    _patch_loop(channel)

    with patch("asyncio.run_coroutine_threadsafe") as rct:
        channel.send(
            OutboundMessage(
                type=OutboundMessageType.TASK_COMPLETED,
                task_id=8,
                payload={"title": "Job", "result": "ok"},
            )
        )
        coro = rct.call_args.args[0]
    channel._app.bot.send_message = AsyncMock(return_value=SimpleNamespace(message_id=2))
    asyncio.run(coro)
    assert channel._app.bot.send_message.call_args.kwargs["chat_id"] == -100123


def test_send_no_origin_no_default_skips():
    db = StubDB()
    channel = _make_channel(db=db)
    _patch_loop(channel)
    with patch("asyncio.run_coroutine_threadsafe") as rct:
        channel.send(
            OutboundMessage(
                type=OutboundMessageType.TASK_COMPLETED,
                task_id=9,
                payload={"title": "Job", "result": "ok"},
            )
        )
    rct.assert_not_called()


def test_send_truncates_long_result():
    db = StubDB()
    channel = _make_channel(db=db)
    _patch_loop(channel)
    channel._task_origin[10] = (10, 100, 100)
    long = "x" * 20000

    with patch("asyncio.run_coroutine_threadsafe") as rct:
        channel.send(
            OutboundMessage(
                type=OutboundMessageType.TASK_COMPLETED,
                task_id=10,
                payload={"title": "Big", "result": long},
            )
        )
        coro = rct.call_args.args[0]
    channel._app.bot.send_message = AsyncMock(return_value=SimpleNamespace(message_id=3))
    asyncio.run(coro)
    assert "(truncated)" in channel._app.bot.send_message.call_args.kwargs["text"]


# ── lifecycle ────────────────────────────────────────────────────


def test_start_without_telegram(monkeypatch, capsys):
    from channels import telegram_channel

    monkeypatch.setattr(telegram_channel, "TELEGRAM_AVAILABLE", False)
    channel = _make_channel()
    channel.start()
    assert "not installed" in capsys.readouterr().out
