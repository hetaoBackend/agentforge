"""Additional coverage for channels/weixin_channel.py.

These tests target branches not already covered by test_weixin_channel.py:
constructor/start/stop, the bridge reader, dir/agent command replies, the
/new-with-no-content path, the resume-without-session error, image media-type
sniffing, markdown image reference parsing, generated-image collection error
branches, and the path-hiding renderer.
"""

import io
import json
from unittest import mock

from taskboard_bus import MessageBus, OutboundMessage, OutboundMessageType


class StubDB:
    def __init__(self):
        self.settings = {}
        self.tasks = {}
        self.updated = []
        self.task_runs = {}
        self.run_output_events = {}
        self.runs_error = None
        self.events_error = None

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
        if self.runs_error is not None:
            raise self.runs_error
        return self.task_runs.get(task_id, [])[:limit]

    def get_run_output_events(self, run_id, limit=1000):
        if self.events_error is not None:
            raise self.events_error
        return self.run_output_events.get(run_id, [])[:limit]


class StubScheduler:
    def __init__(self):
        self.submitted = []

    def submit_task(self, task):
        task_id = len(self.submitted) + 1
        self.submitted.append(task)
        return task_id


class FakeProcess:
    def __init__(self, alive=True):
        self.stdin = io.StringIO()
        self.stdout = io.StringIO()
        self.terminated = False
        self.waited = False
        self._alive = alive

    def poll(self):
        return None if self._alive else 0

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        self.waited = True
        return 0


def _make_channel():
    from channels.weixin_channel import WeixinChannel

    return WeixinChannel(bus=MessageBus(), db=StubDB(), scheduler=StubScheduler())


# ── constructor / default bridge command ──────────────────────────────────


def test_default_bridge_cmd_points_at_index_mjs():
    channel = _make_channel()
    cmd = channel._default_bridge_cmd()
    # cmd[0] is now a resolved node path (or bare "node" when none is found)
    assert cmd[0] == "node" or cmd[0].endswith("/node")
    assert cmd[1].endswith("weixin_bridge/index.mjs")


def test_default_bridge_cmd_resolves_full_node_path(monkeypatch):
    channel = _make_channel()
    monkeypatch.setattr("channels.weixin_channel.shutil.which", lambda exe: "/fake/bin/node")
    cmd = channel._default_bridge_cmd()
    assert cmd[0] == "/fake/bin/node"
    assert cmd[1].endswith("weixin_bridge/index.mjs")


def test_default_bridge_cmd_falls_back_to_homebrew_when_node_not_on_path(monkeypatch):
    """macOS GUI-launched apps inherit a minimal PATH without Homebrew, so
    `shutil.which("node")` misses — we must fall back to common install dirs."""
    channel = _make_channel()
    monkeypatch.setattr("channels.weixin_channel.shutil.which", lambda exe: None)
    monkeypatch.setattr(
        "channels.weixin_channel.os.path.exists",
        lambda p: p == "/opt/homebrew/bin/node",
    )
    cmd = channel._default_bridge_cmd()
    assert cmd[0] == "/opt/homebrew/bin/node"


def test_bridge_script_path_uses_meipass_when_frozen(monkeypatch):
    """In the PyInstaller bundle the bridge lives under sys._MEIPASS, not next
    to the (frozen) source module."""
    channel = _make_channel()
    monkeypatch.setattr("channels.weixin_channel.sys.frozen", True, raising=False)
    monkeypatch.setattr("channels.weixin_channel.sys._MEIPASS", "/tmp/meipass", raising=False)
    path = channel._bridge_script_path()
    assert str(path) == "/tmp/meipass/channels/weixin_bridge/index.mjs"


def test_start_surfaces_missing_node_as_error_status(monkeypatch):
    """When node is genuinely absent, Popen raises FileNotFoundError. Instead of
    silently failing (blank QR), the channel must report an error status."""
    channel = _make_channel()

    def no_node(cmd, **kwargs):
        raise FileNotFoundError("node")

    monkeypatch.setattr("channels.weixin_channel.subprocess.Popen", no_node)
    channel.start()
    assert channel._running is False
    assert channel._bridge_proc is None
    snap = channel.get_status_snapshot()
    assert snap["login_status"] == "error"
    assert "Node" in (snap["last_error"] or "")


