"""Direct unit tests for TaskDB internals not exercised by HTTP CRUD tests.

Covers: settings, run history, output events, completed-run queries used by the
skill sweep, skill_patterns ledger (idempotent recurrence counting), draft
upsert/clear, candidate refresh windowing, dependency rows, and cascading
delete. Constructs TaskDB directly against a tmp_path SQLite file.
"""

import json
from datetime import datetime, timedelta

from taskboard import ScheduleType, Task, TaskDB


def make_db(tmp_path):
    return TaskDB(str(tmp_path / "taskdb-test.db"))


# ── settings ────────────────────────────────────────────────────────────────
def test_settings_get_default_and_set_overwrite(tmp_path):
    db = make_db(tmp_path)
    assert db.get_setting("missing") is None
    assert db.get_setting("missing", "fallback") == "fallback"
    db.set_setting("k", "v1")
    assert db.get_setting("k") == "v1"
    db.set_setting("k", "v2")  # INSERT OR REPLACE
    assert db.get_setting("k") == "v2"


# ── run history ─────────────────────────────────────────────────────────────
def test_run_lifecycle_and_ordering(tmp_path):
    db = make_db(tmp_path)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    run1 = db.add_run(tid)
    db.finish_run(run1, status="completed", result="ok", raw_output="raw1")
    run2 = db.add_run(tid)
    db.finish_run(run2, status="failed", error="boom")

    runs = db.get_task_runs(tid)
    assert {r["status"] for r in runs} == {"completed", "failed"}
    assert {r["id"] for r in runs} == {run1, run2}
    completed = next(r for r in runs if r["id"] == run1)
    assert completed["result"] == "ok"
    assert completed["raw_output"] == "raw1"
    assert completed["finished_at"] is not None


def test_finish_run_and_update_task_is_atomic(tmp_path):
    db = make_db(tmp_path)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    rid = db.add_run(tid)

    db.finish_run_and_update_task(
        rid,
        run_status="completed",
        task_id=tid,
        task_updates={"status": "completed", "result": "done", "run_count": 1},
        run_result="done",
    )

    run = db.get_task_runs(tid)[0]
    assert run["status"] == "completed"
    assert run["result"] == "done"
    task = db.get_task(tid)
    assert task["status"] == "completed"
    assert task["result"] == "done"
    assert task["run_count"] == 1


# ── output events ───────────────────────────────────────────────────────────
def test_output_events_per_task_and_per_run(tmp_path):
    db = make_db(tmp_path)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    run1 = db.add_run(tid)
    run2 = db.add_run(tid)
    db.add_output_event(tid, run1, "assistant", "hello")
    db.add_output_event(tid, run1, "result", "done")
    db.add_output_event(tid, run2, "assistant", "second run")

    all_events = db.get_output_events(tid)
    assert len(all_events) == 3

    # offset/limit paging (events ordered DESC by timestamp)
    page = db.get_output_events(tid, limit=1, offset=0)
    assert len(page) == 1

    run1_events = db.get_run_output_events(run1)
    assert [e["content"] for e in run1_events] == ["hello", "done"]  # ASC order
    run2_events = db.get_run_output_events(run2)
    assert [e["content"] for e in run2_events] == ["second run"]


# ── completed-run queries (skill sweep inputs) ──────────────────────────────
def _finish_with_timestamp(db, run_id, finished_at):
    db.conn.execute(
        "UPDATE task_runs SET status='completed', finished_at=? WHERE id=?",
        (finished_at, run_id),
    )
    db.conn.commit()


def test_get_completed_runs_since_watermark(tmp_path):
    db = make_db(tmp_path)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    old = db.add_run(tid)
    new = db.add_run(tid)
    _finish_with_timestamp(db, old, "2020-01-01T00:00:00")
    _finish_with_timestamp(db, new, "2025-01-01T00:00:00")

    after = db.get_completed_runs_since("2023-01-01T00:00:00")
    assert [r["run_id"] for r in after] == [new]
    # joined task metadata is present
    assert after[0]["title"] == "t"
    assert after[0]["prompt"] == "p"

    everything = db.get_completed_runs_since("")
    assert [r["run_id"] for r in everything] == [old, new]  # oldest first


