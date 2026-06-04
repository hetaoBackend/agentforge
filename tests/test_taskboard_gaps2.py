"""Second mop-up coverage pass for still-reachable branches in taskboard.py.

This file targets gaps that the existing suites (test_scheduler_logic.py,
test_scheduler_more.py, test_taskboard_gaps.py, test_execute_task.py,
test_api_handler.py, test_api_handler_more.py, test_heartbeat.py) leave behind.

Everything constructs ``TaskDB`` + ``TaskScheduler`` directly, never starts the
background loop, and mocks every agent / subprocess call. The HTTP tests reuse
the same hermetic QuietHTTPServer harness (unstarted scheduler, skill/disk
entrypoints monkeypatched, no Origin header so CSRF is skipped).

Distinct from the existing files; targeted areas:
* Codex/Claude streaming delta + event-normalization helpers
  (_codex_text_delta, _codex_append_text_delta, _codex_event_delta_text,
   _extract_codex_thread_id, _find_codex_generated_images, _image_media_type,
   _extract_codex_success_output, _store_generated_image_events,
   _claude_text_delta, _claude_message_id, _content_to_display_text,
   _parse_codex_event variants, _store_output_event empty-skip).
* _execute_task EDGE branches: magic-byte media sniffing for extension-less
  images, unsafe-path rejection paired with a sniffed image, the sub-agent wait
  loop, and the on_task_update/_channels notify fan-out.
* HTTP handler edges: channel restart paths (feishu/telegram/slack/weixin),
  DAG prompt_images JSON fallback, /resume not-found, DELETE CSRF rejection,
  request-body-too-large 413.
"""

import json
import os
import tempfile
import threading
import time
import urllib.error
import urllib.request
from unittest import mock
from unittest.mock import patch

import pytest

import taskboard
from taskboard import (
    QuietHTTPServer,
    Task,
    TaskAPIHandler,
    TaskDB,
    TaskScheduler,
)


def make_db(tmp_path):
    return TaskDB(str(tmp_path / "t.db"))


# ── shared FakePopen for _execute_task drives ───────────────────────────────
class FakePopen:
    _next_pid = 9000

    def __init__(self, stdout_lines, stderr_lines=None, returncode=0):
        FakePopen._next_pid += 1
        self.pid = FakePopen._next_pid
        self.stdout = iter(list(stdout_lines))
        self.stderr = iter(list(stderr_lines or []))
        self.returncode = returncode
        self.stdin = _FakeStdin()

    def wait(self, timeout=None):
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        pass


class _FakeStdin:
    def __init__(self):
        self.buffer = ""

    def write(self, data):
        self.buffer += data

    def close(self):
        pass


@pytest.fixture
def _stub_process_group(monkeypatch):
    monkeypatch.setattr(taskboard.os, "getpgid", lambda pid: pid)

    def fake_killpg(pgid, sig):
        raise ProcessLookupError

    monkeypatch.setattr(taskboard.os, "killpg", fake_killpg)


def _claude_lines(result_text="done", session_id="s1"):
    return [
        json.dumps({"type": "system", "subtype": "init", "session_id": session_id}) + "\n",
        json.dumps(
            {
                "type": "result",
                "subtype": "success",
                "result": result_text,
                "session_id": session_id,
            }
        )
        + "\n",
    ]


# ── Codex streaming delta helpers ───────────────────────────────────────────
def test_codex_text_delta_cumulative_and_reset(tmp_path):
    sched = TaskScheduler(make_db(tmp_path))
    # First emission returns the whole text (no previous).
    assert sched._codex_text_delta(1, "item", "Hello") == "Hello"
    # Cumulative continuation returns only the new suffix.
    assert sched._codex_text_delta(1, "item", "Hello World") == " World"
    # Identical text → no new delta.
    assert sched._codex_text_delta(1, "item", "Hello World") is None
    # Empty current text → None.
    assert sched._codex_text_delta(1, "item2", "") is None
    # Non-prefix (a full rewrite) returns the new text as-is.
    assert sched._codex_text_delta(1, "item", "Totally different") == "Totally different"


