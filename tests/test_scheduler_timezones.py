from datetime import datetime, timedelta, timezone

from taskboard import ScheduleType, Task, TaskDB, TaskScheduler


def make_db(tmp_path):
    return TaskDB(str(tmp_path / "agentforge-test.db"))


def test_submit_task_normalizes_aware_scheduled_at_to_local_naive(tmp_path):
    db = make_db(tmp_path)
    scheduler = TaskScheduler(db)
    future_utc = datetime.now(timezone.utc) + timedelta(hours=1)

    task_id = scheduler.submit_task(
        Task(
            title="Timezone test",
            prompt="Run later",
            schedule_type=ScheduleType.SCHEDULED_AT,
            next_run_at=future_utc.isoformat(),
        )
    )

    task = db.get_task(task_id)
    expected = future_utc.astimezone().replace(tzinfo=None).isoformat()

    assert task is not None
    assert task["next_run_at"] == expected


def test_tick_accepts_legacy_aware_next_run_at_without_type_error(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    scheduler = TaskScheduler(db)
    triggered = []

    now = datetime.now().isoformat()
    cur = db.conn.execute(
        """
        INSERT INTO tasks (
            title, prompt, working_dir, status, schedule_type,
            cron_expr, delay_seconds, next_run_at, max_runs,
            created_at, updated_at, tags, agent, prompt_images, image_paths
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "Legacy aware task",
            "Run now",
            ".",
            "scheduled",
            ScheduleType.SCHEDULED_AT.value,
            None,
            None,
            (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
            None,
            now,
            now,
            "",
            "claude",
            "[]",
            "[]",
        ),
    )
    db.conn.commit()
    task_id = cur.lastrowid

    monkeypatch.setattr(scheduler, "_spawn_task", lambda task: triggered.append(task["id"]))

    scheduler._tick()

    assert triggered == [task_id]


def test_heartbeat_dedupe_handles_aware_triggered_at_without_type_error(tmp_path):
    db = make_db(tmp_path)
    scheduler = TaskScheduler(db)

    db.conn.execute(
        """
        INSERT INTO heartbeat_dedup (heartbeat_id, dedupe_key, task_id, triggered_at)
        VALUES (?, ?, ?, ?)
        """,
        (
            1,
            "repo:abc123",
            None,
            (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat(),
        ),
    )
    db.conn.commit()

    suppressed = scheduler._heartbeat_trigger_suppressed(
        {"id": 1, "cooldown_seconds": 300},
        "repo:abc123",
    )

    assert suppressed is True
