"""Additional integration tests for TaskAPIHandler HTTP routes.

This file complements tests/test_api_handler.py (which it does NOT touch) by
exercising the less-common handler branches that the first pass left uncovered:
heartbeat tick output, task /messages parsing, the skill draft/approve/dismiss
variants, feishu/channel settings restart branches, DAG GET, skill /content,
and the PUT/DELETE edge cases (validation + recalculated schedule).

Same hermetic harness as the sibling file: a real QuietHTTPServer bound to an
ephemeral port, an UNSTARTED TaskScheduler, agent/skill entrypoints monkeypatched
to no-ops, and requests made WITHOUT an Origin header so CSRF is skipped.
"""

import json
import threading
import urllib.error
import urllib.request

import pytest

import taskboard
from taskboard import (
    QuietHTTPServer,
    TaskAPIHandler,
    TaskDB,
    TaskScheduler,
)


class _Client:
    def __init__(self, base):
        self.base = base

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

    client = _Client(f"http://127.0.0.1:{port}")
    try:
        yield client, db, scheduler
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        db.conn.close()


# ── helpers ──────────────────────────────────────────────────────────────────


def _make_task(client, **overrides):
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


def _make_heartbeat(client, db, **overrides):
    body = {
        "name": "watcher",
        "check_prompt": "look around",
        "schedule_type": "interval",
        "interval_seconds": 60,
    }
    body.update(overrides)
    status, created = client.post("/api/heartbeats", body)
    assert status == 201, created
    return created["id"]


def _make_pattern(db, **overrides):
    """Create a skill pattern row and return its id."""
    kwargs = {
        "pattern_key": "deploy-flow",
        "kind": "recipe",
        "summary": "deploy the thing",
        "task_id": None,
        "run_id": None,
    }
    kwargs.update(overrides)
    return db.upsert_skill_pattern(**kwargs)


# ── GET: heartbeat tick output ───────────────────────────────────────────────


def test_get_heartbeat_tick_output_persisted(api):
    client, db, _ = api
    hid = _make_heartbeat(client, db)
    tick_id = db.add_heartbeat_tick(hid)
    db.finish_heartbeat_tick(tick_id, "idle", raw_output="hello world output")

    status, data = client.get(f"/api/heartbeats/{hid}/ticks/{tick_id}/output")
    assert status == 200
    assert data == {"output": "hello world output", "is_running": False}


def test_get_heartbeat_tick_output_live(api):
    client, db, scheduler = api
    hid = _make_heartbeat(client, db)
    tick_id = db.add_heartbeat_tick(hid)
    # Simulate a running tick with buffered live output.
    scheduler._live_heartbeat_output[tick_id] = "streaming..."

    status, data = client.get(f"/api/heartbeats/{hid}/ticks/{tick_id}/output")
    assert status == 200
    assert data == {"output": "streaming...", "is_running": True}


def test_get_heartbeat_tick_output_not_found(api):
    client, db, _ = api
    hid = _make_heartbeat(client, db)
    status, data = client.get(f"/api/heartbeats/{hid}/ticks/99999/output")
    assert status == 404
    assert data["error"] == "not found"


# ── GET: task /messages parsing ──────────────────────────────────────────────


def test_get_task_messages_parses_stream_json(api):
    client, db, _ = api
    tid = _make_task(client)
    run_id = db.add_run(tid)
    # A user turn + an assistant turn + a non-text event + a malformed line.
    lines = [
        json.dumps(
            {
                "type": "user",
                "message": {"content": [{"type": "text", "text": "do X"}]},
            }
        ),
        json.dumps(
            {
                "type": "user",
                "message": {"content": ["string-content-too"]},
            }
        ),
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "text", "text": "did X"},
                        {"type": "tool_use", "name": "bash"},
                    ]
                },
            }
        ),
        json.dumps({"type": "result", "subtype": "success"}),
        "",  # blank line skipped
        "{not valid json",  # JSONDecodeError swallowed
    ]
    db.finish_run(run_id, "completed", raw_output="\n".join(lines))

    status, data = client.get(f"/api/tasks/{tid}/messages")
    assert status == 200
    roles = [(m["role"], m["text"]) for m in data]
    assert ("user", "do X") in roles
    assert ("user", "string-content-too") in roles
    assert ("assistant", "did X") in roles
    # tool_use / result produce no message rows.
    assert all(m["run_id"] == run_id for m in data)
    assert len(data) == 3


