import json
import os
from datetime import datetime, timedelta

import pytest

from taskboard import (
    Task,
    TaskDB,
    TaskScheduler,
    _compose_skill_md,
    _parse_json_object,
    _sanitize_skill_name,
)


def make_db(tmp_path):
    return TaskDB(str(tmp_path / "agentforge-test.db"))


def make_pattern(db, key="k", recurrence=3, tasks=(1, 2, 3), kind="recipe"):
    db.upsert_skill_pattern(key, kind, "summary", tasks[0])
    db.conn.execute(
        "UPDATE skill_patterns SET recurrence_count=?, contributing_task_ids=? WHERE pattern_key=?",
        (recurrence, json.dumps(list(tasks)), key),
    )
    db.conn.commit()
    return db.conn.execute("SELECT id FROM skill_patterns WHERE pattern_key=?", (key,)).fetchone()[
        "id"
    ]


# ── helpers ────────────────────────────────────────────────────────────────
def test_sanitize_skill_name():
    assert _sanitize_skill_name("Run Pytest Suite!") == "run-pytest-suite"
    assert _sanitize_skill_name("../etc/passwd") == "etc-passwd"  # no traversal
    assert _sanitize_skill_name("a__b") == "a-b"
    assert _sanitize_skill_name("") == ""


def test_compose_and_parse():
    md = _compose_skill_md("x", "desc\nline", "body text")
    assert "name: x" in md
    assert "description: desc line" in md  # newline flattened
    assert md.strip().endswith("body text")
    assert _parse_json_object('```json\n{"a":1}\n```')["a"] == 1
    assert _parse_json_object('prefix {"a":2} suffix')["a"] == 2
    with pytest.raises(ValueError):
        _parse_json_object("[1,2,3]")  # not an object


# ── threshold → candidate ──────────────────────────────────────────────────
def test_refresh_marks_candidate(tmp_path):
    db = make_db(tmp_path)
    pid = make_pattern(db, recurrence=3, tasks=(1, 2, 3))
    assert db.refresh_skill_candidates() == 1
    assert db.get_skill_pattern(pid)["status"] == "candidate"
    # idempotent: already promoted out of 'tracking'
    assert db.refresh_skill_candidates() == 0


def test_refresh_below_recurrence(tmp_path):
    db = make_db(tmp_path)
    make_pattern(db, recurrence=2, tasks=(1, 2))
    assert db.refresh_skill_candidates() == 0


def test_refresh_below_distinct_tasks(tmp_path):
    db = make_db(tmp_path)
    make_pattern(db, recurrence=5, tasks=(1,))
    assert db.refresh_skill_candidates() == 0


def test_refresh_out_of_window(tmp_path):
    db = make_db(tmp_path)
    pid = make_pattern(db, recurrence=3, tasks=(1, 2, 3))
    old = (datetime.now() - timedelta(days=60)).isoformat()
    db.conn.execute("UPDATE skill_patterns SET first_seen=? WHERE id=?", (old, pid))
    db.conn.commit()
    assert db.refresh_skill_candidates() == 0
    assert db.get_skill_pattern(pid)["status"] == "tracking"


# ── distillation ───────────────────────────────────────────────────────────
def test_distill_skill_draft(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="Run tests", prompt="run pytest", working_dir="."))
    rid = db.add_run(tid)
    db.finish_run(rid, status="completed", result="all green")
    pid = make_pattern(db, recurrence=3, tasks=(tid, tid + 1, tid + 2))

    obj = {
        "name": "Run Pytest Suite",
        "description": "run the test suite",
        "body_markdown": "## Steps\n1. uv run pytest",
    }
    monkeypatch.setattr(sched, "_run_agent_command", lambda *a, **k: (True, json.dumps(obj)))

    draft = sched.distill_skill_draft(pid, agent="claude")
    assert draft["name"] == "run-pytest-suite"
    assert draft["body"].startswith("---\nname: run-pytest-suite")
    assert "description: run the test suite" in draft["body"]
    assert "## Steps" in draft["body"]

    saved = db.get_skill_draft(pid)
    assert saved["status"] == "ready"
    assert saved["name"] == "run-pytest-suite"


