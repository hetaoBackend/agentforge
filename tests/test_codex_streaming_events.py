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


def test_codex_command_execution_is_stored_and_streamed():
    scheduler = _scheduler()
    listener = Mock()
    scheduler.add_output_listener(listener)

    event = {
        "type": "item.completed",
        "item": {
            "id": "cmd_1",
            "type": "command_execution",
            "command": "pytest -q",
            "aggregated_output": "42 passed",
            "exit_code": 0,
            "status": "completed",
        },
    }

    scheduler._parse_and_store_event(1, 2, json.dumps(event), "codex")

    scheduler.db.add_output_event.assert_called_once()
    task_id, run_id, event_type, content = scheduler.db.add_output_event.call_args.args
    assert (task_id, run_id, event_type) == (1, 2, "command_execution")
    assert json.loads(content) == {
        "id": "cmd_1",
        "command": "pytest -q",
        "output": "42 passed",
        "exit_code": 0,
        "status": "completed",
    }
    listener.assert_called_once_with(1, 2, "command_execution", content)


def test_codex_mcp_tool_call_is_stored_and_streamed_with_redacted_arguments():
    scheduler = _scheduler()
    listener = Mock()
    scheduler.add_output_listener(listener)

    event = {
        "type": "item.completed",
        "item": {
            "id": "mcp_1",
            "type": "mcp_tool_call",
            "server": "github",
            "tool": "search_issues",
            "arguments": {
                "query": "is:open",
                "token": "ghp_secret",
            },
            "result": {"total_count": 1},
            "status": "completed",
        },
    }

    scheduler._parse_and_store_event(1, 2, json.dumps(event), "codex")

    task_id, run_id, event_type, content = scheduler.db.add_output_event.call_args.args
    assert (task_id, run_id, event_type) == (1, 2, "tool_call")
    assert json.loads(content) == {
        "id": "mcp_1",
        "server": "github",
        "name": "search_issues",
        "input": {
            "query": "is:open",
            "token": "[redacted]",
        },
        "result": {"total_count": 1},
        "status": "completed",
    }
    listener.assert_called_once_with(1, 2, "tool_call", content)


def test_codex_web_search_and_file_change_events_are_stored_and_streamed():
    scheduler = _scheduler()
    listener = Mock()
    scheduler.add_output_listener(listener)

    events = [
        {
            "type": "item.completed",
            "item": {
                "id": "search_1",
                "type": "web_search",
                "query": "AgentForge taskboard",
                "action": "search",
            },
        },
        {
            "type": "item.completed",
            "item": {
                "id": "file_1",
                "type": "file_change",
                "changes": [{"path": "taskboard.py", "kind": "modified"}],
                "status": "completed",
            },
        },
    ]

    for event in events:
        scheduler._parse_and_store_event(1, 2, json.dumps(event), "codex")

    stored = [
        (call.args[2], json.loads(call.args[3]))
        for call in scheduler.db.add_output_event.call_args_list
    ]
    assert stored == [
        (
            "web_search",
            {
                "id": "search_1",
                "query": "AgentForge taskboard",
                "action": "search",
            },
        ),
        (
            "file_change",
            {
                "id": "file_1",
                "changes": [{"path": "taskboard.py", "kind": "modified"}],
                "status": "completed",
            },
        ),
    ]
    assert [call.args[2] for call in listener.call_args_list] == [
        "web_search",
        "file_change",
    ]


def test_codex_empty_final_message_uses_generated_images_not_raw_json(tmp_path, monkeypatch):
    codex_home = tmp_path / "codex"
    thread_id = "019e6224-test"
    image_dir = codex_home / "generated_images" / thread_id
    image_dir.mkdir(parents=True)
    image_path = image_dir / "skills-overview.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\nfakepng")
    monkeypatch.setenv("CODEX_HOME", str(codex_home))

    raw_stdout = "\n".join(
        [
            json.dumps({"type": "thread.started", "thread_id": thread_id}),
            json.dumps(
                {
                    "type": "item.completed",
                    "item": {"id": "msg_1", "type": "agent_message", "text": ""},
                }
            ),
            json.dumps({"type": "turn.completed", "usage": {"output_tokens": 10}}),
        ]
    )

    scheduler = _scheduler()
    generated_images = scheduler._find_codex_generated_images(thread_id)
    output = scheduler._extract_codex_success_output(raw_stdout, generated_images)

    assert generated_images == [str(image_path)]
    assert output == f"已生成 1 张图片：\n- {image_path}"
    assert "thread.started" not in output
    assert "item.completed" not in output


def test_store_generated_image_events_adds_path_and_renderable_image(tmp_path):
    image_path = tmp_path / "result.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\nfakepng")

    scheduler = _scheduler()
    scheduler._store_generated_image_events(1, 2, [str(image_path)])

    stored = [
        (call.args[2], json.loads(call.args[3]))
        for call in scheduler.db.add_output_event.call_args_list
    ]
    assert stored[0] == (
        "generated_image",
        {"path": str(image_path), "media_type": "image/png"},
    )
    assert stored[1][0] == "image_content"
    assert stored[1][1]["path"] == str(image_path)
    assert stored[1][1]["media_type"] == "image/png"
    assert stored[1][1]["data"]
