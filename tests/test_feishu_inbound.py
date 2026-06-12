"""
Tests for Feishu inbound event handling: the WebSocket dispatch layer.

Covers _on_reaction, _on_bot_added, _on_message_sync and the big
_handle_inbound dispatcher (command parsing, plain-message task creation,
resume-by-reply via thread, and malformed-payload handling).

These tests isolate the dispatch logic by mocking the lark client, the DB,
the scheduler, the bus, and the card/reply/reaction helpers, so nothing here
opens a real WebSocket or hits the network.
"""

import json
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest


@pytest.fixture
def mock_feishu_channel():
    """Create a FeishuChannel with all external dependencies mocked."""
    with patch("channels.feishu_channel.FEISHU_AVAILABLE", True):
        from channels.feishu_channel import FeishuChannel

        channel = FeishuChannel(Mock(), Mock(), Mock())
        channel._client = Mock()
        channel._running = True

        # Stub every outbound helper so dispatch logic is isolated.
        channel._send_message = Mock(return_value="om_sent")
        channel._reply_message = Mock(return_value="om_reply")
        channel._add_reaction = Mock()
        channel._create_reply = Mock(return_value="om_running")
        channel._build_streaming_card = Mock(return_value={"card": True})
        channel._start_streaming = Mock()
        channel._download_image = Mock(return_value=None)
        channel._extract_forwarded_content = Mock(return_value=None)
        return channel


def _make_event(
    *,
    content,
    msg_type="text",
    sender_type="user",
    open_id="ou_sender",
    chat_type="p2p",
    chat_id="oc_chat",
    message_id="om_msg",
    parent_id=None,
    root_id=None,
):
    """Build a synthetic lark im.message.receive_v1 event object."""
    sender_id = SimpleNamespace(open_id=open_id) if open_id is not None else None
    sender = SimpleNamespace(sender_type=sender_type, sender_id=sender_id)
    message = SimpleNamespace(
        message_type=msg_type,
        content=content,
        message_id=message_id,
        chat_type=chat_type,
        chat_id=chat_id,
        parent_id=parent_id,
        root_id=root_id,
    )
    event = SimpleNamespace(message=message, sender=sender)
    return SimpleNamespace(event=event)


def _text(text):
    return json.dumps({"text": text})


# ───────────────────────── trivial handlers ─────────────────────────


class TestSimpleHandlers:
    def test_on_reaction_is_noop(self, mock_feishu_channel):
        # Should never raise and never touch any helper.
        assert mock_feishu_channel._on_reaction(SimpleNamespace(event=None)) is None
        mock_feishu_channel._send_message.assert_not_called()

    def test_on_bot_added_sends_help(self, mock_feishu_channel):
        from channels.feishu_channel import HELP_TEXT

        data = SimpleNamespace(event=SimpleNamespace(chat_id="oc_new"))
        mock_feishu_channel._on_bot_added(data)

        mock_feishu_channel._send_message.assert_called_once_with("oc_new", HELP_TEXT)

    def test_on_bot_added_without_chat_id(self, mock_feishu_channel):
        data = SimpleNamespace(event=SimpleNamespace(chat_id=None))
        mock_feishu_channel._on_bot_added(data)

        mock_feishu_channel._send_message.assert_not_called()

    def test_on_bot_added_swallows_errors(self, mock_feishu_channel):
        # event has no chat_id attribute at all -> getattr returns None, no raise.
        bad = SimpleNamespace(event=object())
        mock_feishu_channel._on_bot_added(bad)
        mock_feishu_channel._send_message.assert_not_called()

    def test_on_bot_added_swallows_send_errors(self, mock_feishu_channel):
        # _send_message raising inside the handler must be caught (traceback path).
        mock_feishu_channel._send_message = Mock(side_effect=RuntimeError("send failed"))
        data = SimpleNamespace(event=SimpleNamespace(chat_id="oc_new"))
        # Should not raise.
        mock_feishu_channel._on_bot_added(data)

    def test_on_message_sync_delegates_to_handle_inbound(self, mock_feishu_channel):
        mock_feishu_channel._handle_inbound = Mock()
        sentinel = object()
        mock_feishu_channel._on_message_sync(sentinel)
        mock_feishu_channel._handle_inbound.assert_called_once_with(sentinel)

    def test_on_message_sync_swallows_handler_errors(self, mock_feishu_channel):
        mock_feishu_channel._handle_inbound = Mock(side_effect=RuntimeError("boom"))
        # Should not propagate.
        mock_feishu_channel._on_message_sync(object())

    def test_on_message_sync_ignores_after_stop(self, mock_feishu_channel):
        mock_feishu_channel._running = False
        mock_feishu_channel._handle_inbound = Mock()

        mock_feishu_channel._on_message_sync(object())

        mock_feishu_channel._handle_inbound.assert_not_called()


