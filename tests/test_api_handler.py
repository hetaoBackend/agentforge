"""Integration tests for the TaskAPIHandler HTTP routes.

A real QuietHTTPServer is bound to an ephemeral port and driven over HTTP with
urllib. The scheduler is constructed but never started (no background thread),
and any method that would spawn a real agent CLI is monkeypatched to a no-op so
the tests stay hermetic and fast. Requests are made WITHOUT an Origin header so
the CSRF check is skipped (see TaskAPIHandler._check_csrf).
"""

import json
import socket
import threading
import urllib.error
import urllib.request

import pytest

import taskboard
from taskboard import (
    Heartbeat,
    HeartbeatScheduleType,
    QuietHTTPServer,
    TaskAPIHandler,
    TaskDB,
    TaskScheduler,
)


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

    def get(self, path, headers=None):
        return self.request("GET", path, headers=headers)

    def post(self, path, body=None, headers=None):
        return self.request("POST", path, body=body, headers=headers)

    def put(self, path, body=None, headers=None):
        return self.request("PUT", path, body=body, headers=headers)

    def delete(self, path, headers=None):
        return self.request("DELETE", path, headers=headers)

    def options(self, path, headers=None):
        return self.request("OPTIONS", path, headers=headers)


@pytest.fixture
def api(tmp_path, monkeypatch):
    db = TaskDB(str(tmp_path / "test.db"))
    scheduler = TaskScheduler(db)  # NOT started — no background thread

    # Guard against anything that would spawn a real agent CLI / background work.
    monkeypatch.setattr(scheduler, "run_skill_sweep", lambda *a, **k: None)
    monkeypatch.setattr(scheduler, "distill_skill_draft", lambda *a, **k: None)

    # Avoid touching the real filesystem when writing/removing skills on disk.
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
        db.conn.close()


# ── helpers ──────────────────────────────────────────────────────────────────


def _make_task(client, **overrides):
    """Create a delayed task (won't run immediately) and return its id."""
    body = {
        "title": "T",
        "prompt": "do something",
        "schedule_type": "delayed",
        "delay_seconds": 999,
    }
    body.update(overrides)
    status, data = client.post("/api/tasks", body)
    assert status == 201, data
    return data["id"]


def _make_heartbeat_payload(**overrides):
    body = {
        "name": "watcher",
        "check_prompt": "look around",
        "schedule_type": "interval",
        "interval_seconds": 60,
    }
    body.update(overrides)
    return body


# ── GET routes ───────────────────────────────────────────────────────────────


def test_health(api):
    client, _, _ = api
    status, data = client.get("/api/health")
    assert status == 200
    assert data["status"] == "ok"
    assert data["tasks"] == 0


def test_get_tasks_empty_then_populated(api):
    client, _, _ = api
    status, data = client.get("/api/tasks")
    assert status == 200
    assert data == []

    tid = _make_task(client)
    status, data = client.get("/api/tasks")
    assert status == 200
    assert len(data) == 1
    assert data[0]["id"] == tid
    assert data[0]["dependencies"] == []
    assert data[0]["dependents"] == []


def test_get_single_task_and_404(api):
    client, _, _ = api
    tid = _make_task(client, title="hello")
    status, data = client.get(f"/api/tasks/{tid}")
    assert status == 200
    assert data["title"] == "hello"
    assert "dependencies" in data

    status, data = client.get("/api/tasks/99999")
    assert status == 404
    assert data["error"] == "not found"


def test_get_task_output_and_events(api):
    client, _, _ = api
    tid = _make_task(client)

    status, data = client.get(f"/api/tasks/{tid}/output")
    assert status == 200
    assert data == {"output": "", "is_running": False}

    status, data = client.get(f"/api/tasks/{tid}/events")
    assert status == 200
    assert data == {"events": [], "total": 0}

    status, data = client.get(f"/api/tasks/{tid}/runs")
    assert status == 200
    assert data == []

    status, data = client.get(f"/api/tasks/{tid}/messages")
    assert status == 200
    assert data == []

    status, data = client.get(f"/api/tasks/{tid}/dependencies")
    assert status == 200
    assert data == []

    status, data = client.get(f"/api/tasks/{tid}/dependents")
    assert status == 200
    assert data == []


