"""
Tests for Feishu outbound dispatch, SDK wrappers, usage stats and small card
builder helpers. Complements tests/test_feishu_message_rendering.py (which covers
notification/streaming card layout) without duplicating it.
"""

from unittest.mock import Mock, patch

import pytest

from taskboard_bus import OutboundMessage, OutboundMessageType


@pytest.fixture
def channel():
    with patch("channels.feishu_channel.FEISHU_AVAILABLE", True):
        from channels.feishu_channel import FeishuChannel

        ch = FeishuChannel(Mock(), Mock(), Mock())
        ch._client = Mock()
        return ch


def _lark_response(success=True, message_id="om_new", code=0, msg="ok"):
    """Build a lark-style response object with .success()/.code/.msg/.data."""
    resp = Mock()
    resp.success.return_value = success
    resp.code = code
    resp.msg = msg
    resp.data = Mock()
    resp.data.message_id = message_id
    return resp


# ── send() / _on_outbound dispatch ────────────────────────────────────


class TestSendDispatch:
    def test_send_ignores_non_terminal_types(self, channel):
        channel.db.get_task = Mock()
        msg = OutboundMessage(type=OutboundMessageType.TASK_STARTED, task_id=1, payload={})
        channel.send(msg)
        channel.db.get_task.assert_not_called()

    def test_send_skips_when_client_missing(self, channel):
        channel._client = None
        channel.db.get_task = Mock()
        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED, task_id=1, payload={"result": "x"}
        )
        channel.send(msg)
        channel.db.get_task.assert_not_called()

    def test_send_skips_when_task_not_found(self, channel):
        channel.db.get_task = Mock(return_value=None)
        channel._send_message = Mock()
        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED, task_id=1, payload={"result": "x"}
        )
        channel.send(msg)
        channel._send_message.assert_not_called()

    def test_send_failed_uses_error_and_status_hint(self, channel):
        task = {"id": 3, "title": "Boom", "prompt": "p", "agent": "claude", "result": None}
        channel.db.get_task = Mock(return_value=task)
        channel.db.get_setting = Mock(return_value="oc_default")
        channel._stop_streaming = Mock(return_value=None)
        channel._send_message = Mock(return_value="om_sent")

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_FAILED,
            task_id=3,
            payload={"error": "boom happened"},
        )
        channel.send(msg)

        args, kwargs = channel._send_message.call_args
        assert args[1] == "boom happened"  # content (error)
        card = kwargs["card"]
        assert any(
            el.get("tag") == "markdown" and "/status 3" in el.get("content", "")
            for el in card["body"]["elements"]
        )

    def test_send_failed_truncates_long_error_to_800(self, channel):
        task = {"id": 4, "title": "Boom", "prompt": "p", "agent": "claude", "result": None}
        channel.db.get_task = Mock(return_value=task)
        channel.db.get_setting = Mock(return_value="oc_default")
        channel._stop_streaming = Mock(return_value=None)
        channel._send_message = Mock(return_value="om_sent")

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_FAILED,
            task_id=4,
            payload={"error": "E" * 2000},
        )
        channel.send(msg)
        content = channel._send_message.call_args.args[1]
        assert content == "E" * 800

    def test_send_falls_back_to_default_chat_when_no_origin(self, channel):
        task = {"id": 5, "title": "Done", "prompt": "p", "agent": "codex", "result": "all good"}
        channel.db.get_task = Mock(return_value=task)
        channel.db.get_setting = Mock(return_value="oc_default")
        channel._stop_streaming = Mock(return_value=None)
        channel._collect_generated_image_paths = Mock(return_value=[])
        channel._send_message = Mock(return_value="om_sent")

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED, task_id=5, payload={"result": "all good"}
        )
        channel.send(msg)

        channel.db.get_setting.assert_called_with("feishu_default_chat_id")
        assert channel._send_message.call_args.args[0] == "oc_default"
        # Successful send registers the notification mapping.
        assert channel._notification_map["om_sent"] == 5

    def test_send_no_default_chat_logs_failure_without_mapping(self, channel):
        task = {"id": 6, "title": "Done", "prompt": "p", "agent": "codex", "result": "ok"}
        channel.db.get_task = Mock(return_value=task)
        channel.db.get_setting = Mock(return_value=None)  # no default chat
        channel._stop_streaming = Mock(return_value=None)
        channel._collect_generated_image_paths = Mock(return_value=[])
        channel._send_message = Mock(return_value="om_sent")

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED, task_id=6, payload={"result": "ok"}
        )
        channel.send(msg)

        channel._send_message.assert_not_called()
        assert channel._notification_map == {}

    def test_send_with_origin_replies_in_thread_and_reacts(self, channel):
        task = {"id": 7, "title": "Done", "prompt": "p", "agent": "codex", "result": "yay"}
        channel.db.get_task = Mock(return_value=task)
        channel._stop_streaming = Mock(return_value=None)
        channel._collect_generated_image_paths = Mock(return_value=[])
        channel._add_reaction = Mock()
        channel._reply_message = Mock(return_value="om_reply")
        channel._send_message = Mock()
        channel._task_origin[7] = ("oc_chat", "root_msg", "reaction_msg")

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED, task_id=7, payload={"result": "yay"}
        )
        channel.send(msg)

        channel._add_reaction.assert_called_once_with("reaction_msg", "DONE")
        channel._reply_message.assert_called_once()
        assert channel._reply_message.call_args.args[0] == "root_msg"
        channel._send_message.assert_not_called()
        # Origin freed after terminal state.
        assert 7 not in channel._task_origin

    def test_send_failed_with_origin_uses_cry_reaction(self, channel):
        task = {"id": 8, "title": "Boom", "prompt": "p", "agent": "codex", "result": None}
        channel.db.get_task = Mock(return_value=task)
        channel._stop_streaming = Mock(return_value=None)
        channel._add_reaction = Mock()
        channel._reply_message = Mock(return_value="om_reply")
        channel._task_origin[8] = ("oc_chat", "root_msg", "reaction_msg")

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_FAILED, task_id=8, payload={"error": "nope"}
        )
        channel.send(msg)
        channel._add_reaction.assert_called_once_with("reaction_msg", "Cry")

    def test_send_patches_streaming_card_when_present(self, channel):
        task = {"id": 9, "title": "Done", "prompt": "p", "agent": "codex", "result": "final"}
        channel.db.get_task = Mock(return_value=task)
        channel._stop_streaming = Mock(return_value="history line")
        channel._collect_generated_image_paths = Mock(return_value=[])
        channel._add_reaction = Mock()
        channel._patch_message = Mock(return_value=True)
        channel._reply_message = Mock()
        channel._task_origin[9] = ("oc_chat", "root_msg", "reaction_msg")
        channel._streaming_msg[9] = "om_stream"

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED, task_id=9, payload={"result": "final"}
        )
        channel.send(msg)

        channel._patch_message.assert_called_once()
        assert channel._patch_message.call_args.args[0] == "om_stream"
        channel._reply_message.assert_not_called()
        assert channel._notification_map["om_stream"] == 9

    def test_send_falls_back_to_reply_when_patch_fails(self, channel):
        task = {"id": 10, "title": "Done", "prompt": "p", "agent": "codex", "result": "final"}
        channel.db.get_task = Mock(return_value=task)
        channel._stop_streaming = Mock(return_value=None)
        channel._collect_generated_image_paths = Mock(return_value=[])
        channel._add_reaction = Mock()
        channel._patch_message = Mock(return_value=False)
        channel._reply_message = Mock(return_value="om_reply")
        channel._task_origin[10] = ("oc_chat", "root_msg", "reaction_msg")
        channel._streaming_msg[10] = "om_stream"

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED, task_id=10, payload={"result": "final"}
        )
        channel.send(msg)

        channel._patch_message.assert_called_once()
        channel._reply_message.assert_called_once()
        assert channel._notification_map["om_reply"] == 10

    def test_send_attaches_generated_image_keys(self, channel):
        task = {"id": 11, "title": "Img", "prompt": "p", "agent": "codex", "result": "see image"}
        channel.db.get_task = Mock(return_value=task)
        channel.db.get_setting = Mock(return_value="oc_default")
        channel._stop_streaming = Mock(return_value=None)
        channel._collect_generated_image_paths = Mock(return_value=["/tmp/a.png"])
        channel._upload_image_entries = Mock(return_value=[("/tmp/a.png", "img_key_1")])
        channel._hide_generated_image_paths = Mock(return_value="see image")
        channel._send_message = Mock(return_value="om_sent")

        msg = OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED, task_id=11, payload={"result": "see image"}
        )
        channel.send(msg)

        channel._hide_generated_image_paths.assert_called_once()
        card = channel._send_message.call_args.kwargs["card"]
        assert card["body"]["elements"][-1] == {
            "tag": "img",
            "img_key": "img_key_1",
            "alt": {"tag": "plain_text", "content": "generated image 1"},
        }

    def test_on_outbound_delegates_to_send(self, channel):
        channel.send = Mock()
        msg = OutboundMessage(type=OutboundMessageType.TASK_COMPLETED, task_id=1, payload={})
        channel._on_outbound(msg)
        channel.send.assert_called_once_with(msg)