# ───────────────────────── message parsing ──────────────────────────


class TestInboundParsing:
    def test_bot_self_message_ignored(self, mock_feishu_channel):
        data = _make_event(content=_text("hi"), sender_type="bot")
        mock_feishu_channel._handle_inbound(data)
        mock_feishu_channel._add_reaction.assert_not_called()
        mock_feishu_channel.scheduler.submit_task.assert_not_called()

    def test_unsupported_message_type_ignored(self, mock_feishu_channel):
        data = _make_event(content=json.dumps({}), msg_type="audio")
        mock_feishu_channel._handle_inbound(data)
        mock_feishu_channel._add_reaction.assert_not_called()
        mock_feishu_channel.scheduler.submit_task.assert_not_called()

    def test_empty_text_after_strip_ignored(self, mock_feishu_channel):
        data = _make_event(content=_text("   "))
        mock_feishu_channel._handle_inbound(data)
        mock_feishu_channel._add_reaction.assert_not_called()
        mock_feishu_channel.scheduler.submit_task.assert_not_called()

    def test_malformed_text_json_falls_back_to_raw(self, mock_feishu_channel):
        # Invalid JSON -> uses raw content; "{bad" is non-empty so it creates a task.
        mock_feishu_channel.scheduler.submit_task.return_value = 1
        mock_feishu_channel.db.get_task.return_value = {"image_paths": [], "prompt_images": []}
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
        ):
            mock_feishu_channel._handle_inbound(_make_event(content="{bad"))
        mock_feishu_channel.scheduler.submit_task.assert_called_once()

    def test_post_message_extracts_text(self, mock_feishu_channel):
        post = json.dumps(
            {
                "zh_cn": {
                    "title": "标题",
                    "content": [[{"tag": "text", "text": "正文内容"}]],
                }
            }
        )
        mock_feishu_channel.scheduler.submit_task.return_value = 7
        mock_feishu_channel.db.get_task.return_value = {"image_paths": [], "prompt_images": []}
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
        ):
            mock_feishu_channel._handle_inbound(_make_event(content=post, msg_type="post"))

        task = mock_feishu_channel.scheduler.submit_task.call_args.args[0]
        assert task.prompt == "标题\n正文内容"

    def test_post_message_with_image_default_prompt(self, mock_feishu_channel):
        post = json.dumps({"content": [[{"tag": "img", "image_key": "img_x"}]]})
        mock_feishu_channel._download_image = Mock(return_value="/tmp/pic.png")
        mock_feishu_channel.scheduler.submit_task.return_value = 8
        mock_feishu_channel.db.get_task.return_value = {"image_paths": [], "prompt_images": []}
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
            patch("builtins.open", side_effect=OSError("no file")),
        ):
            mock_feishu_channel._handle_inbound(_make_event(content=post, msg_type="post"))

        task = mock_feishu_channel.scheduler.submit_task.call_args.args[0]
        assert task.prompt == "请分析这些图片的内容"
        assert task.image_paths == ["/tmp/pic.png"]

    def test_post_message_image_download_failure(self, mock_feishu_channel):
        # img download returns None -> no image attached, default prompt, no task
        # (empty content + no images).
        post = json.dumps({"content": [[{"tag": "img", "image_key": "img_x"}]]})
        mock_feishu_channel._download_image = Mock(return_value=None)
        mock_feishu_channel.scheduler.submit_task.return_value = 8
        mock_feishu_channel.db.get_task.return_value = {"image_paths": [], "prompt_images": []}
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
        ):
            mock_feishu_channel._handle_inbound(_make_event(content=post, msg_type="post"))
        # No image and no text -> content stays empty -> ignored.
        mock_feishu_channel.scheduler.submit_task.assert_not_called()

    def test_single_image_download_failure(self, mock_feishu_channel):
        img = json.dumps({"image_key": "img_single"})
        mock_feishu_channel._download_image = Mock(return_value=None)
        mock_feishu_channel.scheduler.submit_task.return_value = 9
        mock_feishu_channel.db.get_task.return_value = {"image_paths": [], "prompt_images": []}
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
        ):
            mock_feishu_channel._handle_inbound(_make_event(content=img, msg_type="image"))
        # Still creates a task with default prompt but no image_paths.
        task = mock_feishu_channel.scheduler.submit_task.call_args.args[0]
        assert task.prompt == "请分析这张图片的内容"
        assert task.image_paths == []

    def test_post_message_malformed_json_ignored(self, mock_feishu_channel):
        mock_feishu_channel._handle_inbound(_make_event(content="{not json", msg_type="post"))
        # content becomes "" -> ignored before reaction.
        mock_feishu_channel._add_reaction.assert_not_called()
        mock_feishu_channel.scheduler.submit_task.assert_not_called()

    def test_single_image_message_downloads_and_creates_task(self, mock_feishu_channel):
        img = json.dumps({"image_key": "img_single"})
        mock_feishu_channel._download_image = Mock(return_value="/tmp/single.jpg")
        mock_feishu_channel.scheduler.submit_task.return_value = 9
        mock_feishu_channel.db.get_task.return_value = {"image_paths": [], "prompt_images": []}
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
            patch("builtins.open", side_effect=OSError("no file")),
        ):
            mock_feishu_channel._handle_inbound(_make_event(content=img, msg_type="image"))

        mock_feishu_channel._download_image.assert_called_once_with("om_msg", "img_single")
        task = mock_feishu_channel.scheduler.submit_task.call_args.args[0]
        assert task.prompt == "请分析这张图片的内容"
        assert task.image_paths == ["/tmp/single.jpg"]

    def test_single_image_message_malformed_json(self, mock_feishu_channel):
        mock_feishu_channel.scheduler.submit_task.return_value = 10
        mock_feishu_channel.db.get_task.return_value = {"image_paths": [], "prompt_images": []}
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
        ):
            mock_feishu_channel._handle_inbound(_make_event(content="{bad", msg_type="image"))
        # Falls back to default image prompt -> still creates a task.
        task = mock_feishu_channel.scheduler.submit_task.call_args.args[0]
        assert task.prompt == "请分析这张图片的内容"

    def test_forwarded_content_merged_into_prompt(self, mock_feishu_channel):
        mock_feishu_channel._extract_forwarded_content = Mock(
            return_value={"sender_name": "Bob", "images": [{"image_key": "img_fwd"}]}
        )
        mock_feishu_channel._format_forwarded_prompt = Mock(return_value="FORMATTED PROMPT")
        mock_feishu_channel._download_image = Mock(return_value="/tmp/fwd.png")
        mock_feishu_channel.scheduler.submit_task.return_value = 11
        mock_feishu_channel.db.get_task.return_value = {"image_paths": [], "prompt_images": []}
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
            patch("builtins.open", side_effect=OSError("no file")),
        ):
            mock_feishu_channel._handle_inbound(_make_event(content=_text("看看这个")))

        task = mock_feishu_channel.scheduler.submit_task.call_args.args[0]
        assert task.prompt == "FORMATTED PROMPT"
        assert "/tmp/fwd.png" in task.image_paths


