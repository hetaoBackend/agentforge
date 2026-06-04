import json

import pytest

from taskboard import Task, TaskDB, TaskScheduler


def make_db(tmp_path):
    return TaskDB(str(tmp_path / "agentforge-test.db"))


def add_completed_task(db, title="Run tests", prompt="run the test suite", result="ok"):
    tid = db.add_task(Task(title=title, prompt=prompt, working_dir="."))
    run_id = db.add_run(tid)
    db.finish_run(run_id, status="completed", result=result, raw_output="")
    return tid


# ── upsert / dedup ledger ──────────────────────────────────────────────────
def test_upsert_new_then_bump(tmp_path):
    db = make_db(tmp_path)
    pid = db.upsert_skill_pattern("run-pytest", "recipe", "run pytest suite", 1)
    assert pid is not None

    patterns = db.get_skill_patterns()
    assert len(patterns) == 1
    assert patterns[0]["recurrence_count"] == 1
    assert json.loads(patterns[0]["contributing_task_ids"]) == [1]
    assert patterns[0]["status"] == "tracking"

    db.upsert_skill_pattern("run-pytest", "recipe", "updated summary", 2)
    patterns = db.get_skill_patterns()
    assert len(patterns) == 1
    assert patterns[0]["recurrence_count"] == 2
    assert set(json.loads(patterns[0]["contributing_task_ids"])) == {1, 2}
    assert patterns[0]["summary"] == "updated summary"


def test_upsert_distinct_keys(tmp_path):
    db = make_db(tmp_path)
    db.upsert_skill_pattern("a", "recipe", "s", 1)
    db.upsert_skill_pattern("b", "pitfall", "s", 1)
    patterns = db.get_skill_patterns()
    assert len(patterns) == 2
    assert {p["kind"] for p in patterns} == {"recipe", "pitfall"}


def test_upsert_ignores_blank_key(tmp_path):
    db = make_db(tmp_path)
    assert db.upsert_skill_pattern("", "recipe", "s", 1) is None
    assert db.upsert_skill_pattern("   ", "recipe", "s", 1) is None
    assert db.get_skill_patterns() == []


def test_upsert_invalid_kind_defaults_to_recipe(tmp_path):
    db = make_db(tmp_path)
    db.upsert_skill_pattern("k", "bogus", "s", 1)
    assert db.get_skill_patterns()[0]["kind"] == "recipe"


def test_same_task_counts_occurrence_but_not_distinct(tmp_path):
    db = make_db(tmp_path)
    db.upsert_skill_pattern("k", "recipe", "s", 5)
    db.upsert_skill_pattern("k", "recipe", "s", 5)
    p = db.get_skill_patterns()[0]
    assert p["recurrence_count"] == 2  # each observation bumps the count
    assert json.loads(p["contributing_task_ids"]) == [5]  # but distinct tasks stay = 1


# ── completed-runs watermark query ─────────────────────────────────────────
def test_get_completed_runs_since_watermark(tmp_path):
    db = make_db(tmp_path)
    add_completed_task(db)
    add_completed_task(db, title="Deploy")
    assert len(db.get_completed_runs_since("")) == 2
    assert db.get_completed_runs_since("2999-01-01T00:00:00") == []


def test_get_completed_runs_excludes_unfinished(tmp_path):
    db = make_db(tmp_path)
    tid = db.add_task(Task(title="Pending", prompt="x"))
    db.add_run(tid)  # left running, no finish
    assert db.get_completed_runs_since("") == []


# ── sweep output parsing ───────────────────────────────────────────────────
def test_parse_sweep_output_variants(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    arr = '[{"pattern_key":"x","kind":"recipe","summary":"s","task_id":1}]'
    assert sched._parse_sweep_output(arr)[0]["pattern_key"] == "x"
    assert sched._parse_sweep_output("```json\n" + arr + "\n```")[0]["pattern_key"] == "x"
    assert sched._parse_sweep_output("Here you go:\n" + arr + "\nDone.")[0]["pattern_key"] == "x"
    assert sched._parse_sweep_output("nonsense") == []
    assert sched._parse_sweep_output("[]") == []
    assert sched._parse_sweep_output("") == []


# ── full sweep (mocked agent) ──────────────────────────────────────────────
def test_run_skill_sweep_upserts_and_advances_watermark(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    t1 = add_completed_task(db, title="Run tests", prompt="run pytest")
    t2 = add_completed_task(db, title="Run tests again", prompt="run the suite")

    payload = json.dumps(
        [
            {
                "pattern_key": "run-test-suite",
                "kind": "recipe",
                "summary": "run pytest",
                "task_id": t1,
            },
            {
                "pattern_key": "run-test-suite",
                "kind": "recipe",
                "summary": "run pytest",
                "task_id": t2,
            },
        ]
    )

    def fake_run(agent, cmd, cwd, on_stdout_line=None, on_stderr_line=None):
        return True, payload

    monkeypatch.setattr(sched, "_run_agent_command", fake_run)

    result = sched.run_skill_sweep(agent="claude")
    assert result["scanned"] == 2
    assert result["detected"] == 2

    patterns = db.get_skill_patterns()
    assert len(patterns) == 1
    assert patterns[0]["recurrence_count"] == 2
    assert set(json.loads(patterns[0]["contributing_task_ids"])) == {t1, t2}

    assert db.get_setting("skill_sweep_watermark", "") != ""

    # second sweep: watermark consumed everything → nothing new
    result2 = sched.run_skill_sweep(agent="claude")
    assert result2["scanned"] == 0
    assert result2["detected"] == 0


def test_run_skill_sweep_empty_history(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    result = sched.run_skill_sweep(agent="claude")
    assert result == {"scanned": 0, "detected": 0, "watermark": "", "agent": "claude"}


def test_run_skill_sweep_agent_failure_raises(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    add_completed_task(db)

    def fake_run(agent, cmd, cwd, on_stdout_line=None, on_stderr_line=None):
        return False, "agent exploded"

    monkeypatch.setattr(sched, "_run_agent_command", fake_run)

    with pytest.raises(RuntimeError, match="agent exploded"):
        sched.run_skill_sweep(agent="claude")
    # failed sweep must not advance the watermark
    assert db.get_setting("skill_sweep_watermark", "") == ""


def test_trigger_skill_sweep_guards_concurrency(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    # Simulate an in-flight sweep
    sched._skill_sweep_running = True
    assert sched.trigger_skill_sweep() is False
    status = sched.skill_sweep_status()
    assert status["running"] is True