def test_get_settings_defaults(api):
    client, _, _ = api
    status, data = client.get("/api/settings")
    assert status == 200
    assert data["default_agent"] == "claude"
    assert data["timeout"] == 600
    assert data["skill_library_enabled"] is False


def test_get_skill_patterns_and_skills(api):
    client, _, _ = api
    status, data = client.get("/api/skill-patterns")
    assert status == 200
    assert data["patterns"] == []
    assert data["sweep"]["running"] is False

    status, data = client.get("/api/skills")
    assert status == 200
    assert data == {"skills": []}


def test_get_channels_status(api):
    client, _, _ = api
    status, data = client.get("/api/channels/status")
    assert status == 200
    for key in ("telegram", "slack", "weixin", "feishu"):
        assert key in data
    assert data["telegram"]["running"] is False
    assert data["feishu"]["running"] is False


def test_get_feishu_settings(api):
    client, _, _ = api
    status, data = client.get("/api/feishu/settings")
    assert status == 200
    assert data["feishu_app_id"] == ""
    assert data["feishu_enabled"] == "false"


def test_get_csrf_token(api):
    client, _, _ = api
    status, data = client.get("/api/csrf-token")
    assert status == 200
    assert data["csrf_token"] == taskboard._CSRF_TOKEN


def test_get_heartbeats_empty_and_404(api):
    client, _, _ = api
    status, data = client.get("/api/heartbeats")
    assert status == 200
    assert data == []

    status, data = client.get("/api/heartbeats/99999")
    assert status == 404
    assert data["error"] == "not found"


def test_get_unknown_path_404(api):
    client, _, _ = api
    status, data = client.get("/api/nope")
    assert status == 404
    assert data["error"] == "not found"


# ── POST: task creation validation ───────────────────────────────────────────


def test_create_task_immediate(api):
    client, db, _ = api
    status, data = client.post(
        "/api/tasks", {"title": "now", "prompt": "go", "schedule_type": "immediate"}
    )
    assert status == 201
    assert data["status"] == "created"
    task = db.get_task(data["id"])
    assert task["status"] == "pending"
    assert task["title"] == "now"


def test_create_task_empty_prompt(api):
    client, _, _ = api
    status, data = client.post("/api/tasks", {"prompt": "   "})
    assert status == 400
    assert data["field"] == "prompt"


def test_create_task_bad_working_dir(api):
    client, _, _ = api
    status, data = client.post(
        "/api/tasks", {"prompt": "go", "working_dir": "/nonexistent/dir/xyz"}
    )
    assert status == 400
    assert data["field"] == "working_dir"


def test_create_task_cron_missing_expr(api):
    client, _, _ = api
    status, data = client.post("/api/tasks", {"prompt": "go", "schedule_type": "cron"})
    assert status == 400
    assert data["field"] == "cron_expr"


def test_create_task_cron_invalid_expr(api):
    client, _, _ = api
    status, data = client.post(
        "/api/tasks", {"prompt": "go", "schedule_type": "cron", "cron_expr": "not a cron"}
    )
    assert status == 400
    assert data["field"] == "cron_expr"


def test_create_task_cron_valid(api):
    client, db, _ = api
    status, data = client.post(
        "/api/tasks", {"prompt": "go", "schedule_type": "cron", "cron_expr": "0 3 * * *"}
    )
    assert status == 201
    task = db.get_task(data["id"])
    assert task["status"] == "scheduled"
    assert task["next_run_at"]


def test_create_task_with_dependency_blocks(api):
    client, db, _ = api
    upstream = _make_task(client)
    status, data = client.post(
        "/api/tasks",
        {"prompt": "downstream", "schedule_type": "immediate", "depends_on": [upstream]},
    )
    assert status == 201
    task = db.get_task(data["id"])
    assert task["status"] == "blocked"
    deps = db.get_dependencies(data["id"])
    assert deps[0]["depends_on_task_id"] == upstream


def test_malformed_json_body(api):
    client, db, _ = api
    # Regression: a malformed JSON body used to make _read_body raise an
    # unhandled exception, so no response was sent and the client saw a
    # connection reset. It should now drain the body and return a clean 400.
    payload = b"{bad json"
    lines = [
        "POST /api/tasks HTTP/1.1",
        f"Host: {client.host}:{client.port}",
        "Connection: close",
        "Content-Type: application/json",
        f"Content-Length: {len(payload)}",
    ]
    request = ("\r\n".join(lines) + "\r\n\r\n").encode() + payload
    sock = socket.create_connection((client.host, client.port), timeout=10)
    try:
        sock.sendall(request)
        raw = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            raw += chunk
    finally:
        sock.close()
    status_line = raw.split(b"\r\n", 1)[0].decode(errors="replace")
    assert " 400 " in status_line, status_line
    assert db.get_all_tasks() == []


