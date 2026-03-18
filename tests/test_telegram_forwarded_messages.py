"""
Tests for Telegram forwarded message handling functionality.
"""

from dataclasses import dataclass
from unittest.mock import Mock, patch

import pytest


@pytest.fixture
def mock_telegram_channel():
    """Create a mock TelegramChannel instance for testing."""
    with patch("channels.telegram_channel.TELEGRAM_AVAILABLE", True):
        from channels.telegram_channel import TelegramChannel

        bus = Mock()
        db = Mock()
        scheduler = Mock()

        channel = TelegramChannel(
            bus=bus, db=db, scheduler=scheduler, token="fake_token", allowed_users=None
        )

        # Mock the app and loop
        channel._app = Mock()
        channel._loop = Mock()
        channel._loop_ready = Mock()
        channel._loop_ready.set()

        return channel


@dataclass
class MockUser:
    """Mock Telegram User object."""

    id: int
    first_name: str
    last_name: str = ""
    username: str = ""

    def __getattr__(self, name):
        # Return None for any attribute not defined
        return None


@dataclass
class MockChat:
    """Mock Telegram Chat object."""

    id: int
    type: str = "private"
    title: str = ""
    username: str = ""

    def __getattr__(self, name):
        return None


@dataclass
class MockMessage:
    """Mock Telegram Message object."""

    message_id: int
    text: str
    from_user: MockUser
    chat: MockChat
    forward_from: MockUser = None
    forward_from_chat: MockChat = None
    forward_date: int = None
    reply_to_message = None

    def __getattr__(self, name):
        return None


class TestTelegramForwardMessageDetection:
    """Test detection of forwarded messages in Telegram updates."""

    def test_format_forwarded_text_from_user(self, mock_telegram_channel):
        """Test formatting a message forwarded from a user."""
        forward_user = MockUser(
            id=12345, first_name="Alice", last_name="Smith", username="alice_smith"
        )

        message = MockMessage(
            message_id=100,
            text="Original message content",
            from_user=MockUser(id=999, first_name="Bob"),
            chat=MockChat(id=888, type="private"),
            forward_from=forward_user,
            forward_date=1738080000,
        )

        update = Mock()
        update.message = message

        result = mock_telegram_channel._format_forwarded_text("Original message content", update)

        assert "📨 [转发消息]" in result
        assert "转发自: @alice_smith" in result
        assert "时间: 2025-01-29 00:00" in result
        assert "--- 转发内容 ---" in result
        assert "Original message content" in result

    def test_format_forwarded_text_from_user_no_username(self, mock_telegram_channel):
        """Test formatting when forwarded user has no username."""
        forward_user = MockUser(id=12345, first_name="张三", last_name="李四", username="")

        message = MockMessage(
            message_id=100,
            text="测试消息",
            from_user=MockUser(id=999, first_name="王五"),
            chat=MockChat(id=888, type="private"),
            forward_from=forward_user,
            forward_date=1738080000,
        )

        update = Mock()
        update.message = message

        result = mock_telegram_channel._format_forwarded_text("测试消息", update)

        assert "转发自: 张三 李四" in result

    def test_format_forwarded_text_from_user_only_firstname(self, mock_telegram_channel):
        """Test formatting when forwarded user has only first name."""
        forward_user = MockUser(id=12345, first_name="Charlie", last_name="", username="")

        message = MockMessage(
            message_id=100,
            text="Message",
            from_user=MockUser(id=999, first_name="Dave"),
            chat=MockChat(id=888, type="private"),
            forward_from=forward_user,
            forward_date=1738080000,
        )

        update = Mock()
        update.message = message

        result = mock_telegram_channel._format_forwarded_text("Message", update)

        assert "转发自: Charlie" in result

    def test_format_forwarded_text_from_channel(self, mock_telegram_channel):
        """Test formatting a message forwarded from a channel."""
        forward_chat = MockChat(
            id=-100123456789, type="channel", title="Tech News", username="technews"
        )

        message = MockMessage(
            message_id=100,
            text="Breaking news: API update",
            from_user=MockUser(id=999, first_name="Reader"),
            chat=MockChat(id=888, type="private"),
            forward_from_chat=forward_chat,
            forward_date=1738083600,
        )

        update = Mock()
        update.message = message

        result = mock_telegram_channel._format_forwarded_text("Breaking news: API update", update)

        assert "📨 [转发消息]" in result
        assert "转发自频道: Tech News" in result

    def test_format_forwarded_text_from_group(self, mock_telegram_channel):
        """Test formatting a message forwarded from a group."""
        forward_chat = MockChat(
            id=-100987654321, type="supergroup", title="Python Developers", username=""
        )

        message = MockMessage(
            message_id=100,
            text="Check this code snippet",
            from_user=MockUser(id=999, first_name="Dev"),
            chat=MockChat(id=888, type="private"),
            forward_from_chat=forward_chat,
            forward_date=1738087200,
        )

        update = Mock()
        update.message = message

        result = mock_telegram_channel._format_forwarded_text("Check this code snippet", update)

        assert "转发自群组: Python Developers" in result

    def test_format_forwarded_text_from_chat_no_title(self, mock_telegram_channel):
        """Test formatting when forwarded chat has no title."""
        forward_chat = MockChat(id=-100111222333, type="group", title="", username="unknown_group")

        message = MockMessage(
            message_id=100,
            text="Message",
            from_user=MockUser(id=999, first_name="User"),
            chat=MockChat(id=888, type="private"),
            forward_from_chat=forward_chat,
            forward_date=1738080000,
        )

        update = Mock()
        update.message = message

        result = mock_telegram_channel._format_forwarded_text("Message", update)

        assert "转发自群组: unknown_group" in result

    def test_format_forwarded_text_no_timestamp(self, mock_telegram_channel):
        """Test formatting when forward_date is missing."""
        forward_user = MockUser(id=12345, first_name="Sender")

        message = MockMessage(
            message_id=100,
            text="Message",
            from_user=MockUser(id=999, first_name="User"),
            chat=MockChat(id=888, type="private"),
            forward_from=forward_user,
            forward_date=None,
        )

        update = Mock()
        update.message = message

        result = mock_telegram_channel._format_forwarded_text("Message", update)

        assert "📨 [转发消息]" in result
        assert "转发自:" in result
        # Should not have time component
        assert "时间:" not in result

    def test_format_forwarded_text_not_forwarded(self, mock_telegram_channel):
        """Test that regular messages are unchanged."""
        message = MockMessage(
            message_id=100,
            text="Regular message",
            from_user=MockUser(id=999, first_name="User"),
            chat=MockChat(id=888, type="private"),
        )

        update = Mock()
        update.message = message

        result = mock_telegram_channel._format_forwarded_text("Regular message", update)

        assert result == "Regular message"
        assert "转发" not in result

    def test_format_forwarded_text_fallback_to_generic_sender(self, mock_telegram_channel):
        """Test formatting when forwarded info is incomplete."""
        message = MockMessage(
            message_id=100,
            text="Message",
            from_user=MockUser(id=999, first_name="User"),
            chat=MockChat(id=888, type="private"),
            forward_from=None,
            forward_from_chat=None,
            forward_date=1738080000,
        )

        update = Mock()
        update.message = message

        # The message has forward_date but no forward_from or forward_from_chat
        # This is technically possible in Telegram API
        message.forward_date = 1738080000

        result = mock_telegram_channel._format_forwarded_text("Message", update)

        # Should still show it's forwarded with timestamp
        assert "📨 [转发消息]" in result
        assert "时间: 2025-01-29 00:00" in result