def test_get_recent_completed_runs_oldest_first_with_limit(tmp_path):
    db = make_db(tmp_path)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    r1 = db.add_run(tid)
    r2 = db.add_run(tid)
    r3 = db.add_run(tid)
    _finish_with_timestamp(db, r1, "2024-01-01T00:00:00")
    _finish_with_timestamp(db, r2, "2024-01-02T00:00:00")
    _finish_with_timestamp(db, r3, "2024-01-03T00:00:00")

    recent = db.get_recent_completed_runs(limit=2)
    # picks the 2 newest, returns them oldest-first
    assert [r["run_id"] for r in recent] == [r2, r3]


# ── skill_patterns ledger ───────────────────────────────────────────────────
def test_upsert_skill_pattern_blank_key_returns_none(tmp_path):
    db = make_db(tmp_path)
    assert db.upsert_skill_pattern("   ", "recipe", "s", 1) is None


def test_upsert_skill_pattern_idempotent_per_run(tmp_path):
    db = make_db(tmp_path)
    pid = db.upsert_skill_pattern("k", "recipe", "first", 1, run_id=10)
    assert db.get_skill_pattern_recurrence("k") == 1

    # same run_id again → no recurrence bump, but summary refreshes
    same = db.upsert_skill_pattern("k", "recipe", "updated", 1, run_id=10)
    assert same == pid
    assert db.get_skill_pattern_recurrence("k") == 1
    assert db.get_skill_pattern(pid)["summary"] == "updated"

    # new run_id → recurrence bumps and task list grows
    db.upsert_skill_pattern("k", "recipe", "", 2, run_id=11)
    assert db.get_skill_pattern_recurrence("k") == 2
    pattern = db.get_skill_pattern(pid)
    assert sorted(json.loads(pattern["contributing_task_ids"])) == [1, 2]
    assert sorted(json.loads(pattern["contributing_run_ids"])) == [10, 11]
    # empty summary must NOT clobber the prior one
    assert pattern["summary"] == "updated"


def test_upsert_skill_pattern_no_run_id_bumps_each_call(tmp_path):
    db = make_db(tmp_path)
    db.upsert_skill_pattern("legacy", "recipe", "s", 1)
    db.upsert_skill_pattern("legacy", "recipe", "s", 1)
    assert db.get_skill_pattern_recurrence("legacy") == 2


def test_upsert_skill_pattern_invalid_kind_falls_back(tmp_path):
    db = make_db(tmp_path)
    pid = db.upsert_skill_pattern("k", "nonsense-kind", "s", 1)
    assert db.get_skill_pattern(pid)["kind"] == "recipe"


def test_get_skill_pattern_recurrence_unknown_is_zero(tmp_path):
    db = make_db(tmp_path)
    assert db.get_skill_pattern_recurrence("does-not-exist") == 0
    assert db.get_skill_pattern_recurrence("") == 0


def test_within_window(tmp_path):
    db = make_db(tmp_path)
    first = "2024-01-01T00:00:00"
    inside = "2024-01-20T00:00:00"
    outside = "2024-03-01T00:00:00"
    assert db._within_window(first, inside, 30) is True
    assert db._within_window(first, outside, 30) is False
    # unparseable timestamps don't block promotion
    assert db._within_window("garbage", "garbage", 30) is True


def test_set_skill_pattern_status_with_promoted_id(tmp_path):
    db = make_db(tmp_path)
    pid = db.upsert_skill_pattern("k", "recipe", "s", 1)
    db.set_skill_pattern_status(pid, "promoted", promoted_skill_id=42)
    row = db.get_skill_pattern(pid)
    assert row["status"] == "promoted"
    assert row["promoted_skill_id"] == 42


# ── skill drafts ────────────────────────────────────────────────────────────
def test_skill_draft_upsert_conflict_and_delete(tmp_path):
    db = make_db(tmp_path)
    pid = db.upsert_skill_pattern("k", "recipe", "s", 1)
    db.upsert_skill_draft(pid, "drafting", kind="recipe")
    assert db.get_skill_draft(pid)["status"] == "drafting"

    # ON CONFLICT(pattern_id) updates in place
    db.upsert_skill_draft(
        pid, "ready", name="my-skill", body="b", worthy=True, worthiness_reason="reusable"
    )
    draft = db.get_skill_draft(pid)
    assert draft["status"] == "ready"
    assert draft["name"] == "my-skill"
    assert draft["worthy"] == 1

    db.delete_skill_draft(pid)
    assert db.get_skill_draft(pid) is None