# ── POST: heartbeats ─────────────────────────────────────────────────────────


def test_create_heartbeat_valid(api):
    client, db, _ = api
    status, data = client.post("/api/heartbeats", _make_heartbeat_payload())
    assert status == 201
    assert data["status"] == "created"
    hb = db.get_heartbeat(data["id"])
    assert hb["name"] == "watcher"


def test_create_heartbeat_empty_check_prompt(api):
    client, _, _ = api
    status, data = client.post("/api/heartbeats", _make_heartbeat_payload(check_prompt=" "))
    assert status == 400
    assert data["field"] == "check_prompt"


def test_create_heartbeat_invalid_schedule_type(api):
    client, _, _ = api
    status, data = client.post("/api/heartbeats", _make_heartbeat_payload(schedule_type="bogus"))
    assert status == 400
    assert data["field"] == "schedule_type"


def test_create_heartbeat_cron_missing_expr(api):
    client, _, _ = api
    payload = _make_heartbeat_payload(schedule_type="cron")
    payload.pop("interval_seconds", None)
    status, data = client.post("/api/heartbeats", payload)
    assert status == 400
    assert data["field"] == "cron_expr"


def test_create_heartbeat_cron_invalid_expr(api):
    client, _, _ = api
    payload = _make_heartbeat_payload(schedule_type="cron", cron_expr="nope nope")
    status, data = client.post("/api/heartbeats", payload)
    assert status == 400
    assert data["field"] == "cron_expr"


def test_create_heartbeat_interval_not_int(api):
    client, _, _ = api
    status, data = client.post("/api/heartbeats", _make_heartbeat_payload(interval_seconds="abc"))
    assert status == 400
    assert data["field"] == "interval_seconds"


def test_create_heartbeat_interval_non_positive(api):
    client, _, _ = api
    status, data = client.post("/api/heartbeats", _make_heartbeat_payload(interval_seconds=0))
    assert status == 400
    assert data["field"] == "interval_seconds"


def test_create_heartbeat_negative_cooldown(api):
    client, _, _ = api
    status, data = client.post("/api/heartbeats", _make_heartbeat_payload(cooldown_seconds=-1))
    assert status == 400
    assert data["field"] == "cooldown_seconds"


def test_create_heartbeat_bad_working_dir(api):
    client, _, _ = api
    status, data = client.post(
        "/api/heartbeats", _make_heartbeat_payload(working_dir="/nonexistent/xyz")
    )
    assert status == 400
    assert data["field"] == "working_dir"


def test_heartbeat_run_now_not_found(api):
    client, _, _ = api
    status, data = client.post("/api/heartbeats/99999/run-now")
    assert status == 404


def test_heartbeat_pause_resume(api):
    client, db, _ = api
    _, created = client.post("/api/heartbeats", _make_heartbeat_payload())
    hid = created["id"]

    status, data = client.post(f"/api/heartbeats/{hid}/pause")
    assert status == 200
    assert data["status"] == "paused"
    assert db.get_heartbeat(hid)["enabled"] is False

    status, data = client.post(f"/api/heartbeats/{hid}/resume")
    assert status == 200
    assert data["status"] == "resumed"
    assert db.get_heartbeat(hid)["enabled"] is True


def test_heartbeat_pause_not_found(api):
    client, _, _ = api
    status, data = client.post("/api/heartbeats/99999/pause")
    assert status == 404


def test_get_heartbeat_ticks(api):
    client, _, _ = api
    _, created = client.post("/api/heartbeats", _make_heartbeat_payload())
    hid = created["id"]
    status, data = client.get(f"/api/heartbeats/{hid}/ticks")
    assert status == 200
    assert data == {"ticks": []}


# ── POST: settings & channels ────────────────────────────────────────────────