class TestTelegramForwardedTaskCreation:
    """Test task creation from forwarded messages."""

    @patch("taskboard.Task")
    @patch("taskboard.ScheduleType")
    def test_create_task_from_forwarded_message(
        self, mock_schedule_type, mock_task_class, mock_telegram_channel
    ):
        """Test that forwarded messages create tasks with appropriate tags."""
        forward_user = MockUser(id=12345, first_name="Alice", username="alice")

        message = MockMessage(
            message_id=100,
            text="Analyze this forwarded post",
            from_user=MockUser(id=999, first_name="Bob"),
            chat=MockChat(id=888, type="private"),
            forward_from=forward_user,
            forward_date=1738080000,
        )

        update = Mock()
        update.message = message

        # Format the text first (as done in _handle_text_message)
        formatted_text = mock_telegram_channel._format_forwarded_text(message.text, update)

        # Mock Task class
        mock_task_instance = Mock()
        mock_task_class.return_value = mock_task_instance
        mock_telegram_channel.scheduler.submit_task.return_value = 123
        mock_telegram_channel.db.get_setting.return_value = "~"

        # Call _create_task
        mock_telegram_channel._create_task(formatted_text, 888, update)

        # Verify Task was created with forwarded tag
        mock_task_class.assert_called_once()
        call_kwargs = mock_task_class.call_args[1]
        assert ", forwarded" in call_kwargs["tags"]
        assert "📨 " in call_kwargs["title"]

    @patch("taskboard.Task")
    @patch("taskboard.ScheduleType")
    def test_create_task_from_normal_message(
        self, mock_schedule_type, mock_task_class, mock_telegram_channel
    ):
        """Test that normal messages create tasks without forwarded tag."""
        message = MockMessage(
            message_id=100,
            text="Regular task",
            from_user=MockUser(id=999, first_name="Bob"),
            chat=MockChat(id=888, type="private"),
        )

        update = Mock()
        update.message = message

        # Mock Task class
        mock_task_instance = Mock()
        mock_task_class.return_value = mock_task_instance
        mock_telegram_channel.scheduler.submit_task.return_value = 456
        mock_telegram_channel.db.get_setting.return_value = "~"

        # Call _create_task
        mock_telegram_channel._create_task("Regular task", 888, update)

        # Verify Task was created without forwarded tag
        mock_task_class.assert_called_once()
        call_kwargs = mock_task_class.call_args[1]
        assert call_kwargs["tags"] == "telegram"
        assert "📨 " not in call_kwargs["title"]


