from datetime import datetime, timedelta

from taskboard import TaskDB, TaskScheduler, _parse_comparable_datetime


def make_db(tmp_path):
    return TaskDB(str(tmp_path / "agentforge-test.db"))


def recorder(sched):
    calls = []
    sched.trigger_skill_sweep = lambda agent=None: calls.append(agent) or True
    return calls


def test_scheduled_sweep_disabled_by_default(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    calls = recorder(sched)
    sched._maybe_run_scheduled_sweep()
    assert calls == []
    # disabled → never even schedules
    assert db.get_setting("skill_sweep_next_run", "") == ""


def test_scheduled_sweep_first_enable_schedules_only(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    db.set_setting("skill_library_enabled", "1")
    calls = recorder(sched)
    sched._maybe_run_scheduled_sweep()
    assert calls == []  # first tick just schedules forward
    assert db.get_setting("skill_sweep_next_run", "") != ""


def test_scheduled_sweep_fires_when_due(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    db.set_setting("skill_library_enabled", "1")
    db.set_setting("skill_sweep_agent", "codex")
    db.set_setting("skill_sweep_next_run", (datetime.now() - timedelta(minutes=1)).isoformat())
    calls = recorder(sched)
    sched._maybe_run_scheduled_sweep()
    assert calls == ["codex"]
    nxt = db.get_setting("skill_sweep_next_run", "")
    assert nxt and _parse_comparable_datetime(nxt) > datetime.now()


def test_scheduled_sweep_not_due(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    db.set_setting("skill_library_enabled", "1")
    future = (datetime.now() + timedelta(hours=1)).isoformat()
    db.set_setting("skill_sweep_next_run", future)
    calls = recorder(sched)
    sched._maybe_run_scheduled_sweep()
    assert calls == []
    assert db.get_setting("skill_sweep_next_run", "") == future


def test_scheduled_sweep_invalid_cron_skips(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    db.set_setting("skill_library_enabled", "1")
    db.set_setting("skill_sweep_cron", "not a cron")
    calls = recorder(sched)
    sched._maybe_run_scheduled_sweep()
    assert calls == []


def test_scheduled_sweep_re_enable_catches_up(tmp_path):
    # Disabled for a while leaves a stale past next_run → fires once on re-enable.
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    db.set_setting("skill_library_enabled", "1")
    db.set_setting("skill_sweep_next_run", (datetime.now() - timedelta(days=3)).isoformat())
    calls = recorder(sched)
    sched._maybe_run_scheduled_sweep()
    assert len(calls) == 1