def test_post_settings(api):
    client, db, _ = api
    status, data = client.post("/api/settings", {"default_agent": "codex", "timeout": "900"})
    assert status == 200
    assert data["status"] == "updated"
    assert db.get_setting("default_agent") == "codex"
    assert db.get_setting("timeout") == "900"


def test_post_channels_settings_disabled(api):
    client, db, _ = api
    status, data = client.post(
        "/api/channels/settings",
        {"telegram_bot_token": "abc", "telegram_enabled": "false"},
    )
    assert status == 200
    assert data["status"] == "updated"
    assert db.get_setting("telegram_bot_token") == "abc"


def test_weixin_action_not_running(api):
    client, _, _ = api
    status, data = client.post("/api/channels/weixin/action", {"action": "login"})
    assert status == 400
    assert "not running" in data["error"]


# ── POST: skills ─────────────────────────────────────────────────────────────


def test_skills_sweep_started(api):
    client, _, _ = api
    status, data = client.post("/api/skills/sweep", {"full": True})
    assert status == 200
    assert data["status"] == "started"


def test_skill_draft_pattern_not_found(api):
    client, _, _ = api
    status, data = client.post("/api/skill-patterns/99999/draft", {})
    assert status == 404


def test_skill_approve_pattern_not_found(api):
    client, _, _ = api
    status, data = client.post("/api/skill-patterns/99999/approve", {"name": "x", "body": "y"})
    assert status == 404


def test_skill_dismiss_not_found(api):
    client, _, _ = api
    status, data = client.post("/api/skill-patterns/99999/dismiss", {})
    assert status == 404


# ── POST: task lifecycle actions ─────────────────────────────────────────────


def test_task_cancel(api):
    client, db, _ = api
    tid = _make_task(client)
    status, data = client.post(f"/api/tasks/{tid}/cancel")
    assert status == 200
    assert data["status"] == "cancelled"
    assert db.get_task(tid)["status"] == "cancelled"


def test_task_retry(api):
    client, db, _ = api
    tid = _make_task(client)
    db.update_task(tid, status="failed", error="boom")
    status, data = client.post(f"/api/tasks/{tid}/retry")
    assert status == 200
    assert data["status"] == "retrying"
    assert db.get_task(tid)["status"] == "pending"


def test_task_respond(api):
    client, db, _ = api
    tid = _make_task(client)
    db.update_task(tid, status="awaiting_input", question="what?")
    status, data = client.post(f"/api/tasks/{tid}/respond", {"answer": "42"})
    assert status == 200
    assert data["status"] == "responding"
    task = db.get_task(tid)
    assert task["status"] == "pending"
    assert task["answer"] == "42"


def test_task_respond_not_found(api):
    client, _, _ = api
    status, data = client.post("/api/tasks/99999/respond", {"answer": "x"})
    assert status == 404


def test_task_resume_no_session(api):
    client, _, _ = api
    tid = _make_task(client)
    status, data = client.post(f"/api/tasks/{tid}/resume", {"message": "continue"})
    assert status == 400
    assert "session_id" in data["error"]


def test_task_resume_missing_message(api):
    client, _, _ = api
    tid = _make_task(client)
    status, data = client.post(f"/api/tasks/{tid}/resume", {"message": "  "})
    assert status == 400
    assert "message required" in data["error"]


def test_task_resume_with_session(api):
    client, db, _ = api
    tid = _make_task(client)
    db.update_task(tid, session_id="sess-1", status="completed")
    status, data = client.post(f"/api/tasks/{tid}/resume", {"message": "continue"})
    assert status == 200
    assert data["status"] == "resuming"
    assert db.get_task(tid)["status"] == "pending"


def test_add_dependency_to_task(api):
    client, db, _ = api
    upstream = _make_task(client)
    db.update_task(upstream, status="completed")  # already done → no blocking branch
    downstream = _make_task(client)
    status, data = client.post(
        f"/api/tasks/{downstream}/dependencies", {"depends_on_task_id": upstream}
    )
    assert status == 200
    assert data["status"] == "added"
    deps = db.get_dependencies(downstream)
    assert deps[0]["depends_on_task_id"] == upstream