def test_distill_captures_worthiness(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="x", prompt="p", working_dir="."))
    rid = db.add_run(tid)
    db.finish_run(rid, status="completed", result="ok")
    pid = make_pattern(db, recurrence=3, tasks=(tid, tid + 1, tid + 2))

    obj = {
        "worthy": False,
        "worthiness_reason": "one-off, no reusable procedure",
        "name": "meh",
        "description": "d",
        "body_markdown": "b",
    }
    monkeypatch.setattr(sched, "_run_agent_command", lambda *a, **k: (True, json.dumps(obj)))

    draft = sched.distill_skill_draft(pid, agent="claude")
    assert draft["worthy"] is False
    assert "one-off" in draft["worthiness_reason"]

    # surfaced through get_skill_patterns for the UI
    row = [x for x in db.get_skill_patterns() if x["id"] == pid][0]
    assert row["draft_worthy"] == 0
    assert "one-off" in row["draft_worthiness_reason"]


def test_distill_worthiness_absent_is_none(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    pid = make_pattern(db)
    obj = {"name": "x", "description": "d", "body_markdown": "b"}  # no "worthy" key
    monkeypatch.setattr(sched, "_run_agent_command", lambda *a, **k: (True, json.dumps(obj)))
    draft = sched.distill_skill_draft(pid, agent="claude")
    assert draft["worthy"] is None
    assert db.get_skill_draft(pid)["worthy"] is None


def test_distill_agent_failure_marks_error(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    pid = make_pattern(db)
    monkeypatch.setattr(sched, "_run_agent_command", lambda *a, **k: (False, "boom"))
    with pytest.raises(RuntimeError, match="boom"):
        sched.distill_skill_draft(pid, agent="claude")


def test_trigger_skill_draft_unknown_pattern(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    assert sched.trigger_skill_draft(99999) is False


# ── approval (writes files + symlinks) ─────────────────────────────────────
def test_approve_skill_writes_files_and_symlinks(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    pid = make_pattern(db, recurrence=3, tasks=(1, 2, 3))

    body = "---\nname: my-skill\ndescription: do x\n---\n\nbody"
    skill = sched.approve_skill(pid, "My Skill", "do x", body)
    assert skill["name"] == "my-skill"
    assert skill["enabled"] == 1

    canonical = os.path.expanduser("~/.agentforge/skills/my-skill/SKILL.md")
    claude_link = os.path.expanduser("~/.claude/skills/my-skill")
    agents_link = os.path.expanduser("~/.agents/skills/my-skill")
    assert os.path.isfile(canonical)
    assert os.path.islink(claude_link)
    assert os.path.islink(agents_link)
    # both symlinks resolve to the canonical SKILL.md
    assert os.path.isfile(os.path.join(claude_link, "SKILL.md"))
    assert os.path.isfile(os.path.join(agents_link, "SKILL.md"))

    # pattern promoted, draft cleared
    pattern = db.get_skill_pattern(pid)
    assert pattern["status"] == "promoted"
    assert pattern["promoted_skill_id"] == skill["id"]
    assert db.get_skill_draft(pid) is None


def test_approve_rejects_empty_body(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    pid = make_pattern(db)
    with pytest.raises(ValueError, match="empty"):
        sched.approve_skill(pid, "x", "d", "   ")


def test_approve_unknown_pattern(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    with pytest.raises(ValueError, match="not found"):
        sched.approve_skill(99999, "x", "d", "body")


# ── dismissal ──────────────────────────────────────────────────────────────
def test_dismiss_pattern(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    pid = make_pattern(db)
    db.upsert_skill_draft(pid, "ready", name="x", body="b")
    sched.dismiss_skill_pattern(pid)
    assert db.get_skill_pattern(pid)["status"] == "dismissed"
    assert db.get_skill_draft(pid) is None


def test_dismiss_unknown_pattern(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    with pytest.raises(ValueError, match="not found"):
        sched.dismiss_skill_pattern(99999)
