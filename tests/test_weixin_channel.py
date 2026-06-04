import io
import json

from taskboard_bus import MessageBus, OutboundMessage, OutboundMessageType


class StubDB:
    def __init__(self):
        self.settings = {}
        self.tasks = {}
        self.updated = []
        self.task_runs = {}
        self.run_output_events = {}

    def get_setting(self, key, default=None):
        return self.settings.get(key, default)

    def set_setting(self, key, value):
        self.settings[key] = value

    def get_task(self, task_id):
        return self.tasks.get(task_id)

    def update_task(self, task_id, **updates):
        self.updated.append((task_id, updates))
        self.tasks.setdefault(task_id, {"id": task_id}).update(updates)

    def get_task_runs(self, task_id, limit=20):
        return self.task_runs.get(task_id, [])[:limit]

    def get_run_output_events(self, run_id, limit=1000):
        return self.run_output_events.get(run_id, [])[:limit]


class StubScheduler:
    def __init__(self):
        self.submitted = []

    def submit_task(self, task):
        task_id = len(self.submitted) + 1
        self.submitted.append(task)
        return task_id


class FakeProcess:
    def __init__(self):
        self.stdin = io.StringIO()
        self.stdout = io.StringIO()
        self.terminated = False

    def poll(self):
        return None

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 0


def test_weixin_channel_creates_task_from_bridge_message():
    from channels.weixin_channel import WeixinChannel

    bus = MessageBus()
    db = StubDB()
    scheduler = StubScheduler()
    channel = WeixinChannel(bus=bus, db=db, scheduler=scheduler)

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-1",
            "context_token": "ctx-1",
            "message_id": "msg-1",
            "text": "请帮我修复登录问题",
        }
    )

    assert len(scheduler.submitted) == 1
    task = scheduler.submitted[0]
    assert task.prompt == "请帮我修复登录问题"
    assert task.tags == "weixin"
    assert task.title.startswith("[Weixin]")
    assert channel._task_origin[1]["peer_id"] == "user-1"
    assert channel._task_origin[1]["context_token"] == "ctx-1"


def test_weixin_channel_continues_current_peer_session_by_default():
    from channels.weixin_channel import WeixinChannel

    bus = MessageBus()
    db = StubDB()
    scheduler = StubScheduler()
    channel = WeixinChannel(bus=bus, db=db, scheduler=scheduler)

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-1",
            "context_token": "ctx-1",
            "message_id": "msg-1",
            "text": "先检查登录问题",
        }
    )
    db.tasks[1] = {"id": 1, "session_id": "sess-1", "status": "completed"}

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-1",
            "context_token": "ctx-2",
            "message_id": "msg-2",
            "text": "继续补测试",
        }
    )

    assert len(scheduler.submitted) == 1
    assert db.updated == [
        (
            1,
            {
                "status": "pending",
                "prompt": "继续补测试",
                "result": None,
                "error": None,
                "question": None,
            },
        )
    ]
    assert channel._task_origin[1]["message_id"] == "msg-2"
    assert channel._task_origin[1]["context_token"] == "ctx-2"


def test_weixin_channel_new_command_starts_fresh_peer_session():
    from channels.weixin_channel import WeixinChannel

    bus = MessageBus()
    db = StubDB()
    db.tasks[42] = {"id": 42, "session_id": "sess-42", "status": "completed"}
    scheduler = StubScheduler()
    channel = WeixinChannel(bus=bus, db=db, scheduler=scheduler)
    channel._peer_current_task["wx-1:user-1"] = 42

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-1",
            "context_token": "ctx-new",
            "message_id": "msg-new",
            "text": "/new 重新设计配置页",
        }
    )

    assert db.updated == []
    assert len(scheduler.submitted) == 1
    task = scheduler.submitted[0]
    assert task.prompt == "重新设计配置页"
    assert task.title.startswith("[Weixin]")
    assert channel._peer_current_task["wx-1:user-1"] == 1
    assert channel._task_origin[1]["message_id"] == "msg-new"


def test_weixin_channel_attaches_inbound_images_to_created_task(tmp_path):
    from channels.weixin_channel import WeixinChannel

    image_path = tmp_path / "inbound.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\nfakepng")
    bus = MessageBus()
    db = StubDB()
    scheduler = StubScheduler()
    channel = WeixinChannel(bus=bus, db=db, scheduler=scheduler)

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-img",
            "context_token": "ctx-img",
            "message_id": "msg-img",
            "text": "看图修一下 UI",
            "image_paths": [str(image_path)],
        }
    )

    assert len(scheduler.submitted) == 1
    task = scheduler.submitted[0]
    assert task.prompt == "看图修一下 UI"
    assert task.image_paths == [str(image_path)]
    assert len(task.prompt_images) == 1
    assert task.prompt_images[0]["name"] == "inbound.png"
    assert task.prompt_images[0]["media_type"] == "image/png"
    assert task.prompt_images[0]["data"]