def test_add_dependency_blocking_path_marks_task_blocked(api):
    # Regression: when the upstream is not yet completed, the handler takes the
    # should_block branch and calls self.scheduler._notify(tid). This used to
    # crash with AttributeError (self._notify doesn't exist on the handler),
    # resetting the connection. It should now return 200 and block the task.
    client, db, _ = api
    upstream = _make_task(client)  # not completed
    downstream = _make_task(client)
    status, data = client.post(
        f"/api/tasks/{downstream}/dependencies", {"depends_on_task_id": upstream}
    )
    assert status == 200
    assert data["status"] == "added"
    assert db.get_task(downstream)["status"] == "blocked"


def test_add_dependency_missing_field(api):
    client, _, _ = api
    tid = _make_task(client)
    status, data = client.post(f"/api/tasks/{tid}/dependencies", {})
    assert status == 400


def test_add_dependency_task_not_found(api):
    client, _, _ = api
    status, data = client.post("/api/tasks/99999/dependencies", {"depends_on_task_id": 88888})
    assert status == 404


def test_create_dag(api):
    client, db, _ = api
    status, data = client.post(
        "/api/dag",
        {
            "dag_id": "mydag",
            "tasks": [
                {"ref": "a", "prompt": "first", "schedule_type": "immediate"},
                {
                    "ref": "b",
                    "prompt": "second",
                    "schedule_type": "immediate",
                    "depends_on_refs": ["a"],
                },
            ],
        },
    )
    assert status == 201
    assert data["dag_id"] == "mydag"
    assert set(data["task_ids"]) == {"a", "b"}
    b_id = data["task_ids"]["b"]
    assert db.get_task(b_id)["status"] == "blocked"


def test_create_dag_empty(api):
    client, _, _ = api
    status, data = client.post("/api/dag", {"tasks": []})
    assert status == 400


def test_create_dag_unknown_ref(api):
    client, _, _ = api
    status, data = client.post(
        "/api/dag",
        {"tasks": [{"ref": "b", "prompt": "x", "depends_on_refs": ["missing"]}]},
    )
    assert status == 400
    assert "missing" in data["error"]


def test_post_unknown_path(api):
    client, _, _ = api
    status, data = client.post("/api/nope", {})
    assert status == 404


# ── PUT routes ───────────────────────────────────────────────────────────────


def test_put_settings(api):
    client, db, _ = api
    status, data = client.put("/api/settings", {"timeout": "1200"})
    assert status == 200
    assert db.get_setting("timeout") == "1200"


def test_put_task_edit(api):
    client, db, _ = api
    tid = _make_task(client)
    status, data = client.put(f"/api/tasks/{tid}", {"prompt": "new prompt", "title": "new title"})
    assert status == 200
    assert data["prompt"] == "new prompt"
    assert data["title"] == "new title"
    assert db.get_task(tid)["prompt"] == "new prompt"


def test_put_task_not_found(api):
    client, _, _ = api
    status, data = client.put("/api/tasks/99999", {"prompt": "x"})
    assert status == 404


def test_put_task_wrong_status(api):
    client, db, _ = api
    tid = _make_task(client)
    db.update_task(tid, status="completed")
    status, data = client.put(f"/api/tasks/{tid}", {"prompt": "x"})
    assert status == 409


def test_put_task_empty_prompt(api):
    client, _, _ = api
    tid = _make_task(client)
    status, data = client.put(f"/api/tasks/{tid}", {"prompt": "   "})
    assert status == 400
    assert data["field"] == "prompt"


def test_put_task_cron_invalid(api):
    client, _, _ = api
    tid = _make_task(client)
    status, data = client.put(
        f"/api/tasks/{tid}", {"schedule_type": "cron", "cron_expr": "garbage here"}
    )
    assert status == 400
    assert data["field"] == "cron_expr"


def test_put_task_scheduled_at_requires_next_run(api):
    client, _, _ = api
    tid = _make_task(client)
    status, data = client.put(f"/api/tasks/{tid}", {"schedule_type": "scheduled_at"})
    assert status == 400
    assert data["field"] == "next_run_at"


def test_put_heartbeat_update(api):
    client, db, _ = api
    _, created = client.post("/api/heartbeats", _make_heartbeat_payload())
    hid = created["id"]
    status, data = client.put(
        f"/api/heartbeats/{hid}", _make_heartbeat_payload(name="renamed", interval_seconds=120)
    )
    assert status == 200
    assert data["name"] == "renamed"
    assert db.get_heartbeat(hid)["interval_seconds"] == 120


