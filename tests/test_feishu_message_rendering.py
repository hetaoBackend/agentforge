"""
Tests for Feishu outbound message card rendering.
"""

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
