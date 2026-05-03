from unittest.mock import Mock

from taskboard import TaskAPIHandler


def _handler(live_output=None, runs=None):
    handler = object.__new__(TaskAPIHandler)
    handler.scheduler = Mock()
    handler.scheduler._live_output = live_output or {}
    handler.db = Mock()
    handler.db.get_task_runs.return_value = runs or []
    return handler


def test_task_output_payload_returns_live_output_while_running():
    handler = _handler(live_output={12: "live stdout"})

    payload = handler._task_output_payload(12)

    assert payload == {"output": "live stdout", "is_running": True}
    handler.db.get_task_runs.assert_not_called()


def test_task_output_payload_falls_back_to_latest_run_raw_output_when_finished():
    handler = _handler(runs=[{"raw_output": "persisted stdout"}])

    payload = handler._task_output_payload(12)

    assert payload == {"output": "persisted stdout", "is_running": False}
    handler.db.get_task_runs.assert_called_once_with(12, limit=1)
