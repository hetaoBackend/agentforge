import json
from unittest.mock import Mock

from taskboard import CLAUDE_STREAM_JSON_ARGS, TaskScheduler


def _scheduler():
    scheduler = TaskScheduler(Mock())
    scheduler.db.add_output_event = Mock()
    return scheduler


def _assistant_event(text: str, message_id: str = "msg_1") -> dict:
    return {
        "type": "assistant",
        "message": {
            "id": message_id,
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        },
    }


def test_claude_stream_json_args_include_partial_messages():
    assert "--include-partial-messages" in CLAUDE_STREAM_JSON_ARGS


def test_claude_partial_assistant_events_emit_only_deltas():
    scheduler = _scheduler()
    listener = Mock()
    scheduler.add_output_listener(listener)

    events = [
        _assistant_event("Hel"),
        _assistant_event("Hello "),
        _assistant_event("Hello world"),
        _assistant_event("Hello world"),
    ]

    for event in events:
        scheduler._parse_and_store_event(1, 2, json.dumps(event), "claude")

    stored = [call.args[3] for call in scheduler.db.add_output_event.call_args_list]
    assert stored == ["Hel", "lo ", "world"]
    assert [call.args[3] for call in listener.call_args_list] == ["Hel", "lo ", "world"]


def test_claude_chunk_assistant_events_do_not_duplicate_final_message():
    scheduler = _scheduler()
    listener = Mock()
    scheduler.add_output_listener(listener)

    events = [
        _assistant_event("Hel"),
        _assistant_event("lo "),
        _assistant_event("world"),
        _assistant_event("Hello world"),
    ]

    for event in events:
        scheduler._parse_and_store_event(1, 2, json.dumps(event), "claude")

    stored = [call.args[3] for call in scheduler.db.add_output_event.call_args_list]
    assert stored == ["Hel", "lo ", "world"]
    assert [call.args[3] for call in listener.call_args_list] == ["Hel", "lo ", "world"]


def test_claude_new_assistant_message_id_starts_fresh_stream():
    scheduler = _scheduler()
    listener = Mock()
    scheduler.add_output_listener(listener)

    events = [
        _assistant_event("First", "msg_1"),
        _assistant_event("Second", "msg_2"),
    ]

    for event in events:
        scheduler._parse_and_store_event(1, 2, json.dumps(event), "claude")

    stored = [call.args[3] for call in scheduler.db.add_output_event.call_args_list]
    assert stored == ["First", "Second"]
    assert [call.args[3] for call in listener.call_args_list] == ["First", "Second"]


def test_claude_tool_use_blocks_are_stored_and_streamed_as_tool_calls():
    scheduler = _scheduler()
    listener = Mock()
    scheduler.add_output_listener(listener)

    event = {
        "type": "assistant",
        "message": {
            "id": "msg_tool",
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Bash",
                    "input": {
                        "command": "pytest -q",
                        "api_key": "sk-secret",
                    },
                }
            ],
        },
    }

    scheduler._parse_and_store_event(1, 2, json.dumps(event), "claude")

    scheduler.db.add_output_event.assert_called_once()
    task_id, run_id, event_type, content = scheduler.db.add_output_event.call_args.args
    payload = json.loads(content)
    assert (task_id, run_id, event_type) == (1, 2, "tool_call")
    assert payload == {
        "id": "toolu_1",
        "name": "Bash",
        "input": {
            "command": "pytest -q",
            "api_key": "[redacted]",
        },
    }
    listener.assert_called_once_with(1, 2, "tool_call", content)


def test_claude_tool_result_blocks_are_stored_and_streamed_as_tool_results():
    scheduler = _scheduler()
    listener = Mock()
    scheduler.add_output_listener(listener)

    event = {
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": [{"type": "text", "text": "42 passed"}],
                    "is_error": False,
                }
            ],
        },
    }

    scheduler._parse_and_store_event(1, 2, json.dumps(event), "claude")

    scheduler.db.add_output_event.assert_called_once()
    task_id, run_id, event_type, content = scheduler.db.add_output_event.call_args.args
    assert (task_id, run_id, event_type) == (1, 2, "tool_result")
    assert json.loads(content) == {
        "tool_use_id": "toolu_1",
        "content": "42 passed",
        "is_error": False,
    }
    listener.assert_called_once_with(1, 2, "tool_result", content)