def test_weixin_channel_image_only_resume_uses_default_prompt(tmp_path):
    from channels.weixin_channel import WeixinChannel

    image_path = tmp_path / "resume.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\nfakepng")
    bus = MessageBus()
    db = StubDB()
    db.tasks[7] = {"id": 7, "session_id": "sess-7", "status": "completed"}
    scheduler = StubScheduler()
    channel = WeixinChannel(bus=bus, db=db, scheduler=scheduler)
    channel._peer_current_task["wx-1:user-img"] = 7

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-img",
            "context_token": "ctx-img",
            "message_id": "msg-img",
            "text": "",
            "image_paths": [str(image_path)],
        }
    )

    assert len(scheduler.submitted) == 0
    assert db.updated[0][0] == 7
    updates = db.updated[0][1]
    assert updates["prompt"] == "请分析这张图片。"
    assert json.loads(updates["image_paths"]) == [str(image_path)]
    assert json.loads(updates["prompt_images"])[0]["media_type"] == "image/png"


def test_weixin_channel_sends_generated_images_to_bridge(tmp_path):
    from channels.weixin_channel import WeixinChannel

    image_path = tmp_path / "result.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\nresult")
    bus = MessageBus()
    db = StubDB()
    db.tasks[3] = {"id": 3, "working_dir": str(tmp_path)}
    db.task_runs[3] = [{"id": 30}]
    db.run_output_events[30] = [
        {
            "event_type": "generated_image",
            "content": json.dumps({"path": str(image_path), "media_type": "image/png"}),
        }
    ]
    scheduler = StubScheduler()
    channel = WeixinChannel(bus=bus, db=db, scheduler=scheduler)
    channel._running = True
    channel._bridge_proc = FakeProcess()
    channel._task_origin[3] = {
        "account_id": "wx-1",
        "peer_id": "user-3",
        "context_token": "ctx-3",
        "message_id": "msg-3",
    }

    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=3,
            payload={
                "title": "Generate image",
                "result": f"已生成 1 张图片：\n- {image_path}",
            },
        )
    )

    command = json.loads(channel._bridge_proc.stdin.getvalue().strip())
    assert command["type"] == "send_message"
    assert command["image_paths"] == [str(image_path)]
    assert str(image_path) not in command["text"]
    assert "已生成 1 张图片" in command["text"]


def test_weixin_channel_resumes_task_when_reply_matches_notification():
    from channels.weixin_channel import WeixinChannel

    bus = MessageBus()
    db = StubDB()
    db.tasks[7] = {"id": 7, "session_id": "sess-7", "status": "completed"}
    scheduler = StubScheduler()
    channel = WeixinChannel(bus=bus, db=db, scheduler=scheduler)
    channel._notification_map["notif-7"] = 7

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-1",
            "context_token": "ctx-2",
            "message_id": "msg-2",
            "reply_to_message_id": "notif-7",
            "text": "继续，并补上测试",
        }
    )

    assert db.updated == [
        (
            7,
            {
                "status": "pending",
                "prompt": "继续，并补上测试",
                "result": None,
                "error": None,
                "question": None,
            },
        )
    ]
    assert channel._task_origin[7]["message_id"] == "msg-2"
    assert channel._task_origin[7]["context_token"] == "ctx-2"
    commands = (
        [
            json.loads(line)
            for line in channel._bridge_proc.stdin.getvalue().splitlines()
            if line.strip()
        ]
        if channel._bridge_proc
        else []
    )
    if commands:
        assert commands[-1]["text"] == "▶️ 收到！正在唤醒 Task #7，请稍候～"


def test_weixin_channel_sends_outbound_notifications_to_bridge():
    from channels.weixin_channel import WeixinChannel

    bus = MessageBus()
    db = StubDB()
    scheduler = StubScheduler()
    channel = WeixinChannel(bus=bus, db=db, scheduler=scheduler)
    channel._running = True
    channel._bridge_proc = FakeProcess()
    channel._task_origin[3] = {
        "account_id": "wx-1",
        "peer_id": "user-3",
        "context_token": "ctx-3",
        "message_id": "msg-3",
    }

    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=3,
            payload={"title": "Fix login", "result": "修好了"},
        )
    )

    written = channel._bridge_proc.stdin.getvalue().strip()
    command = json.loads(written)
    assert command["type"] == "send_message"
    assert command["request_id"]
    assert command["peer_id"] == "user-3"
    assert command["context_token"] == "ctx-3"
    assert "Task #3" in command["text"]
    assert "修好了" in command["text"]

    channel._handle_bridge_event(
        {
            "type": "sent",
            "request_id": command["request_id"],
            "message_id": "wx-out-3",
        }
    )

    assert channel._notification_map["wx-out-3"] == 3