# ── GET: DAG listing + task output from a persisted run ──────────────────────


def test_get_dag_tasks(api):
    client, db, _ = api
    tid = _make_task(client, dag_id="dag-abc")
    status, data = client.get("/api/dag/dag-abc")
    assert status == 200
    assert len(data) == 1
    assert data[0]["id"] == tid
    assert data[0]["dependencies"] == []
    assert data[0]["dependents"] == []


def test_task_output_from_finished_run(api):
    client, db, _ = api
    tid = _make_task(client)
    run_id = db.add_run(tid)
    db.finish_run(run_id, "completed", raw_output="final output text")
    status, data = client.get(f"/api/tasks/{tid}/output")
    assert status == 200
    assert data == {"output": "final output text", "is_running": False}


# ── GET: skill content ───────────────────────────────────────────────────────


def test_get_skill_content_ok(api, tmp_path):
    client, db, _ = api
    skill_path = tmp_path / "SKILL.md"
    skill_path.write_text("---\nname: s\n---\nbody here", encoding="utf-8")
    sid = db.add_skill(name="s", description="d", path=str(skill_path))
    status, data = client.get(f"/api/skills/{sid}/content")
    assert status == 200
    assert "body here" in data["content"]
    assert data["path"] == str(skill_path)
    assert data["skill"]["id"] == sid


def test_get_skill_content_missing_file(api):
    client, db, _ = api
    sid = db.add_skill(name="ghost", description="d", path="/no/such/path/SKILL.md")
    status, data = client.get(f"/api/skills/{sid}/content")
    assert status == 200
    assert "无法读取" in data["content"]


def test_get_skill_content_not_found(api):
    client, _, _ = api
    status, data = client.get("/api/skills/99999/content")
    assert status == 404
    assert data["error"] == "not found"


# ── POST: heartbeat run-now / pause / resume found paths ─────────────────────


def test_heartbeat_run_now_ok(api):
    client, db, _ = api
    hid = _make_heartbeat(client, db)
    status, data = client.post(f"/api/heartbeats/{hid}/run-now")
    assert status == 200
    assert data["status"] == "scheduled"
    # next_run_at should have been pulled to "now" so the scheduler picks it up.
    assert db.get_heartbeat(hid)["next_run_at"] is not None


# ── POST: skill draft / approve / dismiss with real patterns ─────────────────


def test_skill_draft_started(api):
    client, db, _ = api
    pid = _make_pattern(db)
    status, data = client.post(f"/api/skill-patterns/{pid}/draft", {"agent": "claude"})
    assert status == 200
    assert data["status"] == "drafting"
    # A draft row in 'drafting' state should now exist.
    draft = db.get_skill_draft(pid)
    assert draft is not None
    assert draft["status"] == "drafting"


def test_skill_approve_ok(api):
    client, db, _ = api
    pid = _make_pattern(db)
    body_md = "---\nname: deploy-flow\ndescription: Deploy the thing reliably\n---\n# Deploy\n"
    status, data = client.post(
        f"/api/skill-patterns/{pid}/approve",
        {"name": "deploy-flow", "description": "ignored", "body": body_md},
    )
    assert status == 200
    assert data["status"] == "approved"
    assert data["skill"]["name"] == "deploy-flow"
    # Frontmatter description wins over the body arg.
    assert data["skill"]["description"] == "Deploy the thing reliably"
    # Pattern promoted, draft cleared.
    assert db.get_skill_pattern(pid)["status"] == "promoted"
    assert db.get_skill_draft(pid) is None


def test_skill_approve_empty_body_400(api):
    client, db, _ = api
    pid = _make_pattern(db)
    status, data = client.post(f"/api/skill-patterns/{pid}/approve", {"name": "x", "body": "   "})
    assert status == 400
    assert "empty" in data["error"]


def test_skill_approve_uses_draft_fallback(api):
    client, db, _ = api
    pid = _make_pattern(db)
    # Pre-seed a draft so the handler falls back to it when body is omitted.
    db.upsert_skill_draft(
        pid,
        "ready",
        name="from-draft",
        description="draft desc",
        body="---\nname: from-draft\ndescription: draft desc\n---\nbody",
    )
    status, data = client.post(f"/api/skill-patterns/{pid}/approve", {})
    assert status == 200
    assert data["skill"]["name"] == "from-draft"