def test_put_heartbeat_not_found(api):
    client, _, _ = api
    status, data = client.put("/api/heartbeats/99999", _make_heartbeat_payload())
    assert status == 404


def test_put_skill_toggle(api):
    client, db, _ = api
    sid = db.add_skill(name="myskill", description="d", path="/tmp/myskill.md")
    status, data = client.put(f"/api/skills/{sid}", {"enabled": False})
    assert status == 200
    assert not data["skill"]["enabled"]


def test_put_skill_not_found(api):
    client, _, _ = api
    status, data = client.put("/api/skills/99999", {"enabled": True})
    assert status == 404


def test_put_unknown_path(api):
    client, _, _ = api
    status, data = client.put("/api/nope", {})
    assert status == 404


# ── DELETE routes ────────────────────────────────────────────────────────────


def test_delete_task(api):
    client, db, _ = api
    tid = _make_task(client)
    status, data = client.delete(f"/api/tasks/{tid}")
    assert status == 200
    assert data["status"] == "deleted"
    assert db.get_task(tid) is None


def test_delete_heartbeat(api):
    client, db, _ = api
    _, created = client.post("/api/heartbeats", _make_heartbeat_payload())
    hid = created["id"]
    status, data = client.delete(f"/api/heartbeats/{hid}")
    assert status == 200
    assert data["status"] == "deleted"
    assert db.get_heartbeat(hid) is None


def test_delete_skill(api):
    client, db, _ = api
    sid = db.add_skill(name="goner", description="d", path="/tmp/goner.md")
    status, data = client.delete(f"/api/skills/{sid}")
    assert status == 200
    assert data["status"] == "deleted"
    assert db.get_skill(sid) is None


def test_delete_skill_not_found(api):
    client, _, _ = api
    status, data = client.delete("/api/skills/99999")
    assert status == 404


def test_delete_task_dependency(api):
    client, db, _ = api
    upstream = _make_task(client)
    downstream = _make_task(client)
    db.add_dependencies_batch(downstream, [{"task_id": upstream, "inject_result": False}])
    status, data = client.delete(f"/api/tasks/{downstream}/dependencies/{upstream}")
    assert status == 200
    assert data["status"] == "removed"
    assert db.get_dependencies(downstream) == []


def test_delete_unknown_path(api):
    client, _, _ = api
    status, data = client.delete("/api/nope")
    assert status == 404


# ── CORS / CSRF ──────────────────────────────────────────────────────────────


def test_options_preflight_allowed_origin(api):
    client, _, _ = api
    status, _ = client.options("/api/tasks", headers={"Origin": "http://localhost:5173"})
    assert status == 200


def test_options_preflight_rejected_origin(api):
    client, _, _ = api
    status, _ = client.options("/api/tasks", headers={"Origin": "http://evil.example.com"})
    assert status == 403


def test_csrf_rejected_with_bad_token(api):
    # Regression: a bad CSRF token now drains the request body before replying,
    # so a normal urllib client gets a clean 403 instead of a connection reset
    # (which previously forced the raw-socket workaround).
    client, db, _ = api
    status, data = client.post(
        "/api/settings",
        {"default_agent": "codex"},
        headers={"Origin": "http://localhost:5173", "X-CSRF-Token": "wrong"},
    )
    assert status == 403
    # State change must not have been applied.
    assert db.get_setting("default_agent", "claude") == "claude"


def test_csrf_accepted_with_valid_token(api):
    client, db, _ = api
    status, data = client.post(
        "/api/settings",
        {"default_agent": "codex"},
        headers={
            "Origin": "http://localhost:5173",
            "X-CSRF-Token": taskboard._CSRF_TOKEN,
        },
    )
    assert status == 200
    assert db.get_setting("default_agent") == "codex"


# ── direct unit checks on validation helper ──────────────────────────────────


def test_validate_heartbeat_payload_cron_clears_interval(api):
    _, db, scheduler = api
    handler = object.__new__(TaskAPIHandler)
    handler.db = db
    hb, err = handler._validate_heartbeat_payload(
        {
            "name": "c",
            "check_prompt": "p",
            "schedule_type": "cron",
            "cron_expr": "0 0 * * *",
        }
    )
    assert err is None
    assert isinstance(hb, Heartbeat)
    assert hb.schedule_type == HeartbeatScheduleType.CRON
    assert hb.interval_seconds is None
    assert hb.next_run_at is not None
