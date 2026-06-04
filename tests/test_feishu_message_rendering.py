"""
Tests for Feishu outbound message card rendering.
"""

import json
from unittest.mock import Mock, patch

import pytest

from taskboard_bus import OutboundMessage, OutboundMessageType


@pytest.fixture
def mock_feishu_channel():
    """Create a FeishuChannel instance with mocked dependencies."""
    with patch("channels.feishu_channel.FEISHU_AVAILABLE", True):
        from channels.feishu_channel import FeishuChannel

        bus = Mock()
        db = Mock()
        scheduler = Mock()

        channel = FeishuChannel(bus, db, scheduler)
        channel._client = Mock()
        return channel


def _panel_texts(panel):
    return [element["text"]["content"] for element in panel["elements"] if element["tag"] == "div"]


def _count_card_elements(value):
    if not isinstance(value, dict):
        return 0
    count = 1 if isinstance(value.get("tag"), str) else 0
    for child in value.values():
        if isinstance(child, list):
            count += sum(_count_card_elements(item) for item in child)
        elif isinstance(child, dict):
            count += _count_card_elements(child)
    return count


class TestFeishuNotificationCards:
    def test_build_completed_card_shows_result_only(self, mock_feishu_channel):
        task = {
            "id": 42,
            "title": "Fix Feishu rendering",
            "prompt": "请优化飞书结果展示，让内容更容易扫读。",
            "agent": "codex",
            "working_dir": "~/workspace/agentforge",
        }
        result_text = "已完成优化。\n\n- 增加摘要\n- 增加结果预览\n- 增加折叠面板"

        card = mock_feishu_channel._build_notification_card(
            task_id=42,
            task=task,
            is_completed=True,
            body_text=result_text,
        )

        assert card["schema"] == "2.0"
        assert card["config"]["summary"]["content"] == "已完成优化。"
        assert len(card["body"]["elements"]) == 1
        assert any(
            element.get("tag") == "markdown" and "增加摘要" in element.get("content", "")
            for element in card["body"]["elements"]
        )
        assert not any(
            "Task #42" in element.get("content", "") or "Prompt" in element.get("content", "")
            for element in card["body"]["elements"]
            if isinstance(element, dict)
        )

    def test_build_failed_card_adds_status_hint(self, mock_feishu_channel):
        task = {
            "id": 7,
            "title": "Broken task",
            "prompt": "调试失败任务",
            "agent": "claude",
            "working_dir": "~/workspace/agentforge",
        }

        card = mock_feishu_channel._build_notification_card(
            task_id=7,
            task=task,
            is_completed=False,
            body_text="Traceback: something went wrong",
        )

        assert any(
            element.get("tag") == "markdown" and "/status 7" in element.get("content", "")
            for element in card["body"]["elements"]
        )

    def test_build_completed_card_keeps_long_body_visible(self, mock_feishu_channel):
        task = {
            "id": 99,
            "title": "Long output task",
            "prompt": "输出一份很长的结果",
            "agent": "codex",
            "working_dir": "~/workspace/agentforge",
        }
        long_text = "A" * 2200

        card = mock_feishu_channel._build_notification_card(
            task_id=99,
            task=task,
            is_completed=True,
            body_text=long_text,
        )

        assert card["body"]["elements"][0]["tag"] == "markdown"
        assert card["body"]["elements"] == [{"tag": "markdown", "content": long_text}]
        assert not any(
            element.get("tag") == "collapsible_panel" for element in card["body"]["elements"]
        )

    def test_build_completed_card_long_body_keeps_full_remainder(self, mock_feishu_channel):
        task = {
            "id": 100,
            "title": "Long output task",
            "prompt": "输出一份很长的结果",
            "agent": "codex",
            "working_dir": "~/workspace/agentforge",
        }
        long_text = "A" * 500 + "B" * 7600

        card = mock_feishu_channel._build_notification_card(
            task_id=100,
            task=task,
            is_completed=True,
            body_text=long_text,
        )
        assert card["body"]["elements"][0]["content"].startswith("A" * 20)
        assert "".join(element["content"] for element in card["body"]["elements"]) == long_text
        assert "truncated" not in "".join(
            element["content"] for element in card["body"]["elements"]
        )

    def test_build_completed_card_long_body_uses_summary_plus_full_content(
        self, mock_feishu_channel
    ):
        task = {
            "id": 101,
            "title": "Long output task",
            "prompt": "输出一份很长的结果",
            "agent": "codex",
            "working_dir": "~/workspace/agentforge",
        }
        long_text = "Summary line\n" + ("A" * 1600)

        card = mock_feishu_channel._build_notification_card(
            task_id=101,
            task=task,
            is_completed=True,
            body_text=long_text,
        )

        assert card["config"]["summary"]["content"] == "Summary line"
        assert card["body"]["elements"] == [{"tag": "markdown", "content": long_text}]

    def test_build_completed_card_long_body_has_no_collapsible_panel(self, mock_feishu_channel):
        task = {
            "id": 102,
            "title": "Long output task",
            "prompt": "输出一份很长的结果",
            "agent": "codex",
            "working_dir": "~/workspace/agentforge",
        }
        long_text = "Intro line\n" + ("B" * 1400)

        card = mock_feishu_channel._build_notification_card(
            task_id=102,
            task=task,
            is_completed=True,
            body_text=long_text,
        )

        assert not any(
            element.get("tag") == "collapsible_panel" for element in card["body"]["elements"]
        )
        assert "".join(element["content"] for element in card["body"]["elements"]) == long_text

    def test_build_completed_card_places_streaming_history_above_result(self, mock_feishu_channel):
        task = {
            "id": 103,
            "title": "Finished task",
            "prompt": "输出最终结果",
            "agent": "codex",
            "working_dir": "~/workspace/agentforge",
        }

        card = mock_feishu_channel._build_notification_card(
            task_id=103,
            task=task,
            is_completed=True,
            body_text="最终结果",
            streaming_history="思考第一步\n思考第二步",
        )

        panel = card["body"]["elements"][0]
        result = card["body"]["elements"][1]
        assert panel["tag"] == "collapsible_panel"
        assert panel["expanded"] is False
        assert panel["header"]["title"]["content"] == "执行过程"
        assert _panel_texts(panel) == ["思考第一步", "思考第二步"]
        assert result == {"tag": "markdown", "content": "最终结果"}

    def test_send_uses_structured_card_and_fallback_content(self, mock_feishu_channel):
        task = {
            "id": 5,
            "title": "Ship update",
            "prompt": "发布更新",
            "result": "done",
            "error": None,
            "agent": "codex",
            "working_dir": "~/workspace/agentforge",
        }
        mock_feishu_channel.db.get_task.return_value = task
        mock_feishu_channel.db.get_setting.return_value = "oc_test_chat"
        mock_feishu_channel._send_message = Mock(return_value="msg_123")

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=5,
            payload={"result": "done", "title": "Ship update"},
        )

        mock_feishu_channel.send(msg)

        _, kwargs = mock_feishu_channel._send_message.call_args
        assert kwargs["fallback_content"] == "done"
        assert kwargs["card"]["schema"] == "2.0"

    def test_send_completed_notification_keeps_full_result_for_card(self, mock_feishu_channel):
        task = {
            "id": 6,
            "title": "Long result",
            "prompt": "发布长结果",
            "result": None,
            "error": None,
            "agent": "codex",
            "working_dir": "~/workspace/agentforge",
        }
        long_result = "A" * 12050
        mock_feishu_channel.db.get_task.return_value = task
        mock_feishu_channel.db.get_setting.return_value = "oc_test_chat"
        mock_feishu_channel._send_message = Mock(return_value="msg_456")
        mock_feishu_channel._build_notification_card = Mock(
            wraps=mock_feishu_channel._build_notification_card
        )

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=6,
            payload={"result": long_result, "title": "Long result"},
        )

        mock_feishu_channel.send(msg)

        _, kwargs = mock_feishu_channel._build_notification_card.call_args
        assert kwargs["body_text"] == long_result

    def test_build_completed_card_includes_generated_image_elements(self, mock_feishu_channel):
        task = {
            "id": 7,
            "title": "Image result",
            "prompt": "生成图片",
            "agent": "codex",
            "working_dir": "~/workspace/agentforge",
        }

        card = mock_feishu_channel._build_notification_card(
            task_id=7,
            task=task,
            is_completed=True,
            body_text="已生成 1 张图片：",
            image_keys=["img_v2_result"],
        )

        assert card["body"]["elements"][-1] == {
            "tag": "img",
            "img_key": "img_v2_result",
            "alt": {"tag": "plain_text", "content": "generated image 1"},
        }

    def test_send_uploads_generated_images_from_run_events(self, mock_feishu_channel, tmp_path):
        image_path = tmp_path / ".codex" / "generated_images" / "thread_1" / "result.png"
        image_path.parent.mkdir(parents=True)
        image_path.write_bytes(b"\x89PNG\r\n\x1a\nfakepng")
        task = {
            "id": 7,
            "title": "Image result",
            "prompt": "生成图片",
            "result": f"已生成 1 张图片：\n- {image_path}",
            "error": None,
            "agent": "codex",
            "working_dir": "~/workspace/agentforge",
        }
        mock_feishu_channel.db.get_task.return_value = task
        mock_feishu_channel.db.get_setting.return_value = "oc_test_chat"
        mock_feishu_channel.db.get_task_runs.return_value = [{"id": 99}]
        mock_feishu_channel.db.get_run_output_events.return_value = [
            {
                "event_type": "generated_image",
                "content": json.dumps({"path": str(image_path), "media_type": "image/png"}),
            }
        ]
        mock_feishu_channel._upload_image = Mock(return_value="img_v2_result")
        mock_feishu_channel._send_message = Mock(return_value="msg_456")

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=7,
            payload={"result": task["result"], "title": "Image result"},
        )

        mock_feishu_channel.send(msg)

        _, kwargs = mock_feishu_channel._send_message.call_args
        assert kwargs["card"]["body"]["elements"][0]["content"] == "已生成 1 张图片。"
        assert "/.codex/generated_images/" not in kwargs["card"]["body"]["elements"][0]["content"]
        assert kwargs["card"]["body"]["elements"][-1]["img_key"] == "img_v2_result"
        mock_feishu_channel._upload_image.assert_called_once_with(str(image_path))

    def test_send_uploads_markdown_generated_image_references(self, mock_feishu_channel, tmp_path):
        image_dir = tmp_path / ".codex" / "generated_images" / "thread_2"
        image_dir.mkdir(parents=True)
        first_image = image_dir / "first.png"
        second_image = image_dir / "second.png"
        first_image.write_bytes(b"\x89PNG\r\n\x1a\nfirst")
        second_image.write_bytes(b"\x89PNG\r\n\x1a\nsecond")
        result_text = f"生成好了：\n\n- ![第一张图]({first_image})\n- ![第二张图]({second_image})"
        task = {
            "id": 11,
            "title": "Multi image result",
            "prompt": "生成两张图片",
            "result": result_text,
            "error": None,
            "agent": "codex",
            "working_dir": "~/workspace/agentforge",
        }
        mock_feishu_channel.db.get_task.return_value = task
        mock_feishu_channel.db.get_setting.return_value = "oc_test_chat"
        mock_feishu_channel.db.get_task_runs.return_value = []
        mock_feishu_channel._upload_image = Mock(side_effect=["img_first", "img_second"])
        mock_feishu_channel._send_message = Mock(return_value="msg_789")

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=11,
            payload={"result": result_text, "title": "Multi image result"},
        )

        mock_feishu_channel.send(msg)

        _, kwargs = mock_feishu_channel._send_message.call_args
        elements = kwargs["card"]["body"]["elements"]
        markdown_text = "\n".join(
            element.get("content", "") for element in elements if element.get("tag") == "markdown"
        )
        assert "![第一张图]" not in markdown_text
        assert "![第二张图]" not in markdown_text
        assert str(first_image) not in markdown_text
        assert str(second_image) not in markdown_text
        assert markdown_text.strip() == "生成好了："
        assert [element.get("img_key") for element in elements[-2:]] == [
            "img_first",
            "img_second",
        ]
        assert [call.args[0] for call in mock_feishu_channel._upload_image.call_args_list] == [
            str(first_image),
            str(second_image),
        ]

    def test_send_final_patch_preserves_streaming_history(self, mock_feishu_channel):
        from channels.feishu_channel import _FeishuStreamWriter

        task = {
            "id": 8,
            "title": "Streaming final",
            "prompt": "发布最终结果",
            "result": "final result",
            "error": None,
            "agent": "codex",
            "working_dir": "~/workspace/agentforge",
        }
        writer = _FeishuStreamWriter(8, "om_stream", mock_feishu_channel, "Streaming final")
        writer._schedule = Mock()
        writer.on_event(8, 44, "assistant", "[thinking] thinking line\n")
        writer.on_event(8, 44, "assistant", "[thinking] more thinking")
        writer.on_event(8, 44, "assistant", "final result")

        mock_feishu_channel.db.get_task.return_value = task
        mock_feishu_channel._task_origin[8] = ("oc_chat", "root_msg", "reaction_msg")
        mock_feishu_channel._streaming_msg[8] = "om_stream"
        mock_feishu_channel._writers[8] = writer
        mock_feishu_channel._add_reaction = Mock()
        mock_feishu_channel._patch_message = Mock(return_value=True)

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=8,
            payload={"result": "final result", "title": "Streaming final"},
        )

        mock_feishu_channel.send(msg)

        _, patched_card = mock_feishu_channel._patch_message.call_args.args
        panel = patched_card["body"]["elements"][0]
        result = patched_card["body"]["elements"][1]
        assert panel["tag"] == "collapsible_panel"
        assert panel["header"]["title"]["content"] == "执行过程"
        assert _panel_texts(panel) == ["thinking line", "more thinking"]
        assert "final result" not in "".join(_panel_texts(panel))
        assert result == {"tag": "markdown", "content": "final result"}
        mock_feishu_channel.scheduler.remove_output_listener.assert_called_once_with(
            writer.on_event
        )

    def test_build_completed_card_removes_final_answer_from_history(self, mock_feishu_channel):
        task = {
            "id": 9,
            "title": "Streaming final",
            "prompt": "发布最终结果",
            "agent": "claude",
            "working_dir": "~/workspace/agentforge",
        }

        card = mock_feishu_channel._build_notification_card(
            task_id=9,
            task=task,
            is_completed=True,
            body_text="final result",
            streaming_history="working...\nfinal result",
        )

        panel = card["body"]["elements"][0]
        result = card["body"]["elements"][1]
        assert panel["tag"] == "collapsible_panel"
        assert _panel_texts(panel) == ["working..."]
        assert result == {"tag": "markdown", "content": "final result"}

    def test_build_completed_card_keeps_panel_when_history_is_only_final_answer(
        self, mock_feishu_channel
    ):
        # When the streamed history is only the final answer (no separate trace
        # events, e.g. a simple/codex run), still keep the folded 执行过程 panel
        # rather than dropping it — the process should always be foldable.
        task = {
            "id": 10,
            "title": "Streaming final",
            "prompt": "发布最终结果",
            "agent": "claude",
            "working_dir": "~/workspace/agentforge",
        }

        card = mock_feishu_channel._build_notification_card(
            task_id=10,
            task=task,
            is_completed=True,
            body_text="final result",
            streaming_history="final result",
        )

        panel = card["body"]["elements"][0]
        result = card["body"]["elements"][1]
        assert panel["tag"] == "collapsible_panel"
        assert _panel_texts(panel) == ["final result"]
        assert result == {"tag": "markdown", "content": "final result"}