def test_weixin_channel_resumes_task_when_reply_matches_real_weixin_msg_id():
    from channels.weixin_channel import WeixinChannel

    bus = MessageBus()
    db = StubDB()
    db.tasks[9] = {"id": 9, "session_id": "sess-9", "status": "completed"}
    scheduler = StubScheduler()
    channel = WeixinChannel(bus=bus, db=db, scheduler=scheduler)
    channel._running = True
    channel._bridge_proc = FakeProcess()
    channel._task_origin[9] = {
        "account_id": "wx-1",
        "peer_id": "user-9",
        "context_token": "ctx-9",
        "message_id": "incoming-9",
    }

    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=9,
            payload={"title": "Fix resume", "result": "done"},
        )
    )

    command = json.loads(channel._bridge_proc.stdin.getvalue().strip())
    channel._handle_bridge_event(
        {
            "type": "sent",
            "request_id": command["request_id"],
            "message_id": command["request_id"],
            "quoted_message_id": "wx-real-msg-9",
        }
    )

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-9",
            "context_token": "ctx-9b",
            "message_id": "incoming-9b",
            "reply_to_message_id": "wx-real-msg-9",
            "text": "继续这个任务",
        }
    )

    assert db.updated == [
        (
            9,
            {
                "status": "pending",
                "prompt": "继续这个任务",
                "result": None,
                "error": None,
                "question": None,
            },
        )
    ]
    assert channel._task_origin[9]["message_id"] == "incoming-9b"
    assert channel._task_origin[9]["context_token"] == "ctx-9b"
    commands = [
        json.loads(line)
        for line in channel._bridge_proc.stdin.getvalue().splitlines()
        if line.strip()
    ]
    assert commands[-1]["text"] == "▶️ 收到！正在唤醒 Task #9，请稍候～"


def test_weixin_channel_resumes_task_when_reply_quotes_task_number_without_msg_id():
    from channels.weixin_channel import WeixinChannel

    bus = MessageBus()
    db = StubDB()
    db.tasks[11] = {"id": 11, "session_id": "sess-11", "status": "completed"}
    scheduler = StubScheduler()
    channel = WeixinChannel(bus=bus, db=db, scheduler=scheduler)

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-11",
            "context_token": "ctx-11b",
            "message_id": "incoming-11b",
            "reply_to_message_id": "",
            "reply_to_message_title": "✅ Task #11 · [Weixin] 你好",
            "reply_to_message_text": "Task #11 已完成",
            "text": "继续这个任务",
        }
    )

    assert db.updated == [
        (
            11,
            {
                "status": "pending",
                "prompt": "继续这个任务",
                "result": None,
                "error": None,
                "question": None,
            },
        )
    ]
    assert channel._task_origin[11]["message_id"] == "incoming-11b"
    assert channel._task_origin[11]["context_token"] == "ctx-11b"


def test_weixin_channel_tracks_qr_and_login_status_from_bridge_events():
    from channels.weixin_channel import WeixinChannel

    channel = WeixinChannel(bus=MessageBus(), db=StubDB(), scheduler=StubScheduler())

    channel._handle_bridge_event(
        {
            "type": "qr",
            "qrcode_url": "https://example.test/qr.png",
            "account_id": "wx-login",
        }
    )
    snapshot = channel.get_status_snapshot()
    assert snapshot["login_status"] == "waiting_for_scan"
    assert snapshot["qr_code_url"] == "https://example.test/qr.png"
    assert snapshot["account_id"] == "wx-login"

    channel._handle_bridge_event({"type": "scaned"})
    assert channel.get_status_snapshot()["login_status"] == "scanned"

    channel._handle_bridge_event(
        {
            "type": "login_success",
            "account_id": "wx-login",
            "user_id": "user-42",
        }
    )
    snapshot = channel.get_status_snapshot()
    assert snapshot["login_status"] == "connected"
    assert snapshot["qr_code_url"] == ""
    assert snapshot["configured"] is True
    assert snapshot["user_id"] == "user-42"


def test_weixin_channel_can_request_relogin_and_logout_via_bridge_commands():
    from channels.weixin_channel import WeixinChannel

    channel = WeixinChannel(bus=MessageBus(), db=StubDB(), scheduler=StubScheduler())
    channel._bridge_proc = FakeProcess()
    channel._running = True
    channel._handle_bridge_event(
        {
            "type": "login_success",
            "account_id": "wx-login",
            "user_id": "user-42",
        }
    )

    channel.request_login()
    channel.request_logout()

    commands = [
        json.loads(line)
        for line in channel._bridge_proc.stdin.getvalue().splitlines()
        if line.strip()
    ]
    assert commands[0]["type"] == "login"
    assert commands[1]["type"] == "logout"

    snapshot = channel.get_status_snapshot()
    assert snapshot["configured"] is False
    assert snapshot["login_status"] == "idle"
    assert snapshot["qr_code_url"] == ""