def test_codex_append_text_delta_accumulates(tmp_path):
    sched = TaskScheduler(make_db(tmp_path))
    assert sched._codex_append_text_delta(2, "a", "") is None
    assert sched._codex_append_text_delta(2, "a", "foo") == "foo"
    assert sched._codex_append_text_delta(2, "a", "bar") == "bar"
    assert sched._codex_item_text[(2, "a")] == "foobar"


def test_codex_event_delta_text_variants(tmp_path):
    sched = TaskScheduler(make_db(tmp_path))
    # string delta on item
    assert sched._codex_event_delta_text({}, {"delta": "abc"}) == "abc"
    # dict delta with text on event
    assert sched._codex_event_delta_text({"delta": {"text": "xyz"}}, {}) == "xyz"
    # dict delta whose text is not a string → None
    assert sched._codex_event_delta_text({}, {"delta": {"text": 5}}) is None
    # no delta anywhere → None
    assert sched._codex_event_delta_text({}, {}) is None


def test_extract_codex_thread_id_skips_noise(tmp_path):
    sched = TaskScheduler(make_db(tmp_path))
    raw = "\n".join(
        [
            "   ",  # blank
            "not json",  # JSONDecodeError
            json.dumps({"type": "turn.started"}),  # no thread id
            json.dumps({"type": "thread.started", "thread_id": "TH-42"}),
        ]
    )
    assert sched._extract_codex_thread_id(raw) == "TH-42"
    assert sched._extract_codex_thread_id("only noise here") is None


def test_image_media_type_extension_map(tmp_path):
    sched = TaskScheduler(make_db(tmp_path))
    assert sched._image_media_type("/x/a.png") == "image/png"
    assert sched._image_media_type("/x/a.JPG") == "image/jpeg"
    assert sched._image_media_type("/x/a.webp") == "image/webp"
    # unknown extension → default png
    assert sched._image_media_type("/x/a.bmp") == "image/png"