# ── SDK wrappers ──────────────────────────────────────────────────────


class TestCreateMessage:
    def test_create_message_success_returns_id(self, channel):
        channel._client.im.v1.message.create.return_value = _lark_response(message_id="om_ok")
        result = channel._create_message(
            receive_id_type="chat_id", chat_id="oc_x", card={"schema": "2.0"}
        )
        assert result == "om_ok"
        req = channel._client.im.v1.message.create.call_args.args[0]
        body = req.request_body
        assert body.receive_id == "oc_x"
        assert body.msg_type == "interactive"
        assert "schema" in body.content

    def test_create_message_failure_returns_none(self, channel):
        channel._client.im.v1.message.create.return_value = _lark_response(
            success=False, code=99, msg="bad"
        )
        assert channel._create_message("chat_id", "oc_x", {"k": "v"}) is None


class TestCreateReply:
    def test_create_reply_success_sets_thread_flag(self, channel):
        channel._client.im.v1.message.reply.return_value = _lark_response(message_id="om_reply")
        result = channel._create_reply(parent_message_id="om_parent", card={"a": 1})
        assert result == "om_reply"
        req = channel._client.im.v1.message.reply.call_args.args[0]
        assert req.message_id == "om_parent"
        assert req.request_body.reply_in_thread is True
        assert req.request_body.msg_type == "interactive"

    def test_create_reply_failure_returns_none(self, channel):
        channel._client.im.v1.message.reply.return_value = _lark_response(
            success=False, code=5, msg="nope"
        )
        assert channel._create_reply("om_parent", {"a": 1}) is None

    def test_create_reply_no_client_returns_none(self, channel):
        channel._client = None
        assert channel._create_reply("om_parent", {"a": 1}) is None


