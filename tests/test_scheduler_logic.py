"""Direct unit tests for TaskScheduler logic not exercised by HTTP tests.

Covers schedule computation / due dispatch (_tick, _schedule_delayed), heartbeat
decision flow (idle / notify / suppressed / error), heartbeat next-run + cooldown
suppression, skill sweep core (run_skill_sweep, _parse_sweep_output,
_build_sweep_prompt), distill prompt building, submit_task dependency gating, and
the DAG unblock / cascade-cancel helpers. All agent execution is mocked — no real
subprocess or network is ever spawned, and the background loop is never started.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest

from taskboard import (
    Heartbeat,
    HeartbeatDecisionType,
    HeartbeatScheduleType,
    ScheduleType,
    Task,
    TaskDB,
    TaskScheduler,
)


def make_db(tmp_path):
    return TaskDB(str(tmp_path / "sched-test.db"))


def make_heartbeat(**overrides):
    data = {
        "name": "Repo watcher",
        "working_dir": ".",
        "schedule_type": HeartbeatScheduleType.INTERVAL,
        "interval_seconds": 60,
        "check_prompt": "Inspect repo.",
        "action_prompt_template": "Review the latest changes.",
        "default_agent": "claude",
        "cooldown_seconds": 300,
    }
    data.update(overrides)
    return Heartbeat(**data)


# ── heartbeat next-run computation ──────────────────────────────────────────
def test_compute_next_run_interval(tmp_path):
    db = make_db(tmp_path)
    now = datetime(2024, 1, 1, 12, 0, 0)
    nxt = db._compute_heartbeat_next_run_at(make_heartbeat(interval_seconds=90), now)
    assert nxt == (now + timedelta(seconds=90)).isoformat()


def test_compute_next_run_cron(tmp_path):
    db = make_db(tmp_path)
    now = datetime(2024, 1, 1, 12, 30, 0)
    hb = make_heartbeat(
        schedule_type=HeartbeatScheduleType.CRON, cron_expr="0 * * * *", interval_seconds=None
    )
    nxt = db._compute_heartbeat_next_run_at(hb, now)
    assert nxt == datetime(2024, 1, 1, 13, 0, 0).isoformat()


def test_compute_next_run_invalid_raises(tmp_path):
    db = make_db(tmp_path)
    with pytest.raises(ValueError, match="interval_seconds"):
        db._compute_heartbeat_next_run_at(make_heartbeat(interval_seconds=0), datetime.now())
    with pytest.raises(ValueError, match="cron_expr"):
        db._compute_heartbeat_next_run_at(
            make_heartbeat(schedule_type=HeartbeatScheduleType.CRON, cron_expr=None),
            datetime.now(),
        )


# ── _tick dispatch by schedule type ─────────────────────────────────────────
def test_tick_promotes_delayed_pending_to_scheduled(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(
        Task(
            title="delayed",
            prompt="p",
            working_dir=".",
            schedule_type=ScheduleType.DELAYED,
            delay_seconds=120,
        )
    )
    spawned = []
    monkeypatch.setattr(sched, "_spawn_task", lambda t: spawned.append(t["id"]))

    sched._tick()  # pending delayed → schedules forward, does not spawn yet

    assert spawned == []
    task = db.get_task(tid)
    assert task["status"] == "scheduled"
    nra = datetime.fromisoformat(task["next_run_at"])
    assert nra > datetime.now()


def test_tick_spawns_immediate_and_due_cron(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    imm = db.add_task(Task(title="imm", prompt="p", working_dir="."))
    cron = db.add_task(
        Task(
            title="cron",
            prompt="p",
            working_dir=".",
            schedule_type=ScheduleType.CRON,
            cron_expr="* * * * *",
            next_run_at=(datetime.now() - timedelta(minutes=1)).isoformat(),
        )
    )
    db.update_task(cron, status="scheduled")

    spawned = []
    monkeypatch.setattr(sched, "_spawn_task", lambda t: spawned.append(t["id"]))

    sched._tick()

    assert imm in spawned
    assert cron in spawned


def test_tick_skips_active_task(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="imm", prompt="p", working_dir="."))

    class _AliveThread:
        def is_alive(self):
            return True

    sched._active_tasks[tid] = _AliveThread()
    spawned = []
    monkeypatch.setattr(sched, "_spawn_task", lambda t: spawned.append(t["id"]))

    sched._tick()
    assert spawned == []  # already running, not re-picked


def test_tick_shutting_down_is_noop(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    db.add_task(Task(title="imm", prompt="p", working_dir="."))
    sched._shutting_down = True
    called = []
    monkeypatch.setattr(sched, "_spawn_task", lambda t: called.append(t))
    sched._tick()
    assert called == []


def test_schedule_delayed_uses_delay_seconds(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(
        Task(
            title="d",
            prompt="p",
            working_dir=".",
            schedule_type=ScheduleType.DELAYED,
            delay_seconds=300,
        )
    )
    before = datetime.now()
    sched._schedule_delayed(db.get_task(tid))
    task = db.get_task(tid)
    assert task["status"] == "scheduled"
    nra = datetime.fromisoformat(task["next_run_at"])
    assert before + timedelta(seconds=299) <= nra <= before + timedelta(seconds=301)


# ── submit_task scheduling / dependency gating ──────────────────────────────
def test_submit_task_cron_sets_next_run(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = sched.submit_task(
        Task(
            title="c",
            prompt="p",
            working_dir=".",
            schedule_type=ScheduleType.CRON,
            cron_expr="0 0 * * *",
        )
    )
    task = db.get_task(tid)
    assert task["status"] == "scheduled"
    assert task["next_run_at"] is not None
    assert datetime.fromisoformat(task["next_run_at"]) > datetime.now()


def test_submit_task_scheduled_at_requires_next_run(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    with pytest.raises(ValueError, match="next_run_at"):
        sched.submit_task(
            Task(title="s", prompt="p", working_dir=".", schedule_type=ScheduleType.SCHEDULED_AT)
        )


def test_submit_task_blocks_on_unmet_dependency(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    upstream = db.add_task(Task(title="up", prompt="p", working_dir="."))  # pending, not completed
    down = sched.submit_task(
        Task(title="down", prompt="p", working_dir="."),
        depends_on=[{"task_id": upstream, "inject_result": True}],
    )
    assert db.get_task(down)["status"] == "blocked"
    deps = db.get_dependencies(down)
    assert deps[0]["depends_on_task_id"] == upstream
    assert deps[0]["inject_result"] == 1


def test_submit_task_ready_when_dependency_completed(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    upstream = db.add_task(Task(title="up", prompt="p", working_dir="."))
    db.update_task(upstream, status="completed")
    down = sched.submit_task(
        Task(title="down", prompt="p", working_dir="."),
        depends_on=[upstream],  # bare int form
    )
    assert db.get_task(down)["status"] == "pending"


# ── DAG unblock / cascade-cancel ────────────────────────────────────────────
def test_on_task_completed_unblocks_downstream(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    up = db.add_task(Task(title="up", prompt="p", working_dir="."))
    down = sched.submit_task(Task(title="down", prompt="p", working_dir="."), depends_on=[up])
    assert db.get_task(down)["status"] == "blocked"

    db.update_task(up, status="completed")
    sched._on_task_completed(up)

    assert db.get_task(down)["status"] == "pending"


def test_on_task_completed_keeps_blocked_when_other_dep_pending(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    a = db.add_task(Task(title="a", prompt="p", working_dir="."))
    b = db.add_task(Task(title="b", prompt="p", working_dir="."))
    down = sched.submit_task(Task(title="down", prompt="p", working_dir="."), depends_on=[a, b])

    db.update_task(a, status="completed")
    sched._on_task_completed(a)
    # b still pending → stays blocked
    assert db.get_task(down)["status"] == "blocked"


def test_on_task_failed_cascade_cancels(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    root = db.add_task(Task(title="root", prompt="p", working_dir="."))
    mid = sched.submit_task(Task(title="mid", prompt="p", working_dir="."), depends_on=[root])
    leaf = sched.submit_task(Task(title="leaf", prompt="p", working_dir="."), depends_on=[mid])

    sched._on_task_failed(root)

    assert db.get_task(mid)["status"] == "cancelled"
    assert db.get_task(leaf)["status"] == "cancelled"  # recursive cascade
    assert f"#{root}" in db.get_task(mid)["error"]


def test_build_injected_prompt_prepends_upstream_result(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    up = db.add_task(Task(title="upstream", prompt="p", working_dir="."))
    db.update_task(up, status="completed", result="UPSTREAM OUTPUT")
    down = db.add_task(Task(title="down", prompt="DO THE THING", working_dir="."))
    db.add_dependency(down, up, inject_result=True)

    injected = sched._build_injected_prompt(db.get_task(down))
    assert "UPSTREAM OUTPUT" in injected
    assert injected.strip().endswith("DO THE THING")


def test_build_injected_prompt_without_inject_returns_original(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    up = db.add_task(Task(title="upstream", prompt="p", working_dir="."))
    db.update_task(up, status="completed", result="X")
    down = db.add_task(Task(title="down", prompt="ORIGINAL", working_dir="."))
    db.add_dependency(down, up, inject_result=False)
    assert sched._build_injected_prompt(db.get_task(down)) == "ORIGINAL"


# ── cancel / retry ──────────────────────────────────────────────────────────
def test_cancel_and_retry_task(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    db.update_task(tid, status="running")

    sched.cancel_task(tid)
    assert db.get_task(tid)["status"] == "cancelled"

    db.update_task(tid, status="failed", error="boom")
    sched.retry_task(tid)
    retried = db.get_task(tid)
    assert retried["status"] == "pending"
    assert retried["error"] is None


# ── heartbeat decision parsing ──────────────────────────────────────────────
def test_parse_heartbeat_decision_strips_fence_and_normalizes(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    raw = '```json\n{"decision":"idle","reason":"nothing"}\n```'
    decision = sched._parse_heartbeat_decision(raw)
    assert decision["decision"] == "idle"
    assert decision["reason"] == "nothing"
    # missing fields are coerced to defaults
    assert decision["title"] == ""
    assert decision["metadata"] == {}


def test_parse_heartbeat_decision_extracts_embedded_object(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    raw = 'noise before {"decision":"trigger_task","dedupe_key":"k"} noise after'
    decision = sched._parse_heartbeat_decision(raw)
    assert decision["decision"] == "trigger_task"
    assert decision["dedupe_key"] == "k"


def test_parse_heartbeat_decision_invalid_decision_raises(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    with pytest.raises(ValueError, match="Invalid heartbeat decision"):
        sched._parse_heartbeat_decision('{"decision":"explode"}')


def test_parse_heartbeat_decision_non_dict_metadata_raises(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    with pytest.raises(ValueError, match="metadata must be an object"):
        sched._parse_heartbeat_decision('{"decision":"idle","metadata":[1,2]}')


def test_render_heartbeat_check_prompt_includes_action_template(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat(action_prompt_template="REVIEW THE DIFF"))
    prompt = sched._render_heartbeat_check_prompt(db.get_heartbeat(hid))
    assert "Inspect repo." in prompt
    assert "REVIEW THE DIFF" in prompt
    assert "trigger_task" in prompt


# ── heartbeat tick execution flow ───────────────────────────────────────────
def _mock_agent(sched, monkeypatch, payload):
    def fake_run(agent, cmd, cwd, on_stdout_line=None, on_stderr_line=None):
        if on_stdout_line:
            on_stdout_line(payload)
        return True, payload

    monkeypatch.setattr(sched, "_run_agent_command", fake_run)


def test_execute_heartbeat_idle_decision(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat())
    _mock_agent(sched, monkeypatch, json.dumps({"decision": "idle", "reason": "calm"}))

    sched._execute_heartbeat(db.get_heartbeat(hid))

    assert db.get_all_tasks() == []
    hb = db.get_heartbeat(hid)
    assert hb["last_decision"] == HeartbeatDecisionType.IDLE.value
    assert hb["last_error"] is None
    # next_run_at advanced
    assert datetime.fromisoformat(hb["next_run_at"]) > datetime.now()
    tick = db.get_latest_heartbeat_tick(hid)
    assert tick["status"] == "idle"


def test_execute_heartbeat_notify_only_records_decision(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat())
    _mock_agent(
        sched,
        monkeypatch,
        json.dumps({"decision": "notify_only", "reason": "FYI", "dedupe_key": "n1"}),
    )

    sched._execute_heartbeat(db.get_heartbeat(hid))

    assert db.get_all_tasks() == []  # notify does not create a task
    hb = db.get_heartbeat(hid)
    assert hb["last_decision"] == HeartbeatDecisionType.NOTIFY_ONLY.value
    tick = db.get_latest_heartbeat_tick(hid)
    assert tick["status"] == HeartbeatDecisionType.NOTIFY_ONLY.value


def test_execute_heartbeat_trigger_falls_back_to_action_template(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat(action_prompt_template="DEFAULT ACTION"))
    # decision has no prompt/title → falls back to action_prompt_template + default title
    _mock_agent(
        sched,
        monkeypatch,
        json.dumps({"decision": "trigger_task", "dedupe_key": "dk"}),
    )

    sched._execute_heartbeat(db.get_heartbeat(hid))

    tasks = db.get_all_tasks()
    assert len(tasks) == 1
    assert tasks[0]["prompt"] == "DEFAULT ACTION"
    assert tasks[0]["title"] == "Heartbeat: Repo watcher"
    assert tasks[0]["tags"] == "heartbeat"
    # dedup row recorded
    assert db.get_heartbeat_dedup(hid, "dk") is not None


def test_execute_heartbeat_agent_failure_records_error(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat())

    def fail(agent, cmd, cwd, on_stdout_line=None, on_stderr_line=None):
        return False, "agent crashed"

    monkeypatch.setattr(sched, "_run_agent_command", fail)

    sched._execute_heartbeat(db.get_heartbeat(hid))

    hb = db.get_heartbeat(hid)
    assert hb["last_decision"] == HeartbeatDecisionType.ERROR.value
    assert "agent crashed" in hb["last_error"]
    assert db.get_latest_heartbeat_tick(hid)["status"] == "error"


# ── heartbeat cooldown suppression ──────────────────────────────────────────
def test_trigger_suppressed_empty_key_is_false(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    assert sched._heartbeat_trigger_suppressed({"id": 1, "cooldown_seconds": 300}, "") is False


def test_trigger_suppressed_during_cooldown(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat(cooldown_seconds=600))
    db.upsert_heartbeat_dedup(hid, "k", None)  # triggered now
    assert sched._heartbeat_trigger_suppressed(db.get_heartbeat(hid), "k") is True


def test_trigger_not_suppressed_after_cooldown_when_no_active_task(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat(cooldown_seconds=60))
    db.upsert_heartbeat_dedup(hid, "k", None)
    # age the dedup row past the cooldown
    old = (datetime.now() - timedelta(seconds=120)).isoformat()
    db.conn.execute(
        "UPDATE heartbeat_dedup SET triggered_at=? WHERE heartbeat_id=? AND dedupe_key=?",
        (old, hid, "k"),
    )
    db.conn.commit()
    assert sched._heartbeat_trigger_suppressed(db.get_heartbeat(hid), "k") is False


def test_trigger_suppressed_while_prior_task_active(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat(cooldown_seconds=0))  # no cooldown
    task_id = db.add_task(Task(title="t", prompt="p", working_dir="."))  # pending = active
    db.upsert_heartbeat_dedup(hid, "k", task_id)
    assert sched._heartbeat_trigger_suppressed(db.get_heartbeat(hid), "k") is True

    # once that task completes, the signal is no longer suppressed
    db.update_task(task_id, status="completed")
    assert sched._heartbeat_trigger_suppressed(db.get_heartbeat(hid), "k") is False


# ── trigger_heartbeat_now ───────────────────────────────────────────────────
def test_trigger_heartbeat_now_unknown_raises(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    with pytest.raises(ValueError, match="not found"):
        sched.trigger_heartbeat_now(99999)


# ── skill sweep core ────────────────────────────────────────────────────────
def test_parse_sweep_output_variants(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    assert sched._parse_sweep_output("[]") == []
    fenced = '```json\n[{"pattern_key":"k"}]\n```'
    assert sched._parse_sweep_output(fenced) == [{"pattern_key": "k"}]
    embedded = 'prose [{"pattern_key":"k2"}] tail'
    assert sched._parse_sweep_output(embedded) == [{"pattern_key": "k2"}]
    # non-array / garbage → empty list, never raises
    assert sched._parse_sweep_output('{"a":1}') == []
    assert sched._parse_sweep_output("not json") == []
    assert sched._parse_sweep_output("") == []


def test_run_skill_sweep_no_runs_short_circuits(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    called = []
    monkeypatch.setattr(
        sched, "_run_agent_prompt_once", lambda *a, **k: called.append(a) or (True, "[]")
    )

    result = sched.run_skill_sweep(agent="claude")

    assert result["scanned"] == 0
    assert result["detected"] == 0
    assert called == []  # never invokes the agent when there's nothing to scan


def test_run_skill_sweep_detects_and_advances_watermark(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="t", prompt="run pytest", working_dir="."))
    r1 = db.add_run(tid)
    r2 = db.add_run(tid)
    db.conn.execute(
        "UPDATE task_runs SET status='completed', finished_at=? WHERE id=?",
        ("2024-01-01T00:00:00", r1),
    )
    db.conn.execute(
        "UPDATE task_runs SET status='completed', finished_at=? WHERE id=?",
        ("2024-01-02T00:00:00", r2),
    )
    db.conn.commit()

    # agent reuses the same pattern_key across both runs → recurrence aggregates
    sweep_output = json.dumps(
        [
            {
                "pattern_key": "run-pytest",
                "kind": "recipe",
                "summary": "s",
                "run_id": r1,
                "task_id": tid,
            },
            {
                "pattern_key": "run-pytest",
                "kind": "recipe",
                "summary": "s",
                "run_id": r2,
                "task_id": tid,
            },
        ]
    )
    monkeypatch.setattr(sched, "_run_agent_prompt_once", lambda *a, **k: (True, sweep_output))

    result = sched.run_skill_sweep(agent="claude", full=True)

    assert result["scanned"] == 2
    assert result["detected"] == 2
    assert result["new"] == 2
    assert db.get_skill_pattern_recurrence("run-pytest") == 2
    # watermark advanced to the newest finished_at
    assert db.get_setting("skill_sweep_watermark") == "2024-01-02T00:00:00"


def test_run_skill_sweep_agent_failure_raises(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    rid = db.add_run(tid)
    db.conn.execute(
        "UPDATE task_runs SET status='completed', finished_at=? WHERE id=?",
        ("2024-01-01T00:00:00", rid),
    )
    db.conn.commit()
    monkeypatch.setattr(sched, "_run_agent_prompt_once", lambda *a, **k: (False, "kaboom"))
    with pytest.raises(RuntimeError, match="kaboom"):
        sched.run_skill_sweep(agent="claude", full=True)


def test_run_skill_sweep_full_ignores_watermark(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    rid = db.add_run(tid)
    db.conn.execute(
        "UPDATE task_runs SET status='completed', finished_at=? WHERE id=?",
        ("2024-01-01T00:00:00", rid),
    )
    db.conn.commit()
    # watermark is past the run; full=True must still re-scan it
    db.set_setting("skill_sweep_watermark", "2030-01-01T00:00:00")
    monkeypatch.setattr(sched, "_run_agent_prompt_once", lambda *a, **k: (True, "[]"))

    result = sched.run_skill_sweep(agent="claude", full=True)
    assert result["scanned"] == 1


def test_skill_sweep_status_reflects_last_result(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    monkeypatch.setattr(sched, "_run_agent_prompt_once", lambda *a, **k: (True, "[]"))
    sched.run_skill_sweep(agent="claude")  # no runs → cached as last
    status = sched.skill_sweep_status()
    assert status["running"] is False
    assert status["last"]["scanned"] == 0


# ── prompt builders ─────────────────────────────────────────────────────────
def test_build_sweep_prompt_lists_existing_and_runs(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    runs = [
        {
            "run_id": 5,
            "task_id": 2,
            "title": "Run tests",
            "prompt": "uv run pytest",
            "result": "all green",
        }
    ]
    existing = [
        {"pattern_key": "run-pytest", "kind": "recipe", "recurrence_count": 3, "summary": "tests"}
    ]
    prompt = sched._build_sweep_prompt(runs, existing)
    assert "run-pytest" in prompt
    assert "run #5" in prompt
    assert "uv run pytest" in prompt
    # empty existing renders the placeholder
    assert "(none yet)" in sched._build_sweep_prompt(runs, [])


def test_build_distill_context_and_prompt(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="Run tests", prompt="run pytest", working_dir="."))
    rid = db.add_run(tid)
    db.finish_run(rid, status="completed", result="green")

    context = sched._build_distill_context([tid])
    assert f"task #{tid}" in context
    assert "run pytest" in context
    assert "green" in context

    pattern = db.get_skill_pattern(db.upsert_skill_pattern("k", "recipe", "summary", tid))
    with_creator = sched._build_distill_prompt(pattern, context, skill_creator_rel="a/SKILL.md")
    assert "skill-creator" in with_creator
    assert "a/SKILL.md" in with_creator
    without_creator = sched._build_distill_prompt(pattern, context, skill_creator_rel=None)
    assert "a/SKILL.md" not in without_creator
    assert "skill-creator conventions" in without_creator


# ── timezone normalization on submit (scheduled_at) ─────────────────────────
def test_submit_scheduled_at_naive_passthrough(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    naive = (datetime.now() + timedelta(hours=2)).replace(microsecond=0).isoformat()
    tid = sched.submit_task(
        Task(
            title="s",
            prompt="p",
            working_dir=".",
            schedule_type=ScheduleType.SCHEDULED_AT,
            next_run_at=naive,
        )
    )
    # naive input is stored unchanged (no tz shift)
    assert db.get_task(tid)["next_run_at"] == naive


def test_submit_scheduled_at_aware_is_localized(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    aware = datetime.now(timezone.utc) + timedelta(hours=3)
    tid = sched.submit_task(
        Task(
            title="s",
            prompt="p",
            working_dir=".",
            schedule_type=ScheduleType.SCHEDULED_AT,
            next_run_at=aware.isoformat(),
        )
    )
    expected = aware.astimezone().replace(tzinfo=None).isoformat()
    assert db.get_task(tid)["next_run_at"] == expected