class TestFeishuStreaming:
    def test_streaming_card_uses_thinking_placeholder(self, mock_feishu_channel):
        card = mock_feishu_channel._build_streaming_card(12, "Streaming task", "")

        assert card["body"]["elements"][0]["content"] == "Thinking ▌"

    def test_streaming_card_preserves_single_newlines(self, mock_feishu_channel):
        card = mock_feishu_channel._build_streaming_card(
            12, "Streaming task", "first line\nsecond line\n"
        )

        panel = card["body"]["elements"][0]
        assert len(card["body"]["elements"]) == 1
        assert panel["tag"] == "collapsible_panel"
        assert panel["expanded"] is True
        assert _panel_texts(panel) == ["first line", "second line"]

    def test_streaming_card_normalizes_crlf_newlines(self, mock_feishu_channel):
        card = mock_feishu_channel._build_streaming_card(
            12, "Streaming task", "first line\r\nsecond line"
        )

        panel = card["body"]["elements"][0]
        assert _panel_texts(panel) == ["first line", "second line"]

    def test_streaming_card_preserves_blank_lines_as_separate_rows(self, mock_feishu_channel):
        card = mock_feishu_channel._build_streaming_card(
            12, "Streaming task", "first line\n\nthird line"
        )

        panel = card["body"]["elements"][0]
        assert _panel_texts(panel) == ["first line", " ", "third line"]

    def test_streaming_card_keeps_full_output_in_collapsible_panel(self, mock_feishu_channel):
        long_text = "start\n" + ("A" * 1600) + "\nend"

        card = mock_feishu_channel._build_streaming_card(12, "Streaming task", long_text)

        panel = card["body"]["elements"][0]
        assert len(card["body"]["elements"]) == 1
        assert panel["tag"] == "collapsible_panel"
        assert panel["expanded"] is True
        assert panel["header"]["title"]["content"] == "执行过程"
        assert _panel_texts(panel) == ["start", "A" * 1600, "end"]

    def test_streaming_card_uses_plain_markdown_fallback_for_many_lines(self, mock_feishu_channel):
        long_text = "\n".join(f"line {i}" for i in range(220))

        card = mock_feishu_channel._build_streaming_card(12, "Streaming task", long_text)

        panel = card["body"]["elements"][0]
        assert panel["elements"] == [{"tag": "markdown", "content": long_text}]
        assert "```" not in panel["elements"][0]["content"]
        assert _count_card_elements(card) <= 200

    def test_notification_card_keeps_history_and_image_under_feishu_element_limit(
        self, mock_feishu_channel
    ):
        history = "\n".join(f"line {i}" for i in range(165))

        card = mock_feishu_channel._build_notification_card(
            task_id=12,
            task={"id": 12, "title": "Image task"},
            is_completed=True,
            body_text="已生成 1 张图片：\n- /tmp/generated.png",
            streaming_history=history,
            image_keys=["img_v3_generated"],
        )

        panel = card["body"]["elements"][0]
        assert panel["tag"] == "collapsible_panel"
        assert panel["elements"][0]["tag"] == "markdown"
        assert card["body"]["elements"][-1]["img_key"] == "img_v3_generated"
        assert _count_card_elements(card) <= 200

    def test_streaming_history_markdown_fallback_chunks_long_content(self, mock_feishu_channel):
        long_text = "\n".join(f"{i}: {'A' * 120}" for i in range(140))

        card = mock_feishu_channel._build_streaming_card(12, "Streaming task", long_text)

        panel = card["body"]["elements"][0]
        assert len(panel["elements"]) > 1
        assert all(element["tag"] == "markdown" for element in panel["elements"])
        assert all("```" not in element["content"] for element in panel["elements"])
        assert _count_card_elements(card) <= 200

    def test_stream_writer_appends_thinking_events_without_resplitting(self, mock_feishu_channel):
        from channels.feishu_channel import _FeishuStreamWriter

        writer = _FeishuStreamWriter(12, "om_msg", mock_feishu_channel, "Streaming task")
        writer._schedule = Mock()

        writer.on_event(12, 34, "assistant", "[thinking] Hello")
        writer.on_event(12, 34, "assistant", "[thinking]  ")
        writer.on_event(12, 34, "assistant", "[thinking] world")

        mock_feishu_channel._build_streaming_card = Mock(return_value={"card": True})
        mock_feishu_channel._patch_message = Mock()

        writer._do_patch()

        mock_feishu_channel._build_streaming_card.assert_called_once_with(
            12, "Streaming task", "Hello world"
        )

    def test_stream_writer_appends_tool_trace_events(self, mock_feishu_channel):
        from channels.feishu_channel import _FeishuStreamWriter

        writer = _FeishuStreamWriter(12, "om_msg", mock_feishu_channel, "Streaming task")
        writer._schedule = Mock()

        writer.on_event(
            12,
            34,
            "tool_call",
            json.dumps({"id": "toolu_1", "name": "Bash", "input": {"command": "pytest -q"}}),
        )
        writer.on_event(
            12,
            34,
            "tool_result",
            json.dumps({"tool_use_id": "toolu_1", "content": "42 passed", "is_error": False}),
        )
        writer.on_event(
            12,
            34,
            "command_execution",
            json.dumps(
                {
                    "command": "pytest -q",
                    "output": "42 passed",
                    "exit_code": 0,
                }
            ),
        )

        assert writer.snapshot_text() == (
            "▣ 调用工具 Bash · pytest -q\n"
            "↵ 工具返回 toolu_1 · 42 passed\n"
            "$ 执行命令 pytest -q · 42 passed · 退出码 0\n"
        )
        assert writer._schedule.call_count == 3

    def test_stream_writer_formats_trace_events_as_icon_summaries(self, mock_feishu_channel):
        from channels.feishu_channel import _FeishuStreamWriter

        writer = _FeishuStreamWriter(12, "om_msg", mock_feishu_channel, "Streaming task")
        writer._schedule = Mock()

        writer.on_event(
            12,
            34,
            "web_search",
            json.dumps(
                {
                    "query": "site:github.com agent memory",
                    "action": {"type": "search", "query": "agent memory"},
                    "status": "completed",
                }
            ),
        )
        writer.on_event(
            12,
            34,
            "tool_call",
            json.dumps(
                {
                    "server": "github",
                    "name": "search_issues",
                    "input": {"query": "is:open label:bug", "token": "[redacted]"},
                    "status": "completed",
                }
            ),
        )

        text = writer.snapshot_text()
        assert text == (
            "⌕ 网页搜索 site:github.com agent memory · completed\n"
            "▣ 调用工具 github.search_issues · is:open label:bug · completed\n"
        )
        assert "{" not in text
        assert "动作:" not in text
        assert "参数:" not in text

    def test_stream_writer_keeps_long_command_output_as_one_summary_line(self, mock_feishu_channel):
        from channels.feishu_channel import _FeishuStreamWriter

        writer = _FeishuStreamWriter(12, "om_msg", mock_feishu_channel, "Streaming task")
        writer._schedule = Mock()
        long_output = "\n".join(f"line {i}: {'x' * 40}" for i in range(120))

        writer.on_event(
            12,
            34,
            "command_execution",
            json.dumps({"command": "/bin/zsh -lc npm test", "output": long_output, "exit_code": 0}),
        )

        text = writer.snapshot_text()
        assert text.count("\n") == 1
        assert text.startswith("$ 执行命令 /bin/zsh -lc npm test · line 0:")
        assert "line 1:" not in text
        assert "输出:" not in text

        elements = mock_feishu_channel._build_streaming_history_elements(text)
        assert len(elements) == 1
        assert elements[0]["tag"] == "div"

    def test_stream_writer_keeps_full_text_for_folded_history(self, mock_feishu_channel):
        from channels.feishu_channel import _FeishuStreamWriter

        long_text = "A" * 5000
        writer = _FeishuStreamWriter(12, "om_msg", mock_feishu_channel, "Streaming task")
        writer._schedule = Mock()

        writer.on_event(12, 34, "assistant", f"[thinking] {long_text}")

        mock_feishu_channel._build_streaming_card = Mock(return_value={"card": True})
        mock_feishu_channel._patch_message = Mock()

        writer._do_patch()

        mock_feishu_channel._build_streaming_card.assert_called_once_with(
            12, "Streaming task", long_text
        )

    def test_stream_writer_resets_when_run_changes(self, mock_feishu_channel):
        from channels.feishu_channel import _FeishuStreamWriter

        writer = _FeishuStreamWriter(12, "om_msg", mock_feishu_channel, "Streaming task")
        writer._schedule = Mock()

        writer.on_event(12, 34, "assistant", "[thinking] old")
        writer.on_event(12, 35, "assistant", "[thinking] new")

        mock_feishu_channel._build_streaming_card = Mock(return_value={"card": True})
        mock_feishu_channel._patch_message = Mock()

        writer._do_patch()

        mock_feishu_channel._build_streaming_card.assert_called_once_with(
            12, "Streaming task", "new"
        )

    def test_stream_writer_keeps_plain_assistant_text_for_live_card(self, mock_feishu_channel):
        from channels.feishu_channel import _FeishuStreamWriter

        writer = _FeishuStreamWriter(12, "om_msg", mock_feishu_channel, "Streaming task")
        writer._schedule = Mock()

        writer.on_event(12, 34, "assistant", "Hello world")

        assert writer._parts == ["Hello world"]
        writer._schedule.assert_called_once()

    def test_stream_writer_does_not_overlap_patch_requests(self, mock_feishu_channel):
        from channels.feishu_channel import _FeishuStreamWriter

        writer = _FeishuStreamWriter(12, "om_msg", mock_feishu_channel, "Streaming task")
        writer._start_patch_locked = Mock()

        with writer._state_lock:
            writer._patch_in_flight = True

        writer.on_event(12, 34, "assistant", "[thinking] Hello world")

        writer._start_patch_locked.assert_not_called()
        assert writer._dirty is True