def test_skill_dismiss_ok(api):
    client, db, _ = api
    pid = _make_pattern(db)
    status, data = client.post(f"/api/skill-patterns/{pid}/dismiss", {})
    assert status == 200
    assert data["status"] == "dismissed"
    assert db.get_skill_pattern(pid)["status"] == "dismissed"


def test_skill_sweep_already_running_409(api, monkeypatch):
    client, _, scheduler = api
    monkeypatch.setattr(scheduler, "trigger_skill_sweep", lambda *a, **k: False)
    status, data = client.post("/api/skills/sweep", {"full": False})
    assert status == 409
    assert "already running" in data["error"]


# ── POST: settings sub-key branches ──────────────────────────────────────────


def test_post_feishu_settings_disabled(api):
    client, db, _ = api
    status, data = client.post(
        "/api/feishu/settings",
        {
            "feishu_app_id": "cli_app_12345",
            "feishu_app_secret": "secret_value_here",
            "feishu_default_chat_id": "oc_chat",
            "feishu_enabled": "false",
            "ignored_key": "nope",  # not in the allowed set
        },
    )
    assert status == 200
    assert data["status"] == "updated"
    assert db.get_setting("feishu_app_id") == "cli_app_12345"
    assert db.get_setting("feishu_default_chat_id") == "oc_chat"
    # Disallowed key must not be persisted.
    assert db.get_setting("ignored_key", "__absent__") == "__absent__"
    # No channel should have been started.
    assert TaskAPIHandler.feishu_channel is None


def test_post_channels_settings_all_disabled(api):
    client, db, _ = api
    status, data = client.post(
        "/api/channels/settings",
        {
            "telegram_bot_token": "tg-token",
            "telegram_enabled": "false",
            "slack_bot_token": "sl-bot",
            "slack_app_token": "sl-app",
            "slack_enabled": "false",
            "weixin_enabled": "false",
            "weixin_base_url": "http://localhost:1234",
            "bogus": "x",  # filtered out
        },
    )
    assert status == 200
    assert data["status"] == "updated"
    assert db.get_setting("telegram_bot_token") == "tg-token"
    assert db.get_setting("slack_app_token") == "sl-app"
    assert db.get_setting("weixin_base_url") == "http://localhost:1234"
    assert db.get_setting("bogus", "__absent__") == "__absent__"
    # None of the channels were enabled, so all remain unset.
    assert TaskAPIHandler.telegram_channel is None
    assert TaskAPIHandler.slack_channel is None
    assert TaskAPIHandler.weixin_channel is None


# ── POST: weixin action variants ─────────────────────────────────────────────


def test_weixin_action_logout_not_running(api):
    client, _, _ = api
    status, data = client.post("/api/channels/weixin/action", {"action": "logout"})
    assert status == 400
    assert "not running" in data["error"]


class _FakeWeixinChannel:
    def __init__(self):
        self.login_calls = 0
        self.logout_calls = 0

    def request_login(self):
        self.login_calls += 1

    def request_logout(self):
        self.logout_calls += 1


def test_weixin_action_login_running(api):
    client, _, _ = api
    fake = _FakeWeixinChannel()
    TaskAPIHandler.weixin_channel = fake
    try:
        status, data = client.post("/api/channels/weixin/action", {"action": "login"})
        assert status == 200
        assert data == {"status": "ok", "action": "login"}
        assert fake.login_calls == 1
    finally:
        TaskAPIHandler.weixin_channel = None


def test_weixin_action_logout_running(api):
    client, _, _ = api
    fake = _FakeWeixinChannel()
    TaskAPIHandler.weixin_channel = fake
    try:
        status, data = client.post("/api/channels/weixin/action", {"action": "logout"})
        assert status == 200
        assert data == {"status": "ok", "action": "logout"}
        assert fake.logout_calls == 1
    finally:
        TaskAPIHandler.weixin_channel = None


def test_weixin_action_unsupported_running(api):
    client, _, _ = api
    fake = _FakeWeixinChannel()
    TaskAPIHandler.weixin_channel = fake
    try:
        status, data = client.post("/api/channels/weixin/action", {"action": "frobnicate"})
        assert status == 400
        assert "unsupported" in data["error"]
    finally:
        TaskAPIHandler.weixin_channel = None


# ── POST /api/tasks: JSON-string image fields ────────────────────────────────