# ───────────────────────── command parsing ──────────────────────────


class TestCommands:
    def test_help_command(self, mock_feishu_channel):
        from channels.feishu_channel import HELP_TEXT

        mock_feishu_channel._handle_inbound(_make_event(content=_text("/help")))
        mock_feishu_channel._send_message.assert_called_once_with("ou_sender", HELP_TEXT)
        mock_feishu_channel.scheduler.submit_task.assert_not_called()

    def test_start_command(self, mock_feishu_channel):
        from channels.feishu_channel import HELP_TEXT

        mock_feishu_channel._handle_inbound(_make_event(content=_text("/start")))
        mock_feishu_channel._send_message.assert_called_once_with("ou_sender", HELP_TEXT)

    def test_group_chat_replies_to_chat_id(self, mock_feishu_channel):
        from channels.feishu_channel import HELP_TEXT

        data = _make_event(content=_text("/help"), chat_type="group", chat_id="oc_group")
        mock_feishu_channel._handle_inbound(data)
        mock_feishu_channel._send_message.assert_called_once_with("oc_group", HELP_TEXT)

    def test_dir_command(self, mock_feishu_channel):
        with patch("channels.dir_utils.handle_dir_command", return_value="dir set") as handler:
            mock_feishu_channel._handle_inbound(_make_event(content=_text("/dir ~/proj")))
        handler.assert_called_once_with("/dir ~/proj", "feishu", mock_feishu_channel.db)
        mock_feishu_channel._send_message.assert_called_once_with("ou_sender", "dir set")
        mock_feishu_channel.scheduler.submit_task.assert_not_called()

    def test_cd_alias_command(self, mock_feishu_channel):
        with patch("channels.dir_utils.handle_dir_command", return_value=None) as handler:
            mock_feishu_channel._handle_inbound(_make_event(content=_text("/cd ~/x")))
        handler.assert_called_once()
        # reply is None -> nothing sent.
        mock_feishu_channel._send_message.assert_not_called()

    def test_agent_command(self, mock_feishu_channel):
        with patch(
            "channels.agent_utils.handle_agent_command", return_value="agent=codex"
        ) as handler:
            mock_feishu_channel._handle_inbound(_make_event(content=_text("/agent codex")))
        handler.assert_called_once_with("/agent codex", "feishu", mock_feishu_channel.db)
        mock_feishu_channel._send_message.assert_called_once_with("ou_sender", "agent=codex")

    def test_ccu_command(self, mock_feishu_channel):
        mock_feishu_channel._get_usage_stats = Mock(return_value="usage report")
        mock_feishu_channel._handle_inbound(_make_event(content=_text("/ccu 5")))
        mock_feishu_channel._get_usage_stats.assert_called_once()
        mock_feishu_channel._send_message.assert_called_once_with("ou_sender", "usage report")

    def test_status_command_found(self, mock_feishu_channel):
        mock_feishu_channel.db.get_task.return_value = {
            "status": "completed",
            "title": "My Task",
        }
        mock_feishu_channel._handle_inbound(_make_event(content=_text("/status 42")))
        mock_feishu_channel.db.get_task.assert_called_once_with(42)
        sent = mock_feishu_channel._send_message.call_args.args[1]
        assert "Task #42" in sent
        assert "completed" in sent
        assert "✅" in sent
        assert "My Task" in sent

    def test_status_command_not_found(self, mock_feishu_channel):
        mock_feishu_channel.db.get_task.return_value = None
        mock_feishu_channel._handle_inbound(_make_event(content=_text("/status 99")))
        sent = mock_feishu_channel._send_message.call_args.args[1]
        assert "❌" in sent and "#99 not found" in sent

    def test_status_command_non_numeric_is_noop(self, mock_feishu_channel):
        mock_feishu_channel._handle_inbound(_make_event(content=_text("/status abc")))
        mock_feishu_channel._send_message.assert_not_called()
        mock_feishu_channel.scheduler.submit_task.assert_not_called()

    def test_system_notification_filtered_out(self, mock_feishu_channel):
        data = _make_event(content=_text("✅ 任务完成 Task #1"))
        mock_feishu_channel._handle_inbound(data)
        # Reaction added (passes parse) but no task created and no reply.
        mock_feishu_channel._add_reaction.assert_called_once()
        mock_feishu_channel.scheduler.submit_task.assert_not_called()


