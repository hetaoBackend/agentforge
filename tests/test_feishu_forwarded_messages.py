"""
Tests for Feishu forwarded/quoted message handling functionality.
"""

import json
import pytest
from unittest.mock import Mock, MagicMock, patch
from datetime import datetime


@pytest.fixture
def mock_feishu_channel():
    """Create a mock FeishuChannel instance for testing."""
    with patch('channels.feishu_channel.FEISHU_AVAILABLE', True):
        from channels.feishu_channel import FeishuChannel

        bus = Mock()
        db = Mock()
        scheduler = Mock()

        channel = FeishuChannel(bus, db, scheduler)

        # Mock the lark client
        channel._client = Mock()

        return channel


class TestForwardedMessageDetection:
    """Test the detection and parsing of forwarded/quoted messages."""

    def test_extract_forwarded_content_forward_type(self, mock_feishu_channel):
        """Test extraction of 'forward' type messages."""
        message = Mock()
        message.message_type = "forward"
        message.content = json.dumps({
            "sender_name": "张三",
            "sender_id": "ou_123456789",
            "create_time": 1738080000,
            "text": "这是一条转发的消息",
            "images": []
        })

        result = mock_feishu_channel._extract_forwarded_content(message)

        assert result is not None
        assert result["type"] == "forward"
        assert result["sender_name"] == "张三"
        assert result["sender_id"] == "ou_123456789"
        assert result["timestamp"] == 1738080000
        assert result["text"] == "这是一条转发的消息"

    def test_extract_forwarded_content_quote_type(self, mock_feishu_channel):
        """Test extraction of quote type messages."""
        message = Mock()
        message.message_type = "post"
        message.content = json.dumps({
            "zh_cn": {
                "content": [[
                    {
                        "tag": "quote",
                        "text": "被引用的文本内容",
                        "user": {
                            "name": "李四",
                            "open_id": "ou_987654321"
                        },
                        "create_time": 1738083600
                    }
                ]]
            }
        })

        result = mock_feishu_channel._extract_forwarded_content(message)

        assert result is not None
        assert result["type"] == "quote"
        assert result["sender_name"] == "李四"
        assert result["sender_id"] == "ou_987654321"
        assert result["text"] == "被引用的文本内容"
        assert result["timestamp"] == 1738083600

    def test_extract_forwarded_content_nested_message(self, mock_feishu_channel):
        """Test extraction of nested_message type (forward) in post."""
        message = Mock()
        message.message_type = "post"
        message.content = json.dumps({
            "content": [[
                {
                    "tag": "nested_message",
                    "nested_message": {
                        "sender_name": "王五",
                        "sender_id": "ou_555555555",
                        "create_time": 1738087200,
                        "text": "嵌套消息内容",
                        "images": [
                            {"image_key": "img_v2_abcd1234"}
                        ]
                    }
                }
            ]]
        })

        result = mock_feishu_channel._extract_forwarded_content(message)

        assert result is not None
        assert result["type"] == "forward"
        assert result["sender_name"] == "王五"
        assert result["text"] == "嵌套消息内容"
        assert len(result["images"]) == 1
        assert result["images"][0]["image_key"] == "img_v2_abcd1234"

    def test_extract_forwarded_content_no_forward(self, mock_feishu_channel):
        """Test that regular messages return None."""
        message = Mock()
        message.message_type = "text"
        message.content = json.dumps({"text": "普通消息"})

        result = mock_feishu_channel._extract_forwarded_content(message)

        assert result is None

    def test_extract_forwarded_content_malformed_json(self, mock_feishu_channel):
        """Test handling of malformed JSON."""
        message = Mock()
        message.message_type = "forward"
        message.content = "{invalid json"

        result = mock_feishu_channel._extract_forwarded_content(message)

        assert result is None