def test_explicit_bridge_cmd_overrides_default():
    from channels.weixin_channel import WeixinChannel

    channel = WeixinChannel(
        bus=MessageBus(),
        db=StubDB(),
        scheduler=StubScheduler(),
        bridge_cmd=["custom", "bridge"],
    )
    assert channel.bridge_cmd == ["custom", "bridge"]


# ── start() / stop() ───────────────────────────────────────────────────────


def test_start_spawns_bridge_and_reader(monkeypatch):
    channel = _make_channel()
    channel.db.settings["weixin_account_id"] = "wx-acct"

    fake_proc = FakeProcess()
    fake_proc.stdout = io.StringIO("")  # reader exits immediately
    popen_calls = {}

    def fake_popen(cmd, **kwargs):
        popen_calls["cmd"] = cmd
        popen_calls["env"] = kwargs.get("env")
        return fake_proc

    monkeypatch.setattr("channels.weixin_channel.subprocess.Popen", fake_popen)

    channel.start()
    assert channel._running is True
    assert channel._bridge_proc is fake_proc
    assert popen_calls["env"]["AGENTFORGE_WEIXIN_ACCOUNT_ID"] == "wx-acct"
    if channel._reader_thread:
        channel._reader_thread.join(timeout=2)


def test_start_handles_popen_failure(monkeypatch):
    channel = _make_channel()

    def boom(cmd, **kwargs):
        raise OSError("node not found")

    monkeypatch.setattr("channels.weixin_channel.subprocess.Popen", boom)

    channel.start()
    assert channel._running is False
    assert channel._bridge_proc is None


def test_stop_terminates_live_bridge():
    channel = _make_channel()
    channel._running = True
    proc = FakeProcess(alive=True)
    channel._bridge_proc = proc

    channel.stop()

    assert channel._running is False
    assert proc.terminated is True
    assert proc.waited is True
    assert channel._bridge_proc is None


def test_stop_with_dead_bridge_does_not_terminate():
    channel = _make_channel()
    channel._running = True
    proc = FakeProcess(alive=False)
    channel._bridge_proc = proc

    channel.stop()

    assert proc.terminated is False
    assert channel._bridge_proc is None


def test_stop_swallows_terminate_exception():
    channel = _make_channel()
    channel._running = True
    proc = FakeProcess(alive=True)
    proc.terminate = mock.Mock(side_effect=RuntimeError("boom"))
    channel._bridge_proc = proc

    channel.stop()  # should not raise
    assert channel._bridge_proc is None


# ── _read_bridge_events ────────────────────────────────────────────────────


def test_read_bridge_events_dispatches_and_skips_garbage():
    channel = _make_channel()
    channel._running = True
    proc = FakeProcess()
    proc.stdout = io.StringIO(
        "\n"  # blank line skipped
        "not-json\n"  # JSONDecodeError branch
        '{"type": "scaned"}\n'  # valid event dispatched
    )
    channel._bridge_proc = proc

    channel._read_bridge_events()

    assert channel.get_status_snapshot()["login_status"] == "scanned"


def test_read_bridge_events_returns_when_no_proc():
    channel = _make_channel()
    channel._bridge_proc = None
    # Should simply return without error.
    channel._read_bridge_events()


def test_read_bridge_events_stops_when_not_running():
    channel = _make_channel()
    channel._running = False
    proc = FakeProcess()
    proc.stdout = io.StringIO('{"type": "scaned"}\n')
    channel._bridge_proc = proc

    channel._read_bridge_events()
    # Not running, so the event was not handled.
    assert channel.get_status_snapshot()["login_status"] == "idle"


# ── ready / error bridge events ────────────────────────────────────────────


def test_ready_event_marks_connected():
    channel = _make_channel()
    channel._handle_bridge_event({"type": "ready", "account_id": "wx-ready"})
    snap = channel.get_status_snapshot()
    assert snap["login_status"] == "connected"
    assert snap["configured"] is True
    assert snap["account_id"] == "wx-ready"


def test_error_event_records_last_error():
    channel = _make_channel()
    channel._handle_bridge_event({"type": "error", "message": "kaboom"})
    snap = channel.get_status_snapshot()
    assert snap["login_status"] == "error"
    assert snap["last_error"] == "kaboom"