# ───────────────────────── /resume command ──────────────────────────


class TestResumeCommand:
    def test_resume_success(self, mock_feishu_channel):
        mock_feishu_channel.db.get_task.side_effect = [
            {"session_id": "sess_1", "title": "Resumed"},  # initial check
            {"session_id": "sess_1", "title": "Resumed"},  # after update
        ]
        mock_feishu_channel._handle_inbound(_make_event(content=_text("/resume 5 keep going")))

        mock_feishu_channel.db.update_task.assert_called_once()
        args, kwargs = mock_feishu_channel.db.update_task.call_args
        assert args[0] == 5
        assert kwargs["status"] == "pending"
        assert kwargs["prompt"] == "keep going"
        assert mock_feishu_channel._task_origin[5] == ("ou_sender", "om_msg", "om_msg")
        mock_feishu_channel._create_reply.assert_called_once()
        mock_feishu_channel._start_streaming.assert_called_once_with(5, "om_running", "Resumed")

    def test_resume_task_without_session(self, mock_feishu_channel):
        mock_feishu_channel.db.get_task.return_value = {"session_id": None, "title": "x"}
        mock_feishu_channel._handle_inbound(_make_event(content=_text("/resume 5 continue")))
        mock_feishu_channel.db.update_task.assert_not_called()
        sent = mock_feishu_channel._send_message.call_args.args[1]
        assert "#5 not found or has no saved session" in sent

    def test_resume_invalid_syntax(self, mock_feishu_channel):
        mock_feishu_channel._handle_inbound(_make_event(content=_text("/resume 5")))
        mock_feishu_channel.db.update_task.assert_not_called()
        sent = mock_feishu_channel._send_message.call_args.args[1]
        assert "Usage:" in sent and "/resume" in sent

    def test_resume_non_numeric_id(self, mock_feishu_channel):
        mock_feishu_channel._handle_inbound(_make_event(content=_text("/resume abc hello")))
        mock_feishu_channel.db.update_task.assert_not_called()
        sent = mock_feishu_channel._send_message.call_args.args[1]
        assert "Usage:" in sent

    def test_resume_no_running_msg_skips_streaming(self, mock_feishu_channel):
        mock_feishu_channel._create_reply = Mock(return_value=None)
        mock_feishu_channel.db.get_task.return_value = {
            "session_id": "sess",
            "title": "T",
        }
        mock_feishu_channel._handle_inbound(_make_event(content=_text("/resume 3 go")))
        mock_feishu_channel._start_streaming.assert_not_called()