class TestTelegramForwardedMessageScenarios:
    """Test real-world scenarios of forwarded messages."""

    def test_user_forwards_news_article(self, mock_telegram_channel):
        """Simulate a user forwarding a news article from a channel."""
        forward_chat = MockChat(id=-100123456789, type="channel", title="Breaking News")

        message = MockMessage(
            message_id=100,
            text="Stock market hits all-time high amid tech rally...",
            from_user=MockUser(id=999, first_name="Investor"),
            chat=MockChat(id=888, type="private"),
            forward_from_chat=forward_chat,
            forward_date=1738080000,
        )

        update = Mock()
        update.message = message

        result = mock_telegram_channel._format_forwarded_text(message.text, update)

        assert "转发自频道: Breaking News" in result
        assert "Stock market hits all-time high" in result

    def test_user_forwards_another_users_code(self, mock_telegram_channel):
        """Simulate forwarding code snippet from another user."""
        forward_user = MockUser(id=12345, first_name="Dev", username="cool_dev")

        message = MockMessage(
            message_id=100,
            text="```python\ndef hello():\n    print('world')\n```",
            from_user=MockUser(id=999, first_name="Learner"),
            chat=MockChat(id=888, type="private"),
            forward_from=forward_user,
            forward_date=1738083600,
        )

        update = Mock()
        update.message = message

        result = mock_telegram_channel._format_forwarded_text(message.text, update)

        assert "转发自: @cool_dev" in result
        assert "def hello():" in result

    def test_forwarded_multiline_message(self, mock_telegram_channel):
        """Test handling of forwarded messages with multiple lines."""
        forward_user = MockUser(id=12345, first_name="Announcer")

        text = """This is a forwarded message
with multiple lines
and some bullet points:
- Point 1
- Point 2
- Point 3"""

        message = MockMessage(
            message_id=100,
            text=text,
            from_user=MockUser(id=999, first_name="Receiver"),
            chat=MockChat(id=888, type="private"),
            forward_from=forward_user,
            forward_date=1738087200,
        )

        update = Mock()
        update.message = message

        result = mock_telegram_channel._format_forwarded_text(text, update)

        assert "转发自: Announcer" in result
        assert "--- 转发内容 ---" in result
        assert "Point 1" in result
        assert "Point 3" in result

    def test_empty_text_with_forward(self, mock_telegram_channel):
        """Test when forwarded message has no text (e.g., media-only)."""
        forward_user = MockUser(id=12345, first_name="Sender")

        message = MockMessage(
            message_id=100,
            text="",  # Empty text, maybe just a photo
            from_user=MockUser(id=999, first_name="User"),
            chat=MockChat(id=888, type="private"),
            forward_from=forward_user,
            forward_date=1738080000,
        )

        update = Mock()
        update.message = message

        result = mock_telegram_channel._format_forwarded_text("", update)

        assert "📨 [转发消息]" in result
        assert "转发自: Sender" in result
        assert "--- 转发内容 ---" in result


class TestTelegramForwardedMessageIntegration:
    """Integration tests for the complete forwarded message flow."""

    @patch("taskboard.Task")
    @patch("taskboard.ScheduleType")
    def test_complete_forwarded_message_flow(
        self, mock_schedule_type, mock_task_class, mock_telegram_channel
    ):
        """Test the complete flow from forwarded message to task creation."""
        # Setup
        forward_user = MockUser(id=12345, first_name="Alice", username="alice")
        current_user = MockUser(id=999, first_name="Bob")
        chat = MockChat(id=888, type="private")

        message = MockMessage(
            message_id=100,
            text="Review this code",
            from_user=current_user,
            chat=chat,
            forward_from=forward_user,
            forward_date=1738080000,
        )

        update = Mock()
        update.message = message
        update.effective_user = Mock()
        update.effective_user.id = 999
        update.effective_chat = chat

        # Mock dependencies
        mock_task_instance = Mock()
        mock_task_class.return_value = mock_task_instance
        mock_telegram_channel.scheduler.submit_task.return_value = 789
        mock_telegram_channel.db.get_setting.return_value = "~"

        # Execute text formatting
        # Note: We're simulating just the text processing part
        formatted_text = mock_telegram_channel._format_forwarded_text(message.text, update)

        # Verify formatting
        assert "📨 [转发消息]" in formatted_text
        assert "转发自: @alice" in formatted_text
        assert "Review this code" in formatted_text

        # Task creation would normally happen next
        mock_telegram_channel._create_task(formatted_text, 888, update)

        # Verify task was created with forwarded content
        mock_task_class.assert_called_once()
        call_kwargs = mock_task_class.call_args[1]
        assert call_kwargs["prompt"] == formatted_text


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