# ── dir / agent command replies ────────────────────────────────────────────


def test_dir_command_reply_short_circuits(monkeypatch):
    channel = _make_channel()
    channel._bridge_proc = FakeProcess()
    channel._running = True
    monkeypatch.setattr(
        "channels.dir_utils.handle_dir_command",
        lambda text, key, db: "dir reply",
    )

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-d",
            "message_id": "m-d",
            "text": "/dir",
        }
    )

    assert channel.scheduler.submitted == []
    sent = json.loads(channel._bridge_proc.stdin.getvalue().strip())
    assert sent["text"] == "dir reply"


def test_agent_command_reply_short_circuits(monkeypatch):
    channel = _make_channel()
    channel._bridge_proc = FakeProcess()
    channel._running = True
    monkeypatch.setattr(
        "channels.agent_utils.handle_agent_command",
        lambda text, key, db: "agent reply",
    )

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-a",
            "message_id": "m-a",
            "text": "/agent",
        }
    )

    assert channel.scheduler.submitted == []
    sent = json.loads(channel._bridge_proc.stdin.getvalue().strip())
    assert sent["text"] == "agent reply"


# ── message edge cases ─────────────────────────────────────────────────────


def test_empty_message_with_no_images_is_ignored():
    channel = _make_channel()
    channel._handle_bridge_event({"type": "message", "peer_id": "user-x", "text": "   "})
    assert channel.scheduler.submitted == []


def test_new_command_without_content_prompts_for_task():
    channel = _make_channel()
    channel._bridge_proc = FakeProcess()
    channel._running = True

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-n",
            "message_id": "m-n",
            "text": "/new",
        }
    )

    assert channel.scheduler.submitted == []
    sent = json.loads(channel._bridge_proc.stdin.getvalue().strip())
    assert "已开启新的 Weixin session" in sent["text"]


def test_resume_target_without_session_replies_error():
    channel = _make_channel()
    channel._bridge_proc = FakeProcess()
    channel._running = True
    # Task exists but has no session_id, referenced by reply title.
    channel.db.tasks[5] = {"id": 5, "status": "completed"}

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-r",
            "message_id": "m-r",
            "reply_to_message_title": "Task #5",
            "text": "继续",
        }
    )

    assert channel.scheduler.submitted == []
    assert channel.db.updated == []
    sent = json.loads(channel._bridge_proc.stdin.getvalue().strip())
    assert "no saved session to resume" in sent["text"]


def test_reply_to_event_without_peer_is_noop():
    channel = _make_channel()
    channel._bridge_proc = FakeProcess()
    channel._running = True
    channel._reply_to_event({"text": "hi"}, "nothing")
    assert channel._bridge_proc.stdin.getvalue() == ""


# ── _extract_image_paths with images list ──────────────────────────────────


def test_extract_image_paths_from_images_list(tmp_path):
    channel = _make_channel()
    img = tmp_path / "a.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\nx")
    paths = channel._extract_image_paths(
        {
            "images": [
                {"path": str(img)},
                {"local_path": str(img)},  # dedup
                "not-a-dict",
                {"no_path": "x"},
            ]
        }
    )
    assert paths == [str(img.resolve())]


# ── _image_media_type header sniffing ──────────────────────────────────────


def test_image_media_type_by_extension():
    channel = _make_channel()
    assert channel._image_media_type("/x/a.PNG") == "image/png"
    assert channel._image_media_type("/x/a.jpg") == "image/jpeg"
    assert channel._image_media_type("/x/a.jpeg") == "image/jpeg"
    assert channel._image_media_type("/x/a.gif") == "image/gif"
    assert channel._image_media_type("/x/a.webp") == "image/webp"


def test_image_media_type_sniffs_header(tmp_path):
    channel = _make_channel()

    png = tmp_path / "noext_png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 4)
    assert channel._image_media_type(str(png)) == "image/png"

    jpg = tmp_path / "noext_jpg"
    jpg.write_bytes(b"\xff\xd8\xff" + b"0" * 9)
    assert channel._image_media_type(str(jpg)) == "image/jpeg"

    gif = tmp_path / "noext_gif"
    gif.write_bytes(b"GIF89a" + b"0" * 6)
    assert channel._image_media_type(str(gif)) == "image/gif"

    webp = tmp_path / "noext_webp"
    webp.write_bytes(b"RIFF0000WEBP")
    assert channel._image_media_type(str(webp)) == "image/webp"

    unknown = tmp_path / "noext_bin"
    unknown.write_bytes(b"\x00\x01\x02\x03" + b"0" * 8)
    assert channel._image_media_type(str(unknown)) == "image/jpeg"