class TestSendMessage:
    def test_send_message_returns_id_on_success(self, channel):
        channel._create_message = Mock(return_value="om_1")
        result = channel._send_message("oc_chat", "hi", card={"schema": "2.0"})
        assert result == "om_1"
        assert channel._create_message.call_args.kwargs["receive_id_type"] == "chat_id"

    def test_send_message_uses_open_id_for_non_oc(self, channel):
        channel._create_message = Mock(return_value="om_1")
        channel._send_message("ou_user", "hi", card={"schema": "2.0"})
        assert channel._create_message.call_args.kwargs["receive_id_type"] == "open_id"

    def test_send_message_no_client_returns_none(self, channel):
        channel._client = None
        assert channel._send_message("oc_x", "hi") is None

    def test_send_message_builds_legacy_card_when_no_card(self, channel):
        channel._create_message = Mock(return_value="om_1")
        channel._send_message("oc_x", "plain text")
        sent_card = channel._create_message.call_args.kwargs["card"]
        assert sent_card == channel._build_legacy_markdown_card("plain text")

    def test_send_message_retries_with_legacy_on_card_failure(self, channel):
        channel._create_message = Mock(side_effect=[None, "om_retry"])
        result = channel._send_message(
            "oc_x", "content", card={"schema": "2.0"}, fallback_content="fb"
        )
        assert result == "om_retry"
        assert channel._create_message.call_count == 2
        retry_card = channel._create_message.call_args_list[1].kwargs["card"]
        assert retry_card == channel._build_legacy_markdown_card("fb")

    def test_send_message_no_retry_when_legacy_card_originally(self, channel):
        # card=None path: a single failure returns None (no retry).
        channel._create_message = Mock(return_value=None)
        assert channel._send_message("oc_x", "content") is None
        assert channel._create_message.call_count == 1

    def test_send_message_handles_exception(self, channel):
        channel._create_message = Mock(side_effect=RuntimeError("boom"))
        assert channel._send_message("oc_x", "content", card={"a": 1}) is None