# ────────────────────── resume-by-reply in thread ───────────────────


class TestThreadResume:
    def test_thread_reply_resumes_via_notification_map(self, mock_feishu_channel):
        mock_feishu_channel._notification_map["om_parent"] = 12
        mock_feishu_channel.db.get_task.return_value = {
            "session_id": "sess",
            "title": "Threaded",
        }
        data = _make_event(content=_text("继续"), parent_id="om_parent")
        mock_feishu_channel._handle_inbound(data)

        mock_feishu_channel.db.update_task.assert_called_once()
        args, kwargs = mock_feishu_channel.db.update_task.call_args
        assert args[0] == 12
        assert kwargs["prompt"] == "继续"
        # thread_root is parent_id (no root_id) -> create_reply parent + origin.
        assert mock_feishu_channel._task_origin[12] == ("ou_sender", "om_parent", "om_msg")
        mock_feishu_channel._start_streaming.assert_called_once()
        # Must NOT also create a brand new task.
        mock_feishu_channel.scheduler.submit_task.assert_not_called()

    def test_thread_reply_resumes_via_root_msg_map(self, mock_feishu_channel):
        mock_feishu_channel._root_msg_map["om_root"] = 20
        mock_feishu_channel.db.get_task.return_value = {
            "session_id": "sess",
            "title": "RootTask",
        }
        data = _make_event(content=_text("more"), root_id="om_root")
        mock_feishu_channel._handle_inbound(data)
        assert mock_feishu_channel.db.update_task.call_args.args[0] == 20
        mock_feishu_channel.scheduler.submit_task.assert_not_called()

    def test_thread_reply_recovers_task_from_db(self, mock_feishu_channel):
        mock_feishu_channel.db.get_task_by_feishu_root_msg.return_value = {"id": 33}
        mock_feishu_channel.db.get_task.return_value = {
            "session_id": "sess",
            "title": "DBTask",
        }
        data = _make_event(content=_text("again"), root_id="om_db_root")
        mock_feishu_channel._handle_inbound(data)

        mock_feishu_channel.db.get_task_by_feishu_root_msg.assert_called_with("om_db_root")
        assert mock_feishu_channel.db.update_task.call_args.args[0] == 33

    def test_thread_reply_task_without_session_replies_error(self, mock_feishu_channel):
        mock_feishu_channel._notification_map["om_parent"] = 14
        mock_feishu_channel.db.get_task.return_value = {"session_id": None}
        data = _make_event(content=_text("继续"), parent_id="om_parent")
        mock_feishu_channel._handle_inbound(data)

        mock_feishu_channel.db.update_task.assert_not_called()
        mock_feishu_channel._reply_message.assert_called_once()
        msg = mock_feishu_channel._reply_message.call_args.args[1]
        assert "#14 not found or has no saved session" in msg
        mock_feishu_channel.scheduler.submit_task.assert_not_called()

    def test_thread_reply_no_match_creates_new_task(self, mock_feishu_channel):
        # No mapping anywhere and DB lookup returns None -> falls through to create.
        mock_feishu_channel.db.get_task_by_feishu_root_msg.return_value = None
        mock_feishu_channel.scheduler.submit_task.return_value = 50
        mock_feishu_channel.db.get_task.return_value = {
            "image_paths": [],
            "prompt_images": [],
        }
        data = _make_event(content=_text("new in thread"), parent_id="om_unknown")
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
        ):
            mock_feishu_channel._handle_inbound(data)
        mock_feishu_channel.scheduler.submit_task.assert_called_once()