def test_image_media_type_missing_file_defaults_jpeg():
    channel = _make_channel()
    assert channel._image_media_type("/nonexistent/no_ext_file") == "image/jpeg"


def test_build_prompt_images_skips_unreadable(tmp_path):
    channel = _make_channel()
    good = tmp_path / "good.png"
    good.write_bytes(b"\x89PNG\r\n\x1a\nx")
    images = channel._build_prompt_images([str(good), "/nope/missing.png"])
    assert len(images) == 1
    assert images[0]["name"] == "good.png"


# ── generated image collection error branches ──────────────────────────────


def test_generated_image_paths_for_task_runs_error():
    channel = _make_channel()
    channel.db.runs_error = RuntimeError("db down")
    assert channel._generated_image_paths_for_task(1) == []


def test_generated_image_paths_for_task_no_runs():
    channel = _make_channel()
    channel.db.task_runs[1] = []
    assert channel._generated_image_paths_for_task(1) == []


def test_generated_image_paths_for_task_run_without_id():
    channel = _make_channel()
    channel.db.task_runs[1] = [{"no_id": True}]
    assert channel._generated_image_paths_for_task(1) == []


def test_generated_image_paths_for_task_events_error():
    channel = _make_channel()
    channel.db.task_runs[1] = [{"id": 11}]
    channel.db.events_error = RuntimeError("events down")
    assert channel._generated_image_paths_for_task(1) == []


def test_generated_image_paths_for_task_parses_events(tmp_path):
    channel = _make_channel()
    img = tmp_path / "g.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\nx")
    channel.db.task_runs[1] = [{"id": 11}]
    channel.db.run_output_events[11] = [
        "not-a-dict",
        {"event_type": "other"},
        {"event_type": "generated_image", "content": "not-json{"},
        {"event_type": "generated_image", "content": json.dumps({"path": str(img)})},
        {"event_type": "generated_image", "content": json.dumps({"no_path": 1})},
    ]
    assert channel._generated_image_paths_for_task(1) == [str(img)]


# ── markdown reference parsing ─────────────────────────────────────────────


def test_local_image_path_from_reference_variants(tmp_path):
    channel = _make_channel()
    img = tmp_path / "ref.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\nx")

    # http / data references are rejected
    assert channel._local_image_path_from_reference("https://x/y.png") is None
    assert channel._local_image_path_from_reference("data:image/png;base64,AAA") is None
    assert channel._local_image_path_from_reference("") is None

    # file:// scheme
    assert channel._local_image_path_from_reference(f"file://{img}") == str(img.resolve())
    # sandbox: scheme
    assert channel._local_image_path_from_reference(f"sandbox:{img}") == str(img.resolve())
    # relative path resolved against working_dir
    assert channel._local_image_path_from_reference("ref.png", working_dir=str(tmp_path)) == str(
        img.resolve()
    )


def test_markdown_image_reference_target_quotes_and_titles():
    channel = _make_channel()
    assert channel._markdown_image_reference_target("") == ""
    assert channel._markdown_image_reference_target("<path/x.png>") == "path/x.png"
    assert channel._markdown_image_reference_target("'quoted.png'") == "quoted.png"
    assert channel._markdown_image_reference_target('"dq.png"') == "dq.png"
    assert channel._markdown_image_reference_target('a.png "title"') == "a.png"
    assert channel._markdown_image_reference_target("plain.png") == "plain.png"


def test_generated_image_paths_from_markdown(tmp_path):
    channel = _make_channel()
    img = tmp_path / "md.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\nx")
    content = f"see ![alt]({img}) and ![x](https://remote/y.png)"
    assert channel._generated_image_paths_from_markdown(content) == [str(img.resolve())]


# ── _hide_generated_image_paths renderer ───────────────────────────────────