class TestForwardedPromptFormatting:
    """Test the formatting of forwarded content into prompts."""

    def test_format_forwarded_prompt_basic(self, mock_feishu_channel):
        """Test basic formatting of forwarded content."""
        forwarded = {
            "type": "forward",
            "sender_name": "张三",
            "sender_id": "ou_123456",
            "timestamp": 1738080000,
            "text": "这是转发的内容",
            "images": []
        }
        original_content = "请帮我分析上述消息"

        result = mock_feishu_channel._format_forwarded_prompt(original_content, forwarded)

        assert "📨 [转发消息]" in result
        assert "转发自: 张三" in result
        assert "时间: 2025-01-29 00:00" in result  # Local timezone (UTC+8)
        assert "--- 转发内容 ---" in result
        assert "这是转发的内容" in result
        assert "--- 用户附加消息 ---" in result
        assert "请帮我分析上述消息" in result

    def test_format_forwarded_prompt_no_timestamp(self, mock_feishu_channel):
        """Test formatting when timestamp is missing."""
        forwarded = {
            "type": "forward",
            "sender_name": "李四",
            "text": "无时间戳的转发",
            "images": []
        }
        original_content = "看看这个"

        result = mock_feishu_channel._format_forwarded_prompt(original_content, forwarded)

        assert "转发自: 李四" in result
        assert "时间:" not in result

    def test_format_forwarded_prompt_with_images(self, mock_feishu_channel):
        """Test formatting when forwarded content includes images."""
        forwarded = {
            "type": "forward",
            "sender_name": "王五",
            "text": "一张图片",
            "images": [
                {"image_key": "img1"},
                {"image_key": "img2"}
            ]
        }
        original_content = ""

        result = mock_feishu_channel._format_forwarded_prompt(original_content, forwarded)

        assert "[包含 2 张图片]" in result

    def test_format_forwarded_prompt_no附加消息(self, mock_feishu_channel):
        """Test formatting when user didn't add additional message."""
        forwarded = {
            "type": "quote",
            "sender_name": "赵六",
            "text": "只是引用没有附加消息",
            "images": []
        }
        original_content = "   "  # Only spaces

        result = mock_feishu_channel._format_forwarded_prompt(original_content, forwarded)

        assert "--- 转发内容 ---" in result
        # Should not have "用户附加消息" section when original is empty
        assert "--- 用户附加消息 ---" not in result

    def test_format_forwarded_prompt_none_forwarded(self, mock_feishu_channel):
        """Test that None forwarded returns original content unchanged."""
        original_content = "这是一条普通消息"

        result = mock_feishu_channel._format_forwarded_prompt(original_content, None)

        assert result == original_content

    def test_format_forwarded_prompt_empty_forwarded(self, mock_feishu_channel):
        """Test that empty dict forwarded returns original content."""
        original_content = "这是一条普通消息"

        result = mock_feishu_channel._format_forwarded_prompt(original_content, {})

        assert result == original_content


class TestForwardedImageHandling:
    """Test handling of images in forwarded messages."""

    def test_download_image_called_for_forwarded_images(
        self, mock_feishu_channel
    ):
        """Test that images in forwarded messages are downloaded."""
        # Simulate forwarded message with images
        forwarded = {
            "type": "forward",
            "sender_name": "测试用户",
            "text": "带图片的转发",
            "images": [
                {"image_key": "img_key_1"},
                {"image_key": "img_key_2"}
            ]
        }

        message = Mock()
        message.message_type = "post"
        message.message_id = "msg_123"
        message.content = json.dumps({"zh_cn": {"content": [[]]}})

        # Mock image download to return paths
        mock_feishu_channel._download_image = Mock(return_value="/tmp/test.jpg")

        # Simulate the integration in _handle_inbound
        image_paths = []
        for img_info in forwarded.get("images", []):
            img_key = img_info.get("image_key")
            if img_key:
                img_path = mock_feishu_channel._download_image(message.message_id, img_key)
                if img_path:
                    image_paths.append(img_path)

        assert len(image_paths) == 2
        assert all("/tmp/test.jpg" in path for path in image_paths)


class TestForwardedMessageScenarios:
    """Test real-world scenarios of forwarded messages."""

    def test_telegram_forwarded_from_user(self, mock_feishu_channel):
        """Simulate a Telegram-style forwarded message converted to Feishu format."""
        forwarded = {
            "type": "forward",
            "sender_name": "Alice",
            "sender_id": "telegram_user_12345",
            "timestamp": 1738080000,
            "text": "Hey, did you see the new feature?",
            "images": []
        }
        original_content = "Can you explain this feature?"

        result = mock_feishu_channel._format_forwarded_prompt(original_content, forwarded)

        assert "转发自: Alice" in result
        assert "Hey, did you see the new feature?" in result
        assert "Can you explain this feature?" in result

    def test_channel_forwarded_post(self, mock_feishu_channel):
        """Simulate a forwarded post from a channel."""
        forwarded = {
            "type": "forward",
            "sender_name": "技术资讯频道",
            "text": "发布了一个新的AI模型，效果惊人...\n\nLink: https://example.com",
            "images": [
                {"image_key": "chart_123"}
            ],
            "timestamp": 1738087200
        }
        original_content = "帮我总结一下这个新闻"

        result = mock_feishu_channel._format_forwarded_prompt(original_content, forwarded)

        assert "转发自: 技术资讯频道" in result
        assert "发布了一个新的AI模型" in result
        assert "[包含 1 张图片]" in result
        assert "帮我总结一下这个新闻" in result

    def test_nested_forward_chain(self, mock_feishu_channel):
        """Test handling of a message that has been forwarded multiple times."""
        forwarded = {
            "type": "forward",
            "sender_name": "传播者B",
            "text": "传播者A: 原始发布者: 这是最初的消息",
            "timestamp": 1738090800,
            "images": []
        }
        original_content = ""

        result = mock_feishu_channel._format_forwarded_prompt(original_content, forwarded)

        assert "转发自: 传播者B" in result
        assert "传播者A: 原始发布者: 这是最初的消息" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