class TestReplyMessage:
    def test_reply_message_returns_id_on_success(self, channel):
        channel._create_reply = Mock(return_value="om_r")
        assert channel._reply_message("om_parent", "hi", card={"a": 1}) == "om_r"

    def test_reply_message_no_client_returns_none(self, channel):
        channel._client = None
        assert channel._reply_message("om_parent", "hi") is None

    def test_reply_message_retries_with_legacy_on_failure(self, channel):
        channel._create_reply = Mock(side_effect=[None, "om_retry"])
        result = channel._reply_message("om_parent", "content", card={"schema": "2.0"})
        assert result == "om_retry"
        assert channel._create_reply.call_count == 2
        retry_card = channel._create_reply.call_args_list[1].kwargs["card"]
        assert retry_card == channel._build_legacy_markdown_card("content")

    def test_reply_message_no_retry_when_legacy_card(self, channel):
        channel._create_reply = Mock(return_value=None)
        assert channel._reply_message("om_parent", "content") is None
        assert channel._create_reply.call_count == 1

    def test_reply_message_handles_exception(self, channel):
        channel._create_reply = Mock(side_effect=RuntimeError("boom"))
        assert channel._reply_message("om_parent", "content", card={"a": 1}) is None


class TestPatchMessage:
    def test_patch_message_success(self, channel):
        channel._client.im.v1.message.patch.return_value = _lark_response()
        assert channel._patch_message("om_x", {"schema": "2.0"}) is True
        req = channel._client.im.v1.message.patch.call_args.args[0]
        assert req.message_id == "om_x"
        assert "schema" in req.request_body.content

    def test_patch_message_failure_returns_false(self, channel):
        channel._client.im.v1.message.patch.return_value = _lark_response(
            success=False, code=7, msg="nope"
        )
        assert channel._patch_message("om_x", {"a": 1}) is False

    def test_patch_message_no_client_returns_false(self, channel):
        channel._client = None
        assert channel._patch_message("om_x", {"a": 1}) is False

    def test_patch_message_handles_exception(self, channel):
        channel._client.im.v1.message.patch.side_effect = RuntimeError("boom")
        assert channel._patch_message("om_x", {"a": 1}) is False


# ── _add_reaction ─────────────────────────────────────────────────────


class TestAddReaction:
    def test_add_reaction_success_calls_sdk(self, channel):
        with patch("channels.feishu_channel.threading.Thread") as thread_cls:
            thread_cls.side_effect = lambda target, daemon: _RunNowThread(target)
            channel._add_reaction("om_x", "DONE")
        channel._client.im.v1.message_reaction.create.assert_called_once()

    def test_add_reaction_swallows_exception(self, channel):
        channel._client.im.v1.message_reaction.create.side_effect = RuntimeError("boom")
        with patch("channels.feishu_channel.threading.Thread") as thread_cls:
            thread_cls.side_effect = lambda target, daemon: _RunNowThread(target)
            channel._add_reaction("om_x", "DONE")  # must not raise

    def test_add_reaction_no_client_noop(self, channel):
        channel._client = None
        channel._add_reaction("om_x")  # must not raise


class _RunNowThread:
    """Thread stand-in that runs the target synchronously on start()."""

    def __init__(self, target):
        self._target = target

    def start(self):
        self._target()


# ── small builders / text helpers ─────────────────────────────────────