def test_hide_generated_image_paths_removes_listed_paths(tmp_path):
    channel = _make_channel()
    img = tmp_path / "out.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\nx")
    canonical = str(img.resolve())
    content = f"这是结果\n- {canonical}\n\n下一行"
    cleaned = channel._hide_generated_image_paths(content, 1, [canonical])
    assert canonical not in cleaned
    assert "这是结果" in cleaned
    assert "下一行" in cleaned


def test_hide_generated_image_paths_codex_dir_line():
    channel = _make_channel()
    content = "- /home/u/.codex/generated_images/foo.png"
    cleaned = channel._hide_generated_image_paths(content, 1, [])
    assert cleaned == "已生成 1 张图片。"


def test_hide_generated_image_paths_strips_markdown_refs(tmp_path):
    channel = _make_channel()
    img = tmp_path / "in.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\nx")
    canonical = str(img.resolve())
    content = f"前缀 ![a]({canonical}) 后缀"
    cleaned = channel._hide_generated_image_paths(content, 1, [canonical])
    assert canonical not in cleaned
    assert "前缀" in cleaned and "后缀" in cleaned


def test_hide_generated_image_paths_empty_becomes_default():
    channel = _make_channel()
    cleaned = channel._hide_generated_image_paths("   \n  ", 2, [])
    assert cleaned == "已生成 2 张图片。"


def test_line_is_uploaded_image_path_non_dash_line():
    channel = _make_channel()
    assert channel._line_is_uploaded_image_path("just text", set()) is False


def test_remove_uploaded_markdown_image_refs_no_uploads():
    channel = _make_channel()
    line = "![a](x.png)"
    assert channel._remove_uploaded_markdown_image_refs(line, set()) == line


# ── canonical path edge cases ──────────────────────────────────────────────


def test_canonical_image_path_rejects_non_image(tmp_path):
    channel = _make_channel()
    txt = tmp_path / "a.txt"
    txt.write_text("hi")
    assert channel._canonical_image_path(str(txt)) is None


def test_canonical_image_path_rejects_missing(tmp_path):
    channel = _make_channel()
    assert channel._canonical_image_path(str(tmp_path / "missing.png")) is None


# ── send() guards ──────────────────────────────────────────────────────────


def test_send_noop_when_not_running():
    channel = _make_channel()
    channel._running = False
    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=1,
            payload={"result": "x"},
        )
    )  # no error, nothing sent
    assert channel._bridge_proc is None


def test_send_ignores_irrelevant_message_type():
    channel = _make_channel()
    channel._running = True
    channel._bridge_proc = FakeProcess()
    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_STARTED,
            task_id=1,
            payload={},
        )
    )
    assert channel._bridge_proc.stdin.getvalue() == ""


def test_send_without_origin_skips():
    channel = _make_channel()
    channel._running = True
    channel._bridge_proc = FakeProcess()
    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=99,
            payload={"result": "x"},
        )
    )
    assert channel._bridge_proc.stdin.getvalue() == ""


def test_send_failed_task_formats_error():
    channel = _make_channel()
    channel._running = True
    channel._bridge_proc = FakeProcess()
    channel._task_origin[4] = {
        "account_id": "wx-1",
        "peer_id": "user-4",
        "context_token": "ctx-4",
        "message_id": "msg-4",
    }
    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_FAILED,
            task_id=4,
            payload={"title": "Broke", "error": "  boom  "},
        )
    )
    sent = json.loads(channel._bridge_proc.stdin.getvalue().strip())
    assert sent["text"].startswith("❌ Task #4 · Broke")
    assert "boom" in sent["text"]
    # origin consumed after send
    assert 4 not in channel._task_origin


# ── _extract_task_id_from_reply_reference ──────────────────────────────────


def test_extract_task_id_from_reply_reference():
    channel = _make_channel()
    assert channel._extract_task_id_from_reply_reference("", "Task #88 done") == 88
    assert channel._extract_task_id_from_reply_reference("no number here") is None


# ── request_login / request_logout ─────────────────────────────────────────


