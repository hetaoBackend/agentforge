import json

from taskboard import (
    Heartbeat,
    HeartbeatScheduleType,
    HeartbeatDecisionType,
    ScheduleType,
    TaskDB,
    TaskScheduler,
)


def make_db(tmp_path):
    return TaskDB(str(tmp_path / "agentforge-test.db"))


def make_heartbeat(**overrides):
    data = {
        "name": "Repo watcher",
        "working_dir": ".",
        "schedule_type": HeartbeatScheduleType.INTERVAL,
        "interval_seconds": 60,
        "check_prompt": "Inspect repo and decide whether work is needed.",
        "action_prompt_template": "Review the latest changes.",
        "default_agent": "claude",
        "cooldown_seconds": 300,
    }
    data.update(overrides)
    return Heartbeat(**data)


def test_add_and_get_heartbeat(tmp_path):
    db = make_db(tmp_path)
    heartbeat_id = db.add_heartbeat(make_heartbeat())

    heartbeat = db.get_heartbeat(heartbeat_id)

    assert heartbeat is not None
    assert heartbeat["name"] == "Repo watcher"
    assert heartbeat["enabled"] is True
    assert heartbeat["schedule_type"] == HeartbeatScheduleType.INTERVAL.value
    assert heartbeat["next_run_at"] is not None


def test_heartbeat_trigger_creates_task_and_tick(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    scheduler = TaskScheduler(db)
    heartbeat_id = db.add_heartbeat(make_heartbeat())
    heartbeat = db.get_heartbeat(heartbeat_id)

    decision = {
        "decision": HeartbeatDecisionType.TRIGGER_TASK.value,
        "reason": "Found new changes",
        "dedupe_key": "repo:abc123",
        "title": "Review latest changes",
        "prompt": "Review commit abc123.",
        "metadata": {},
    }
    def fake_run(agent, cmd, cwd, on_stdout_line=None, on_stderr_line=None):
        payload = json.dumps(decision)
        if on_stdout_line:
            on_stdout_line(payload)
        return True, payload
    monkeypatch.setattr(scheduler, "_run_agent_command", fake_run)

    scheduler._execute_heartbeat(heartbeat)

    tasks = db.get_all_tasks()
    assert len(tasks) == 1
    assert tasks[0]["title"] == "Review latest changes"
    assert tasks[0]["prompt"] == "Review commit abc123."
    assert tasks[0]["schedule_type"] == ScheduleType.IMMEDIATE.value

    updated = db.get_heartbeat(heartbeat_id)
    assert updated["last_decision"] == HeartbeatDecisionType.TRIGGER_TASK.value
    assert updated["last_triggered_at"] is not None
    assert updated["last_dedupe_key"] == "repo:abc123"

    ticks = db.get_heartbeat_ticks(heartbeat_id)
    assert len(ticks) == 1
    assert ticks[0]["status"] == "triggered"
    assert ticks[0]["task_id"] == tasks[0]["id"]
    assert ticks[0]["raw_output"] == json.dumps(decision)


def test_heartbeat_duplicate_signal_is_suppressed(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    scheduler = TaskScheduler(db)
    heartbeat_id = db.add_heartbeat(make_heartbeat())
    heartbeat = db.get_heartbeat(heartbeat_id)

    decision = {
        "decision": HeartbeatDecisionType.TRIGGER_TASK.value,
        "reason": "Found new changes",
        "dedupe_key": "repo:abc123",
        "title": "Review latest changes",
        "prompt": "Review commit abc123.",
        "metadata": {},
    }
    def fake_run(agent, cmd, cwd, on_stdout_line=None, on_stderr_line=None):
        payload = json.dumps(decision)
        if on_stdout_line:
            on_stdout_line(payload)
        return True, payload
    monkeypatch.setattr(scheduler, "_run_agent_command", fake_run)

    scheduler._execute_heartbeat(heartbeat)
    scheduler._execute_heartbeat(db.get_heartbeat(heartbeat_id))

    tasks = db.get_all_tasks()
    assert len(tasks) == 1

    heartbeat = db.get_heartbeat(heartbeat_id)
    assert heartbeat["last_decision"] == HeartbeatDecisionType.IDLE.value

    ticks = db.get_heartbeat_ticks(heartbeat_id)
    assert len(ticks) == 2
    assert ticks[0]["status"] == "idle"
    assert "Suppressed duplicate signal" in json.loads(ticks[0]["decision_payload"])["reason"]


def test_heartbeat_invalid_json_records_error(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    scheduler = TaskScheduler(db)
    heartbeat_id = db.add_heartbeat(make_heartbeat())
    heartbeat = db.get_heartbeat(heartbeat_id)

    def fake_run(agent, cmd, cwd, on_stdout_line=None, on_stderr_line=None):
        if on_stdout_line:
            on_stdout_line("not json")
        return True, "not json"
    monkeypatch.setattr(scheduler, "_run_agent_command", fake_run)

    scheduler._execute_heartbeat(heartbeat)

    updated = db.get_heartbeat(heartbeat_id)
    assert updated["last_decision"] == HeartbeatDecisionType.ERROR.value
    assert updated["last_error"]

    ticks = db.get_heartbeat_ticks(heartbeat_id)
    assert len(ticks) == 1
    assert ticks[0]["status"] == "error"
    assert ticks[0]["error"]
    assert ticks[0]["raw_output"] == "not json"