class TestTextHelpers:
    def test_build_legacy_markdown_card(self, channel):
        card = channel._build_legacy_markdown_card("hello")
        assert card == {
            "config": {"wide_screen_mode": True},
            "elements": [{"tag": "markdown", "content": "hello"}],
        }

    def test_truncate_text_under_limit_unchanged(self, channel):
        assert channel._truncate_text("short", 100) == "short"

    def test_truncate_text_over_limit_marks_truncated(self, channel):
        out = channel._truncate_text("A" * 50, 10)
        assert out.startswith("A" * 10)
        assert out.endswith("…(truncated)")

    def test_truncate_text_normalizes_crlf(self, channel):
        assert channel._truncate_text("a\r\nb", 100) == "a\nb"

    def test_chunk_text_empty_returns_single_empty(self, channel):
        assert channel._chunk_text("", 10) == [""]

    def test_chunk_text_splits_on_limit(self, channel):
        assert channel._chunk_text("abcdef", 2) == ["ab", "cd", "ef"]

    def test_escape_feishu_markdown_doubles_backslash(self, channel):
        assert channel._escape_feishu_markdown(r"a\b") == r"a\\b"

    def test_build_result_elements_chunks_and_appends_images(self, channel):
        elements = channel._build_result_elements("body", image_keys=["k1", "k2"])
        assert elements[0] == {"tag": "markdown", "content": "body"}
        assert elements[-2:] == [
            {
                "tag": "img",
                "img_key": "k1",
                "alt": {"tag": "plain_text", "content": "generated image 1"},
            },
            {
                "tag": "img",
                "img_key": "k2",
                "alt": {"tag": "plain_text", "content": "generated image 2"},
            },
        ]

    def test_build_result_elements_empty_body_defaults_done(self, channel):
        assert channel._build_result_elements("") == [{"tag": "markdown", "content": "Done."}]

    def test_strip_final_result_from_history_removes_suffix(self, channel):
        out = channel._strip_final_result_from_history("trace step\nfinal answer", "final answer")
        assert out == "trace step"

    def test_strip_final_result_keeps_history_when_not_suffix(self, channel):
        out = channel._strip_final_result_from_history("trace step\nfinal", "other text")
        assert out == "trace step\nfinal"

    def test_strip_final_result_empty_final_returns_history(self, channel):
        assert channel._strip_final_result_from_history("hist", "") == "hist"

    def test_build_streaming_history_elements_empty(self, channel):
        assert channel._build_streaming_history_elements("\n\n") == []

    def test_build_streaming_history_elements_lines(self, channel):
        elements = channel._build_streaming_history_elements("a\n\nb")
        assert [e["text"]["content"] for e in elements] == ["a", " ", "b"]
        assert all(e["text"]["text_color"] == "grey" for e in elements)


# ── _get_usage_stats ──────────────────────────────────────────────────


def _block(**overrides):
    base = {
        "isGap": False,
        "isActive": True,
        "startTime": "2026-06-04T08:00:00+00:00",
        "endTime": "2026-06-04T13:00:00+00:00",
        "totalTokens": 9500,
        "costUSD": 9.0,
        "sentMessagesCount": 125,
        "durationMinutes": 120,
    }
    base.update(overrides)
    return base


class TestUsageStats:
    def test_no_data_returns_no_records(self, channel):
        with patch("claude_monitor.data.analysis.analyze_usage", return_value=None):
            assert channel._get_usage_stats() == "📊 未找到 Claude Code 用量记录"

    def test_no_blocks_key_returns_no_records(self, channel):
        with patch("claude_monitor.data.analysis.analyze_usage", return_value={"blocks": []}):
            assert channel._get_usage_stats() == "📊 未找到 Claude Code 用量记录"

    def test_only_gap_blocks_returns_no_records(self, channel):
        data = {"blocks": [{"isGap": True}]}
        with patch("claude_monitor.data.analysis.analyze_usage", return_value=data):
            assert channel._get_usage_stats() == "📊 未找到 Claude Code 用量记录"

    def test_active_block_renders_full_stats(self, channel):
        channel.db.get_setting = Mock(return_value="pro")
        data = {"blocks": [_block()]}
        with patch("claude_monitor.data.analysis.analyze_usage", return_value=data):
            out = channel._get_usage_stats()

        assert out.startswith("**📊 Claude Code 用量**")
        assert "(活跃)" in out
        assert "Plan: pro" in out
        # 9500 tokens / 19000 limit = 50%
        assert "📊 Token: **[" in out
        assert "50.0%" in out
        assert "9,500 / 19,000" in out
        # 125 msgs / 250 limit = 50%
        assert "125 / 250" in out
        # cost 9 / 18 = 50%
        assert "$9.00 / $18" in out
        assert "🔥 Burn:" in out

    def test_inactive_block_shows_ended_label(self, channel):
        channel.db.get_setting = Mock(return_value="pro")
        data = {"blocks": [_block(isActive=False)]}
        with patch("claude_monitor.data.analysis.analyze_usage", return_value=data):
            out = channel._get_usage_stats()
        assert "(已结束)" in out

    def test_percentages_capped_at_100(self, channel):
        channel.db.get_setting = Mock(return_value="pro")
        data = {"blocks": [_block(totalTokens=10**9, costUSD=10**6, sentMessagesCount=10**6)]}
        with patch("claude_monitor.data.analysis.analyze_usage", return_value=data):
            out = channel._get_usage_stats()
        assert "100.0%" in out

    def test_exception_returns_error_message(self, channel):
        with patch(
            "claude_monitor.data.analysis.analyze_usage",
            side_effect=RuntimeError("kaboom"),
        ):
            out = channel._get_usage_stats()
        assert out.startswith("❌ 获取用量统计失败：")
        assert "kaboom" in out