def test_request_login_resets_status_and_sends_command():
    channel = _make_channel()
    channel._running = True
    channel._bridge_proc = FakeProcess()
    channel._update_status(configured=True, login_status="connected", user_id="u")

    channel.request_login()

    snap = channel.get_status_snapshot()
    assert snap["configured"] is False
    assert snap["login_status"] == "idle"
    sent = json.loads(channel._bridge_proc.stdin.getvalue().strip())
    assert sent["type"] == "login"


def test_request_logout_resets_status_and_sends_command():
    channel = _make_channel()
    channel._running = True
    channel._bridge_proc = FakeProcess()

    channel.request_logout()

    sent = json.loads(channel._bridge_proc.stdin.getvalue().strip())
    assert sent["type"] == "logout"
    assert channel.get_status_snapshot()["login_status"] == "idle"


# ── send() with generated images ───────────────────────────────────────────


def test_send_completed_with_generated_images(tmp_path):
    channel = _make_channel()
    channel._running = True
    channel._bridge_proc = FakeProcess()
    img = tmp_path / "gen.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\nx")
    canonical = str(img.resolve())

    channel.db.tasks[7] = {"id": 7, "working_dir": str(tmp_path)}
    channel.db.task_runs[7] = [{"id": 70}]
    channel.db.run_output_events[70] = [
        {"event_type": "generated_image", "content": json.dumps({"path": canonical})}
    ]
    channel._task_origin[7] = {
        "account_id": "wx-1",
        "peer_id": "user-7",
        "context_token": "ctx-7",
        "message_id": "msg-7",
    }

    channel.send(
        OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=7,
            payload={"title": "img task", "result": f"done\n- {canonical}"},
        )
    )

    sent = json.loads(channel._bridge_proc.stdin.getvalue().strip())
    assert sent["image_paths"] == [canonical]
    assert canonical not in sent["text"]


# ── sent-event handling ────────────────────────────────────────────────────


def test_handle_sent_event_maps_message_and_quoted_ids():
    channel = _make_channel()
    channel._pending_notifications["req-1"] = 5

    channel._handle_sent_event(
        {
            "type": "sent",
            "request_id": "req-1",
            "message_id": "mid-1",
            "quoted_message_id": "qid-1",
        }
    )

    assert channel._notification_map["mid-1"] == 5
    assert channel._notification_map["qid-1"] == 5
    # quoted id present → pending entry cleared
    assert "req-1" not in channel._pending_notifications


def test_handle_sent_event_ignored_without_ids():
    channel = _make_channel()
    channel._pending_notifications["req-2"] = 9
    channel._handle_sent_event({"request_id": "req-2"})
    assert channel._notification_map == {}


def test_handle_sent_event_unknown_request_id():
    channel = _make_channel()
    channel._handle_sent_event({"request_id": "missing", "message_id": "m"})
    assert channel._notification_map == {}


# ── full resume flow via peer current task ─────────────────────────────────


def test_resume_via_peer_current_task_updates_and_sets_origin():
    channel = _make_channel()
    channel._running = True
    channel._bridge_proc = FakeProcess()
    channel.db.tasks[3] = {"id": 3, "session_id": "sess-3", "status": "completed"}
    channel._peer_current_task["wx-1:user-3"] = 3

    channel._handle_bridge_event(
        {
            "type": "message",
            "account_id": "wx-1",
            "peer_id": "user-3",
            "context_token": "ctx-3b",
            "message_id": "msg-3b",
            "text": "继续做",
        }
    )

    assert channel.scheduler.submitted == []
    assert channel.db.updated[0][0] == 3
    assert channel._task_origin[3]["message_id"] == "msg-3b"
    sent = [
        json.loads(line)
        for line in channel._bridge_proc.stdin.getvalue().splitlines()
        if line.strip()
    ]
    assert sent[-1]["text"] == "▶️ 收到！正在唤醒 Task #3，请稍候～"


def test_build_resume_updates_with_images(tmp_path):
    channel = _make_channel()
    img = tmp_path / "r.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\nx")
    updates = channel._build_resume_updates("", [str(img)])
    assert updates["prompt"] == "请分析这张图片。"
    assert json.loads(updates["image_paths"]) == [str(img)]
    assert json.loads(updates["prompt_images"])[0]["media_type"] == "image/png"


def test_default_image_prompt_plural():
    channel = _make_channel()
    assert channel._default_image_prompt(["a", "b"]) == "请分析这 2 张图片。"
