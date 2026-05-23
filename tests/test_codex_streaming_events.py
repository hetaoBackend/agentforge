import json
from unittest.mock import Mock

from taskboard import TaskScheduler


def _scheduler():
    scheduler = TaskScheduler(Mock())
    scheduler.db.add_output_event = Mock()
    return scheduler


def test_codex_item_updated_cumulative_text_emits_only_deltas():
    scheduler = _scheduler()
    listener = Mock()
    scheduler.add_output_listener(listener)

    events = [
        {"type": "item.updated", "item": {"id": "msg_1", "type": "agent_message", "text": "Hel"}},
        {
            "type": "item.updated",
            "item": {"id": "msg_1", "type": "agent_message", "text": "Hello "},
        },
        {
            "type": "item.updated",
            "item": {"id": "msg_1", "type": "agent_message", "text": "Hello world"},
        },
        {
            "type": "item.completed",
            "item": {"id": "msg_1", "type": "agent_message", "text": "Hello world"},
        },
    ]

    for event in events:
        scheduler._parse_and_store_event(1, 2, json.dumps(event), "codex")

    stored = [call.args[3] for call in scheduler.db.add_output_event.call_args_list]
    assert stored == ["Hel", "lo ", "world"]
    assert [call.args[3] for call in listener.call_args_list] == ["Hel", "lo ", "world"]


def test_codex_item_updated_delta_text_does_not_duplicate_completed_text():
    scheduler = _scheduler()
    listener = Mock()
    scheduler.add_output_listener(listener)

    events = [
        {
            "type": "item.updated",
            "delta": {"text": "Hello"},
            "item": {"id": "msg_1", "type": "agent_message"},
        },
        {
            "type": "item.updated",
            "delta": {"text": " world"},
            "item": {"id": "msg_1", "type": "agent_message"},
        },
        {
            "type": "item.completed",
            "item": {"id": "msg_1", "type": "agent_message", "text": "Hello world"},
        },
    ]

    for event in events:
        scheduler._parse_and_store_event(1, 2, json.dumps(event), "codex")

    stored = [call.args[3] for call in scheduler.db.add_output_event.call_args_list]
    assert stored == ["Hello", " world"]
    assert [call.args[3] for call in listener.call_args_list] == ["Hello", " world"]


def test_codex_reasoning_updated_text_does_not_duplicate_completed_text():
    scheduler = _scheduler()
    listener = Mock()
    scheduler.add_output_listener(listener)

    events = [
        {
            "type": "item.updated",
            "delta": {"text": "Think"},
            "item": {"id": "reasoning_1", "type": "reasoning"},
        },
        {
            "type": "item.updated",
            "delta": {"text": " carefully"},
            "item": {"id": "reasoning_1", "type": "reasoning"},
        },
        {
            "type": "item.completed",
            "item": {"id": "reasoning_1", "type": "reasoning", "text": "Think carefully"},
        },
    ]

    for event in events:
        scheduler._parse_and_store_event(1, 2, json.dumps(event), "codex")

    stored = [call.args[3] for call in scheduler.db.add_output_event.call_args_list]
    assert stored == ["[thinking] Think", "[thinking]  carefully"]
    assert [call.args[3] for call in listener.call_args_list] == [
        "[thinking] Think",
        "[thinking]  carefully",
    ]