def test_create_task_image_fields_as_json_strings(api):
    client, db, _ = api
    status, data = client.post(
        "/api/tasks",
        {
            "prompt": "go",
            "schedule_type": "delayed",
            "delay_seconds": 999,
            "prompt_images": json.dumps(["data:image/png;base64,AAA"]),
            "image_paths": json.dumps(["/tmp/x.png"]),
        },
    )
    assert status == 201
    task = db.get_task(data["id"])
    # get_task deserializes both columns back into Python lists.
    assert task["prompt_images"] == ["data:image/png;base64,AAA"]
    assert task["image_paths"] == ["/tmp/x.png"]


def test_create_task_image_fields_invalid_json_strings(api):
    client, db, _ = api
    status, data = client.post(
        "/api/tasks",
        {
            "prompt": "go",
            "schedule_type": "delayed",
            "delay_seconds": 999,
            "prompt_images": "{bad",
            "image_paths": "{also bad",
        },
    )
    assert status == 201
    task = db.get_task(data["id"])
    # Malformed JSON strings fall back to empty lists.
    assert task["prompt_images"] == []
    assert task["image_paths"] == []


# ── _validate_heartbeat_payload: bool fallback for non-str / non-bool ────────


def test_create_heartbeat_enabled_numeric_coerces(api):
    client, db, _ = api
    # enabled=1 (an int) exercises the `return bool(value)` fallback branch.
    status, created = client.post(
        "/api/heartbeats",
        {
            "name": "hbnum",
            "check_prompt": "watch",
            "schedule_type": "interval",
            "interval_seconds": 60,
            "enabled": 1,
        },
    )
    assert status == 201
    assert db.get_heartbeat(created["id"])["enabled"] is True


# ── POST: add-dependency non-blocking path (upstream already completed) ───────


def test_add_dependency_non_blocking_with_inject(api):
    client, db, _ = api
    upstream = _make_task(client)
    db.update_task(upstream, status="completed")  # done → no blocking branch (avoids _notify bug)
    downstream = _make_task(client)
    status, data = client.post(
        f"/api/tasks/{downstream}/dependencies",
        {"depends_on_task_id": upstream, "inject_result": True},
    )
    assert status == 200
    assert data["status"] == "added"
    deps = db.get_dependencies(downstream)
    assert deps[0]["depends_on_task_id"] == upstream
    assert deps[0]["inject_result"] in (1, True)
    # Downstream stayed unblocked because the upstream is already complete.
    assert db.get_task(downstream)["status"] != "blocked"


# ── PUT: task schedule recalculation branches ────────────────────────────────


def test_put_task_to_immediate_clears_schedule(api):
    client, db, _ = api
    tid = _make_task(client, schedule_type="cron", cron_expr="0 3 * * *")
    status, data = client.put(f"/api/tasks/{tid}", {"schedule_type": "immediate"})
    assert status == 200
    assert data["status"] == "pending"
    task = db.get_task(tid)
    assert task["next_run_at"] is None
    assert task["cron_expr"] is None


def test_put_task_to_delayed(api):
    client, db, _ = api
    tid = _make_task(client, schedule_type="cron", cron_expr="0 3 * * *")
    status, data = client.put(
        f"/api/tasks/{tid}", {"schedule_type": "delayed", "delay_seconds": 30}
    )
    assert status == 200
    task = db.get_task(tid)
    assert task["status"] == "pending"
    assert task["cron_expr"] is None


def test_put_task_to_scheduled_at_ok(api):
    client, db, _ = api
    tid = _make_task(client)
    status, data = client.put(
        f"/api/tasks/{tid}",
        {"schedule_type": "scheduled_at", "next_run_at": "2030-01-01T09:00:00"},
    )
    assert status == 200
    task = db.get_task(tid)
    assert task["status"] == "scheduled"
    assert task["next_run_at"] == "2030-01-01T09:00:00"
    assert task["cron_expr"] is None


def test_put_task_to_cron_computes_next_run(api):
    client, db, _ = api
    tid = _make_task(client)
    status, data = client.put(
        f"/api/tasks/{tid}", {"schedule_type": "cron", "cron_expr": "0 3 * * *"}
    )
    assert status == 200
    task = db.get_task(tid)
    assert task["status"] == "scheduled"
    assert task["next_run_at"] is not None
    assert task["delay_seconds"] is None