# ─────────────────────── plain task creation ────────────────────────


class TestTaskCreation:
    def test_plain_message_creates_task_with_expected_fields(self, mock_feishu_channel):
        mock_feishu_channel.scheduler.submit_task.return_value = 77
        mock_feishu_channel.db.get_task.return_value = {
            "image_paths": [],
            "prompt_images": [],
        }
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/Users/x/proj") as rwd,
            patch("channels.agent_utils.resolve_agent", return_value="codex") as ra,
        ):
            mock_feishu_channel._handle_inbound(_make_event(content=_text("修复登录 bug")))

        rwd.assert_called_once_with("修复登录 bug", "feishu", mock_feishu_channel.db)
        ra.assert_called_once_with("feishu", mock_feishu_channel.db)

        task = mock_feishu_channel.scheduler.submit_task.call_args.args[0]
        assert task.prompt == "修复登录 bug"
        assert task.working_dir == "/Users/x/proj"
        assert task.agent == "codex"
        assert task.tags == "feishu"
        assert task.title == "[Feishu] 修复登录 bug"
        assert task.feishu_root_msg_id == "om_msg"

        # Reaction acknowledged, streaming started, origin + root maps tracked.
        mock_feishu_channel._add_reaction.assert_called_once_with("om_msg", "OK")
        assert mock_feishu_channel._task_origin[77] == ("ou_sender", "om_msg", "om_msg")
        assert mock_feishu_channel._root_msg_map["om_msg"] == 77
        mock_feishu_channel._start_streaming.assert_called_once_with(
            77, "om_running", "[Feishu] 修复登录 bug"
        )

    def test_long_title_is_truncated_with_ellipsis(self, mock_feishu_channel):
        long_text = "x" * 80
        mock_feishu_channel.scheduler.submit_task.return_value = 1
        mock_feishu_channel.db.get_task.return_value = {
            "image_paths": [],
            "prompt_images": [],
        }
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
        ):
            mock_feishu_channel._handle_inbound(_make_event(content=_text(long_text)))
        task = mock_feishu_channel.scheduler.submit_task.call_args.args[0]
        assert task.title == "[Feishu] " + "x" * 60 + "…"

    def test_sender_without_sender_id_uses_unknown(self, mock_feishu_channel):
        mock_feishu_channel.scheduler.submit_task.return_value = 2
        mock_feishu_channel.db.get_task.return_value = {
            "image_paths": [],
            "prompt_images": [],
        }
        data = _make_event(content=_text("hello"), open_id=None)
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
        ):
            mock_feishu_channel._handle_inbound(data)
        # p2p reply_to falls back to "unknown" sender id.
        assert mock_feishu_channel._task_origin[2][0] == "unknown"

    def test_image_converted_to_prompt_images(self, mock_feishu_channel, tmp_path):
        img_file = tmp_path / "pic.png"
        img_file.write_bytes(b"\x89PNG\r\n\x1a\nfake")
        post = json.dumps({"content": [[{"tag": "img", "image_key": "k"}]]})
        mock_feishu_channel._download_image = Mock(return_value=str(img_file))
        mock_feishu_channel.scheduler.submit_task.return_value = 3
        mock_feishu_channel.db.get_task.return_value = {
            "image_paths": [str(img_file)],
            "prompt_images": [{}],
        }
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
        ):
            mock_feishu_channel._handle_inbound(_make_event(content=post, msg_type="post"))

        task = mock_feishu_channel.scheduler.submit_task.call_args.args[0]
        assert task.image_paths == [str(img_file)]
        assert len(task.prompt_images) == 1
        assert task.prompt_images[0]["media_type"] == "image/png"
        assert task.prompt_images[0]["name"] == "pic.png"

    def test_no_running_msg_skips_streaming_on_create(self, mock_feishu_channel):
        mock_feishu_channel._create_reply = Mock(return_value=None)
        mock_feishu_channel.scheduler.submit_task.return_value = 4
        mock_feishu_channel.db.get_task.return_value = {
            "image_paths": [],
            "prompt_images": [],
        }
        with (
            patch("channels.dir_utils.resolve_working_dir", return_value="/tmp"),
            patch("channels.agent_utils.resolve_agent", return_value="claude"),
        ):
            mock_feishu_channel._handle_inbound(_make_event(content=_text("hi")))
        mock_feishu_channel._start_streaming.assert_not_called()
        # Task still created and tracked.
        assert mock_feishu_channel._root_msg_map["om_msg"] == 4


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