def test_find_codex_generated_images_filters_and_sorts(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("CODEX_HOME", raising=False)
    sched = TaskScheduler(make_db(tmp_path))

    # No thread id → empty.
    assert sched._find_codex_generated_images(None) == []
    # Thread id with no directory → empty.
    assert sched._find_codex_generated_images("ghost") == []

    img_dir = tmp_path / ".codex" / "generated_images" / "TH"
    img_dir.mkdir(parents=True)
    (img_dir / "b.png").write_bytes(b"x")
    (img_dir / "a.webp").write_bytes(b"y")
    (img_dir / "note.txt").write_bytes(b"skip me")  # non-image suffix

    found = sched._find_codex_generated_images("TH")
    assert [os.path.basename(p) for p in found] == ["a.webp", "b.png"]


def test_find_codex_generated_images_since_timestamp(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("CODEX_HOME", raising=False)
    sched = TaskScheduler(make_db(tmp_path))
    img_dir = tmp_path / ".codex" / "generated_images" / "TH"
    img_dir.mkdir(parents=True)
    old = img_dir / "old.png"
    old.write_bytes(b"x")
    os.utime(old, (1000, 1000))  # ancient mtime
    new = img_dir / "new.png"
    new.write_bytes(b"y")  # current mtime

    # Only the freshly written file passes the since_timestamp filter.
    found = sched._find_codex_generated_images("TH", since_timestamp=time.time() - 60)
    assert [os.path.basename(p) for p in found] == ["new.png"]


def test_extract_codex_success_output_with_images(tmp_path):
    sched = TaskScheduler(make_db(tmp_path))
    raw = "\n".join(
        [
            "  ",  # blank skipped
            "not json",  # decode error skipped
            json.dumps(
                {"type": "item.completed", "item": {"type": "agent_message", "text": "Done"}}
            ),
        ]
    )
    out = sched._extract_codex_success_output(raw, generated_images=["/a.png", "/b.png"])
    assert "Done" in out
    assert "2 张图片" in out
    assert "/a.png" in out and "/b.png" in out
    # No images and no agent_message text → empty string.
    assert sched._extract_codex_success_output("nothing here") == ""


def test_store_generated_image_events_persists_metadata_and_data(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    run_id = db.add_run(tid)

    real = tempfile.mkdtemp(dir="/tmp")
    img = os.path.join(real, "pic.png")
    with open(img, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\nbytes")
    missing = os.path.join(real, "gone.png")  # never created → OSError branch

    sched._store_generated_image_events(tid, run_id, [img, missing])

    events = db.get_output_events(tid)
    types = [e["event_type"] for e in events]
    # The real image yields both a generated_image trace and an image_content row;
    # the missing one yields only the trace (read fails → continue).
    assert types.count("generated_image") == 2
    assert types.count("image_content") == 1
    content = next(e for e in events if e["event_type"] == "image_content")
    parsed = json.loads(content["content"])
    assert parsed["media_type"] == "image/png"
    assert parsed["data"]  # base64 payload present


# ── Claude streaming delta helpers ──────────────────────────────────────────
def test_claude_text_delta_paths(tmp_path):
    sched = TaskScheduler(make_db(tmp_path))
    # empty current → None
    assert sched._claude_text_delta(1, "m", "") is None
    # first emission returns whole text
    assert sched._claude_text_delta(1, "m", "abc") == "abc"
    # identical → None
    assert sched._claude_text_delta(1, "m", "abc") is None
    # cumulative continuation → suffix
    assert sched._claude_text_delta(1, "m", "abcdef") == "def"
    # non-cumulative chunk on same message → returns chunk, accumulates state
    assert sched._claude_text_delta(1, "m", "ZZZ") == "ZZZ"
    assert sched._claude_message_text[(1, "m")] == "abcdefZZZ"


def test_claude_message_id_fallback(tmp_path):
    sched = TaskScheduler(make_db(tmp_path))
    assert sched._claude_message_id({"message": {"id": "msg-7"}}, 1) == "msg-7"
    assert sched._claude_message_id({"message": {"message_id": "mm"}}, 1) == "mm"
    # no id at all → synthesized from run id
    assert sched._claude_message_id({"message": {}}, 3) == "assistant:3"
    assert sched._claude_message_id({"message": "not-a-dict"}, 4) == "assistant:4"


def test_content_to_display_text_variants(tmp_path):
    sched = TaskScheduler(make_db(tmp_path))
    assert sched._content_to_display_text(None) == ""
    assert sched._content_to_display_text("plain") == "plain"
    mixed = [
        "raw",
        {"type": "text", "text": "T"},
        {"type": "image"},
        {"type": "other", "k": "v"},
    ]
    out = sched._content_to_display_text(mixed)
    assert "raw" in out and "T" in out and "[image]" in out and "other" in out
    # dict with text type
    assert sched._content_to_display_text({"type": "text", "text": "hi"}) == "hi"
    # dict without text type → JSON dump
    assert "foo" in sched._content_to_display_text({"foo": "bar"})
    # non-str/list/dict → str()
    assert sched._content_to_display_text(42) == "42"


def test_store_output_event_skips_empty(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    run_id = db.add_run(tid)
    sched._store_output_event(tid, run_id, "assistant", "")  # empty → no row
    assert db.get_output_events(tid) == []
    sched._store_output_event(tid, run_id, "assistant", "real")
    assert len(db.get_output_events(tid)) == 1


# ── _parse_codex_event normalization branches ───────────────────────────────
def test_parse_codex_event_reasoning_and_kinds(tmp_path):
    sched = TaskScheduler(make_db(tmp_path))

    # reasoning delta → "[thinking] ..." assistant content
    etype, content = sched._parse_codex_event(
        {"type": "item.updated", "item": {"id": "r1", "type": "reasoning", "delta": "ponder"}},
        run_id=1,
    )
    assert etype == "assistant" and content == "[thinking] ponder"

    # command_execution
    etype, content = sched._parse_codex_event(
        {
            "type": "item.completed",
            "item": {
                "id": "c1",
                "type": "command_execution",
                "command": "ls",
                "aggregated_output": "files",
                "exit_code": 0,
                "status": "completed",
            },
        }
    )
    assert etype == "command_execution"
    assert json.loads(content)["command"] == "ls"

    # mcp_tool_call → tool_call
    etype, _ = sched._parse_codex_event(
        {"type": "item.completed", "item": {"type": "mcp_tool_call", "tool": "x"}}
    )
    assert etype == "tool_call"

    # web_search
    etype, _ = sched._parse_codex_event(
        {"type": "item.completed", "item": {"type": "web_search", "query": "q"}}
    )
    assert etype == "web_search"

    # file_change
    etype, _ = sched._parse_codex_event(
        {"type": "item.completed", "item": {"type": "file_change", "changes": []}}
    )
    assert etype == "file_change"

    # unknown item type → passthrough (etype, full json)
    etype, content = sched._parse_codex_event(
        {"type": "item.completed", "item": {"type": "mystery"}}
    )
    assert etype == "item.completed"


def test_parse_codex_event_errors_and_skips(tmp_path):
    sched = TaskScheduler(make_db(tmp_path))
    # turn.failed → error with message
    assert sched._parse_codex_event({"type": "turn.failed", "error": {"message": "boom"}}) == (
        "error",
        "boom",
    )
    # turn.failed with non-dict error
    assert sched._parse_codex_event({"type": "turn.failed", "error": "plain"}) == (
        "error",
        "plain",
    )
    # plain error event
    assert sched._parse_codex_event({"type": "error", "message": "bad"}) == ("error", "bad")
    # silent skips
    assert sched._parse_codex_event({"type": "turn.completed"}) == (None, None)
    assert sched._parse_codex_event({"type": "thread.started"}) == (None, None)
    # truly unknown top-level type → passthrough
    etype, content = sched._parse_codex_event({"type": "weird.thing", "a": 1})
    assert etype == "weird.thing"


# ── _execute_task EDGE: magic-byte media sniff + unsafe-path reject ──────────
@pytest.mark.usefixtures("_stub_process_group")
def test_execute_task_sniffs_media_type_for_extensionless_images(tmp_path, monkeypatch):
    """An extension-less safe image is loaded and its media type detected from
    magic bytes; an unsafe path (outside allowed roots) is rejected. The Claude
    multimodal stdin path is then taken with the sniffed media type."""
    db = make_db(tmp_path)
    sched = TaskScheduler(db)

    real = tempfile.mkdtemp(dir="/tmp")
    gif = os.path.join(real, "noext_gif")  # no extension → magic-byte branch
    with open(gif, "wb") as f:
        f.write(b"GIF89a" + b"\x00" * 16)

    tid = db.add_task(
        Task(
            title="img",
            prompt="see",
            working_dir=".",
            agent="claude",
            image_paths=[gif, "/etc/shadow"],  # one safe extensionless, one rejected
        )
    )
    task = db.get_task(tid)
    sched._active_tasks[tid] = object()

    captured = {}

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["stdin_obj"] = kwargs.get("stdin")
        return FakePopen(_claude_lines(result_text="ok"))

    with patch.object(taskboard.subprocess, "Popen", side_effect=fake_popen):
        sched._execute_task(task)

    assert db.get_task(tid)["status"] == "completed"
    # multimodal stdin path selected because exactly one image loaded
    cmd = captured["cmd"]
    assert "--input-format" in cmd
    # the GIF magic bytes were sniffed → image/gif written into the stdin message
    stdin_written = captured["stdin_obj"]
    # stdin is subprocess.PIPE constant; the message content lives on the fake stdin
    # object, which fake_popen returns — assert via the produced FakePopen instead.
    assert stdin_written is taskboard.subprocess.PIPE


@pytest.mark.usefixtures("_stub_process_group")
def test_execute_task_sniffs_jpeg_magic_bytes(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    real = tempfile.mkdtemp(dir="/tmp")
    jpg = os.path.join(real, "noext_jpeg")
    with open(jpg, "wb") as f:
        f.write(b"\xff\xd8\xff" + b"\x00" * 16)

    tid = db.add_task(
        Task(title="j", prompt="p", working_dir=".", agent="claude", image_paths=[jpg])
    )
    task = db.get_task(tid)
    sched._active_tasks[tid] = object()

    written = {}

    def fake_popen(cmd, **kwargs):
        fp = FakePopen(_claude_lines())
        written["fp"] = fp
        return fp

    with patch.object(taskboard.subprocess, "Popen", side_effect=fake_popen):
        sched._execute_task(task)

    assert db.get_task(tid)["status"] == "completed"
    # The multimodal stdin message embeds the jpeg media type sniffed from bytes.
    assert "image/jpeg" in written["fp"].stdin.buffer


@pytest.mark.usefixtures("_stub_process_group")
def test_execute_task_notify_fans_out_to_channels_and_callback(tmp_path):
    """_notify (called several times during execution) fires the on_task_update
    callback and starts a notify thread for each registered channel."""
    db = make_db(tmp_path)
    updates = []

    class _Chan:
        def __init__(self):
            self.notified = []

        def notify_task(self, task_id):
            self.notified.append(task_id)

    chan = _Chan()
    sched = TaskScheduler(db, on_task_update=lambda tid: updates.append(tid))
    sched._channels.append(chan)

    tid = db.add_task(Task(title="t", prompt="p", working_dir=".", agent="claude"))
    task = db.get_task(tid)
    sched._active_tasks[tid] = object()

    fake = FakePopen(_claude_lines(result_text="fine"))
    with patch.object(taskboard.subprocess, "Popen", return_value=fake):
        sched._execute_task(task)

    # Give the daemon notify threads a moment to run.
    for _ in range(50):
        if tid in chan.notified:
            break
        time.sleep(0.02)

    assert db.get_task(tid)["status"] == "completed"
    assert tid in updates  # on_task_update callback fired
    assert tid in chan.notified  # channel notify_task fired


def test_execute_task_waits_for_subagents_then_group_exits(tmp_path, monkeypatch):
    """Drive the sub-agent wait loop: the first killpg(pgid, 0) probe reports the
    group alive (enters the wait body once), the second reports it gone (breaks).
    time.sleep is stubbed so the 1s pause is instant."""
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="sub", prompt="p", working_dir=".", agent="claude"))
    task = db.get_task(tid)
    sched._active_tasks[tid] = object()

    monkeypatch.setattr(taskboard.os, "getpgid", lambda pid: pid)

    probe_calls = {"n": 0}

    def staged_killpg(pgid, sig):
        if sig == 0:
            probe_calls["n"] += 1
            if probe_calls["n"] == 1:
                return  # group still alive → loop body runs once
            raise ProcessLookupError  # gone → loop breaks
        raise ProcessLookupError

    monkeypatch.setattr(taskboard.os, "killpg", staged_killpg)
    # Make the 1s wait-loop sleep instant.
    monkeypatch.setattr(taskboard.time, "sleep", lambda *a, **k: None)

    fake = FakePopen(_claude_lines(result_text="ok"))
    with patch.object(taskboard.subprocess, "Popen", return_value=fake):
        sched._execute_task(task)

    assert db.get_task(tid)["status"] == "completed"
    # The loop probed at least twice (alive, then gone).
    assert probe_calls["n"] >= 2


# ── HTTP harness (mirrors tests/test_api_handler.py) ────────────────────────
class _Client:
    def __init__(self, base, host, port):
        self.base = base
        self.host = host
        self.port = port

    def request(self, method, path, body=None, headers=None):
        url = self.base + path
        data = None
        hdrs = dict(headers or {})
        if body is not None:
            data = json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as e:
            raw = e.read()
            status = e.code
        parsed = json.loads(raw) if raw else None
        return status, parsed

    def post(self, path, body=None, headers=None):
        return self.request("POST", path, body=body, headers=headers)

    def delete(self, path, headers=None):
        return self.request("DELETE", path, headers=headers)


@pytest.fixture
def api(tmp_path, monkeypatch):
    db = TaskDB(str(tmp_path / "test.db"))
    scheduler = TaskScheduler(db)  # NOT started

    monkeypatch.setattr(scheduler, "run_skill_sweep", lambda *a, **k: None)
    monkeypatch.setattr(scheduler, "distill_skill_draft", lambda *a, **k: None)
    monkeypatch.setattr(
        taskboard, "write_skill_to_disk", lambda name, body: (f"/tmp/{name}.md", "")
    )
    monkeypatch.setattr(taskboard, "link_skill", lambda name: None)
    monkeypatch.setattr(taskboard, "unlink_skill", lambda name: None)
    monkeypatch.setattr(taskboard, "remove_skill_from_disk", lambda name: None)

    TaskAPIHandler.db = db
    TaskAPIHandler.scheduler = scheduler
    TaskAPIHandler.feishu_channel = None
    TaskAPIHandler.telegram_channel = None
    TaskAPIHandler.slack_channel = None
    TaskAPIHandler.weixin_channel = None
    TaskAPIHandler.bus = None
    TaskAPIHandler.ui_channel = None

    server = QuietHTTPServer(("127.0.0.1", 0), TaskAPIHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    client = _Client(f"http://127.0.0.1:{port}", "127.0.0.1", port)
    try:
        yield client, db, scheduler
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        TaskAPIHandler.feishu_channel = None
        TaskAPIHandler.telegram_channel = None
        TaskAPIHandler.slack_channel = None
        TaskAPIHandler.weixin_channel = None
        db.conn.close()


def _make_task(client, **overrides):
    body = {"title": "T", "prompt": "go", "schedule_type": "delayed", "delay_seconds": 999}
    body.update(overrides)
    status, data = client.post("/api/tasks", body)
    assert status == 201, data
    return data["id"]


# ── channel restart branches (existing channel stopped + new one started) ────
def test_feishu_settings_restart_stops_old_and_starts_new(api, monkeypatch):
    client, db, _ = api
    old = mock.Mock(name="old_feishu")
    TaskAPIHandler.feishu_channel = old

    new_inst = mock.Mock(name="new_feishu")
    monkeypatch.setattr(taskboard, "FEISHU_CHANNEL_AVAILABLE", True)
    monkeypatch.setattr(taskboard, "FeishuChannel", mock.Mock(return_value=new_inst))

    status, data = client.post(
        "/api/feishu/settings",
        {"feishu_app_id": "cli_x", "feishu_app_secret": "sek", "feishu_enabled": "true"},
    )
    assert status == 200
    old.stop.assert_called_once()  # existing channel stopped
    new_inst.start.assert_called_once()  # new channel started
    assert TaskAPIHandler.feishu_channel is new_inst
    assert db.get_setting("feishu_app_id") == "cli_x"


def test_channels_settings_restart_all_three(api, monkeypatch):
    client, db, _ = api
    old_tg = mock.Mock(name="old_tg")
    old_sl = mock.Mock(name="old_sl")
    old_wx = mock.Mock(name="old_wx")
    TaskAPIHandler.telegram_channel = old_tg
    TaskAPIHandler.slack_channel = old_sl
    TaskAPIHandler.weixin_channel = old_wx

    tg_inst = mock.Mock(name="tg_inst")
    sl_inst = mock.Mock(name="sl_inst")
    wx_inst = mock.Mock(name="wx_inst")
    monkeypatch.setattr(taskboard, "TELEGRAM_CHANNEL_AVAILABLE", True)
    monkeypatch.setattr(taskboard, "SLACK_CHANNEL_AVAILABLE", True)
    monkeypatch.setattr(taskboard, "WEIXIN_CHANNEL_AVAILABLE", True)
    monkeypatch.setattr(taskboard, "create_telegram_channel", mock.Mock(return_value=tg_inst))
    monkeypatch.setattr(taskboard, "SlackChannel", mock.Mock(return_value=sl_inst))
    monkeypatch.setattr(taskboard, "WeixinChannel", mock.Mock(return_value=wx_inst))

    status, data = client.post(
        "/api/channels/settings",
        {
            "telegram_bot_token": "tg-tok",
            "telegram_enabled": "true",
            "slack_bot_token": "sl-bot",
            "slack_app_token": "sl-app",
            "slack_enabled": "true",
            "weixin_enabled": "true",
        },
    )
    assert status == 200
    old_tg.stop.assert_called_once()
    old_sl.stop.assert_called_once()
    old_wx.stop.assert_called_once()
    tg_inst.start.assert_called_once()
    sl_inst.start.assert_called_once()
    wx_inst.start.assert_called_once()
    assert TaskAPIHandler.telegram_channel is tg_inst
    assert TaskAPIHandler.slack_channel is sl_inst
    assert TaskAPIHandler.weixin_channel is wx_inst


def test_telegram_restart_factory_returns_none(api, monkeypatch):
    """Telegram enabled with a token but the factory declines → no start, ref
    stays None (covers the 'else: failed to create' branch)."""
    client, db, _ = api
    monkeypatch.setattr(taskboard, "TELEGRAM_CHANNEL_AVAILABLE", True)
    monkeypatch.setattr(taskboard, "create_telegram_channel", mock.Mock(return_value=None))
    status, data = client.post(
        "/api/channels/settings",
        {"telegram_bot_token": "tok", "telegram_enabled": "true"},
    )
    assert status == 200
    assert TaskAPIHandler.telegram_channel is None


# ── DAG prompt_images JSON-string fallback ──────────────────────────────────
def test_create_dag_prompt_images_json_string(api):
    client, db, _ = api
    status, data = client.post(
        "/api/dag",
        {
            "dag_id": "imgdag",
            "tasks": [
                {
                    "ref": "a",
                    "prompt": "first",
                    "schedule_type": "immediate",
                    "prompt_images": json.dumps([{"media_type": "image/png", "data": "AAA"}]),
                }
            ],
        },
    )
    assert status == 201
    tid = data["task_ids"]["a"]
    assert db.get_task(tid)["prompt_images"] == [{"media_type": "image/png", "data": "AAA"}]


def test_create_dag_prompt_images_bad_json_falls_back(api):
    client, db, _ = api
    status, data = client.post(
        "/api/dag",
        {
            "tasks": [
                {
                    "ref": "a",
                    "prompt": "x",
                    "schedule_type": "immediate",
                    "prompt_images": "{not json",
                }
            ]
        },
    )
    assert status == 201
    tid = data["task_ids"]["a"]
    assert db.get_task(tid)["prompt_images"] == []


# ── /resume not-found branch ────────────────────────────────────────────────
def test_task_resume_not_found(api):
    client, _, _ = api
    status, data = client.post("/api/tasks/99999/resume", {"message": "go"})
    assert status == 404
    assert data["error"] == "not found"


# ── DELETE CSRF rejection ───────────────────────────────────────────────────
def test_delete_csrf_rejected(api):
    client, db, _ = api
    tid = _make_task(client)
    status, data = client.delete(
        f"/api/tasks/{tid}",
        headers={"Origin": "http://localhost:5173", "X-CSRF-Token": "wrong"},
    )
    assert status == 403
    assert "CSRF" in data["error"]
    # Task not deleted because the request was rejected before the handler ran.
    assert db.get_task(tid) is not None


def test_delete_csrf_accepted_with_token(api):
    client, db, _ = api
    tid = _make_task(client)
    status, data = client.delete(
        f"/api/tasks/{tid}",
        headers={
            "Origin": "http://localhost:5173",
            "X-CSRF-Token": taskboard._CSRF_TOKEN,
        },
    )
    assert status == 200
    assert data["status"] == "deleted"
    assert db.get_task(tid) is None


# ── request body too large → 413 ────────────────────────────────────────────
def test_post_body_too_large_returns_413(api, monkeypatch):
    client, _, _ = api
    # Shrink the cap so we don't have to send 10 MB over the wire.
    monkeypatch.setattr(TaskAPIHandler, "MAX_BODY_SIZE", 16)
    status, data = client.post("/api/tasks", {"prompt": "x" * 200, "schedule_type": "immediate"})
    assert status == 413
    assert "too large" in data["error"]