def test_put_task_with_images_and_deps(api):
    client, db, _ = api
    upstream = _make_task(client)  # delayed, NOT completed → downstream should block
    tid = _make_task(client)
    status, data = client.put(
        f"/api/tasks/{tid}",
        {
            "prompt_images": json.dumps(["data:image/png;base64,AAA"]),
            "image_paths": '["/tmp/a.png"]',
            "depends_on": [{"task_id": upstream, "inject_result": True}],
        },
    )
    assert status == 200
    task = db.get_task(tid)
    # Unmet dependency → blocked.
    assert task["status"] == "blocked"
    deps = db.get_dependencies(tid)
    assert deps[0]["depends_on_task_id"] == upstream
    assert deps[0]["inject_result"] in (1, True)
    assert data["dependencies"][0]["depends_on_task_id"] == upstream


def test_put_task_invalid_image_strings_default_to_empty(api):
    client, db, _ = api
    tid = _make_task(client)
    status, data = client.put(
        f"/api/tasks/{tid}",
        {"prompt_images": "{bad json", "image_paths": "{also bad"},
    )
    assert status == 200
    task = db.get_task(tid)
    assert task["prompt_images"] == []
    assert task["image_paths"] == []


def test_put_task_invalid_id_400(api):
    client, _, _ = api
    status, data = client.put("/api/tasks/notanumber", {"prompt": "x"})
    assert status == 400
    assert data["error"] == "invalid task id"


def test_put_task_bad_working_dir(api):
    client, _, _ = api
    tid = _make_task(client)
    status, data = client.put(f"/api/tasks/{tid}", {"working_dir": "/nonexistent/zzz"})
    assert status == 400
    assert data["field"] == "working_dir"


def test_put_task_cron_missing_expr(api):
    client, db, _ = api
    tid = _make_task(client)
    # Clear cron_expr so the cron branch hits the "required" error.
    db.update_task(tid, cron_expr=None)
    status, data = client.put(f"/api/tasks/{tid}", {"schedule_type": "cron"})
    assert status == 400
    assert data["field"] == "cron_expr"


# ── PUT: skill invalid id ────────────────────────────────────────────────────


def test_put_skill_invalid_id_400(api):
    client, _, _ = api
    status, data = client.put("/api/skills/notanumber", {"enabled": True})
    assert status == 400
    assert data["error"] == "invalid skill id"


# ── PUT: heartbeat invalid-payload branch (validation error surfaced) ────────


def test_put_heartbeat_invalid_interval(api):
    client, db, _ = api
    hid = _make_heartbeat(client, db)
    status, data = client.put(
        f"/api/heartbeats/{hid}",
        {"schedule_type": "interval", "interval_seconds": 0},
    )
    assert status == 400
    assert data["field"] == "interval_seconds"


def test_put_heartbeat_invalid_id_400(api):
    client, _, _ = api
    status, data = client.put("/api/heartbeats/notanumber", {"name": "x"})
    # path.count("/") == 3 but int() fails → invalid id branch
    assert status == 400
    assert data["error"] == "invalid heartbeat id"


# ── DELETE: skill invalid id + not found ─────────────────────────────────────


def test_delete_skill_invalid_id_400(api):
    client, _, _ = api
    status, data = client.delete("/api/skills/notanumber")
    assert status == 400
    assert data["error"] == "invalid skill id"


def test_delete_skill_ok(api):
    client, db, _ = api
    sid = db.add_skill(name="bye", description="d", path="/tmp/bye.md")
    status, data = client.delete(f"/api/skills/{sid}")
    assert status == 200
    assert data["status"] == "deleted"
    assert db.get_skill(sid) is None


# ── _validate_heartbeat_payload bool coercion (string "true"/"false") ────────


def test_create_heartbeat_enabled_string_true(api):
    client, db, _ = api
    status, created = client.post(
        "/api/heartbeats",
        {
            "name": "hb",
            "check_prompt": "watch",
            "schedule_type": "interval",
            "interval_seconds": 60,
            "enabled": "true",
        },
    )
    assert status == 201
    assert db.get_heartbeat(created["id"])["enabled"] is True


def test_create_heartbeat_enabled_string_false(api):
    client, db, _ = api
    status, created = client.post(
        "/api/heartbeats",
        {
            "name": "hb2",
            "check_prompt": "watch",
            "schedule_type": "interval",
            "interval_seconds": 60,
            "enabled": "false",
        },
    )
    assert status == 201
    assert db.get_heartbeat(created["id"])["enabled"] is False