def test_skill_draft_worthy_none_stored_as_null(tmp_path):
    db = make_db(tmp_path)
    pid = db.upsert_skill_pattern("k", "recipe", "s", 1)
    db.upsert_skill_draft(pid, "ready", worthy=None)
    assert db.get_skill_draft(pid)["worthy"] is None


# ── dependencies / DAG ──────────────────────────────────────────────────────
def test_dependency_crud_and_views(tmp_path):
    db = make_db(tmp_path)
    up = db.add_task(Task(title="up", prompt="p", working_dir="."))
    down = db.add_task(Task(title="down", prompt="p", working_dir="."))

    db.add_dependency(down, up, inject_result=True)
    # duplicate insert is ignored
    db.add_dependency(down, up, inject_result=True)

    deps = db.get_dependencies(down)
    assert len(deps) == 1
    assert deps[0]["depends_on_task_id"] == up
    assert deps[0]["depends_on_title"] == "up"
    assert deps[0]["inject_result"] == 1

    dependents = db.get_dependents(up)
    assert len(dependents) == 1
    assert dependents[0]["task_id"] == down
    assert dependents[0]["task_title"] == "down"

    db.remove_dependency(down, up)
    assert db.get_dependencies(down) == []


def test_add_dependencies_batch_and_clear(tmp_path):
    db = make_db(tmp_path)
    a = db.add_task(Task(title="a", prompt="p", working_dir="."))
    b = db.add_task(Task(title="b", prompt="p", working_dir="."))
    down = db.add_task(Task(title="d", prompt="p", working_dir="."))

    db.add_dependencies_batch(
        down,
        [{"task_id": a, "inject_result": True}, {"task_id": b, "inject_result": False}],
    )
    deps = db.get_dependencies(down)
    assert {d["depends_on_task_id"] for d in deps} == {a, b}

    db.clear_dependencies(down)
    assert db.get_dependencies(down) == []


def test_get_dag_tasks_filters_by_dag_id(tmp_path):
    db = make_db(tmp_path)
    db.add_task(Task(title="x", prompt="p", working_dir=".", dag_id="flow-1"))
    db.add_task(Task(title="y", prompt="p", working_dir=".", dag_id="flow-1"))
    db.add_task(Task(title="z", prompt="p", working_dir=".", dag_id="other"))

    flow = db.get_dag_tasks("flow-1")
    assert {t["title"] for t in flow} == {"x", "y"}


# ── cascading delete ────────────────────────────────────────────────────────
def test_delete_task_removes_runs_events_and_deps(tmp_path):
    db = make_db(tmp_path)
    up = db.add_task(Task(title="up", prompt="p", working_dir="."))
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    db.add_dependency(tid, up)
    rid = db.add_run(tid)
    db.add_output_event(tid, rid, "assistant", "hi")

    db.delete_task(tid)

    assert db.get_task(tid) is None
    assert db.get_task_runs(tid) == []
    assert db.get_output_events(tid) == []
    # the dependency row referencing the deleted task is gone too
    assert db.get_dependents(up) == []


# ── due-task selection ──────────────────────────────────────────────────────
def test_get_due_tasks_selects_only_ready(tmp_path):
    db = make_db(tmp_path)
    now = datetime.now()
    past = (now - timedelta(minutes=5)).isoformat()
    future = (now + timedelta(hours=1)).isoformat()

    immediate = db.add_task(Task(title="now", prompt="p", working_dir="."))
    due_scheduled = db.add_task(
        Task(
            title="due",
            prompt="p",
            working_dir=".",
            schedule_type=ScheduleType.SCHEDULED_AT,
            next_run_at=past,
        )
    )
    db.update_task(due_scheduled, status="scheduled")
    not_yet = db.add_task(
        Task(
            title="later",
            prompt="p",
            working_dir=".",
            schedule_type=ScheduleType.SCHEDULED_AT,
            next_run_at=future,
        )
    )
    db.update_task(not_yet, status="scheduled")
    running = db.add_task(Task(title="running", prompt="p", working_dir="."))
    db.update_task(running, status="running")

    due_ids = {t["id"] for t in db.get_due_tasks()}
    assert immediate in due_ids  # pending + no next_run_at
    assert due_scheduled in due_ids  # scheduled in the past
    assert not_yet not in due_ids  # future
    assert running not in due_ids  # not pending/scheduled
