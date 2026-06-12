"""
Tests for Feishu channel lifecycle, image upload/download, stream-writer
plumbing, and forwarded-content helper branches not covered elsewhere.

These complement (and intentionally do not duplicate) the assertions in
tests/test_feishu_message_rendering.py and tests/test_feishu_forwarded_messages.py.
"""

import asyncio
import json
import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest


@pytest.fixture
def channel():
    """A FeishuChannel with mocked bus/db/scheduler and a mocked lark client."""
    with patch("channels.feishu_channel.FEISHU_AVAILABLE", True):
        from channels.feishu_channel import FeishuChannel

        ch = FeishuChannel(Mock(), Mock(), Mock())
        ch._client = Mock()
        return ch


def _writer(channel, task_id=12, msg_id="om_msg", title="Streaming task"):
    from channels.feishu_channel import _FeishuStreamWriter

    return _FeishuStreamWriter(task_id, msg_id, channel, title)


# ── lifecycle: start / stop / _run_ws ───────────────────────────────


class TestLifecycle:
    def test_start_not_configured_does_not_build_client(self):
        with patch("channels.feishu_channel.FEISHU_AVAILABLE", True):
            from channels.feishu_channel import FeishuChannel

            ch = FeishuChannel(Mock(), Mock(), Mock())
            ch.db.get_setting.return_value = ""  # no app_id / secret

            ch.start()

            assert ch._client is None
            assert ch._ws_client is None
            assert ch._ws_thread is None

    def test_start_unavailable_short_circuits(self):
        with patch("channels.feishu_channel.FEISHU_AVAILABLE", False):
            from channels.feishu_channel import FeishuChannel

            ch = FeishuChannel(Mock(), Mock(), Mock())
            ch.start()
            assert ch._ws_client is None

    def test_start_wires_handlers_and_spawns_thread_without_connecting(self):
        with patch("channels.feishu_channel.FEISHU_AVAILABLE", True):
            from channels.feishu_channel import FeishuChannel

            ch = FeishuChannel(Mock(), Mock(), Mock())
            ch.db.get_setting.side_effect = lambda key: {
                "feishu_app_id": "cli_app_id_value",
                "feishu_app_secret": "secret_value",
            }.get(key, "")

            fake_lark = Mock()
            built_client = Mock()
            fake_lark.Client.builder.return_value.app_id.return_value.app_secret.return_value.log_level.return_value.build.return_value = built_client
            # The event dispatcher builder must return itself for each register call.
            dispatcher_builder = fake_lark.EventDispatcherHandler.builder.return_value
            for name in (
                "register_p2_im_message_receive_v1",
                "register_p2_im_chat_member_bot_added_v1",
                "register_p2_im_message_reaction_created_v1",
                "register_p2_im_message_reaction_deleted_v1",
                "register_p2_im_message_message_read_v1",
                "register_p2_im_message_recalled_v1",
            ):
                getattr(dispatcher_builder, name).return_value = dispatcher_builder
            built_handler = Mock()
            dispatcher_builder.build.return_value = built_handler
            ws_client = Mock()
            fake_lark.ws.Client.return_value = ws_client

            started_threads = []

            class _FakeThread:
                def __init__(self, target=None, daemon=None):
                    self._target = target
                    self.daemon = daemon
                    self.started = False

                def start(self):
                    self.started = True
                    started_threads.append(self)

            with (
                patch("channels.feishu_channel.lark", fake_lark),
                patch("channels.feishu_channel.threading.Thread", _FakeThread),
            ):
                ch.start()

            # client + ws client built, but no real ws_client.start() invoked
            assert ch._client is built_client
            assert ch._ws_client is ws_client
            assert ch._running is True
            # event handlers registered
            for name in (
                "register_p2_im_message_receive_v1",
                "register_p2_im_chat_member_bot_added_v1",
                "register_p2_im_message_reaction_created_v1",
                "register_p2_im_message_reaction_deleted_v1",
            ):
                getattr(dispatcher_builder, name).assert_called_once()
            # ws client constructed with credentials + handler
            _, kwargs = fake_lark.ws.Client.call_args
            assert kwargs["event_handler"] is built_handler
            # the ws thread was spawned (but never connected)
            assert len(started_threads) == 1
            assert started_threads[0].started is True
            ws_client.start.assert_not_called()

    def test_start_registers_readonly_event_noops(self):
        """message_read / recalled receipts must have (no-op) processors, else
        the lark SDK logs 'processor not found, type: im.message.message_read_v1'
        on every read receipt.
        """
        with patch("channels.feishu_channel.FEISHU_AVAILABLE", True):
            from channels.feishu_channel import FeishuChannel

            ch = FeishuChannel(Mock(), Mock(), Mock())
            ch.db.get_setting.side_effect = lambda key: {
                "feishu_app_id": "cli_app_id_value",
                "feishu_app_secret": "secret_value",
            }.get(key, "")

            fake_lark = Mock()
            built_client = Mock()
            fake_lark.Client.builder.return_value.app_id.return_value.app_secret.return_value.log_level.return_value.build.return_value = built_client
            dispatcher_builder = fake_lark.EventDispatcherHandler.builder.return_value
            # every register call returns the builder so the fluent chain holds
            for name in (
                "register_p2_im_message_receive_v1",
                "register_p2_im_chat_member_bot_added_v1",
                "register_p2_im_message_reaction_created_v1",
                "register_p2_im_message_reaction_deleted_v1",
                "register_p2_im_message_message_read_v1",
                "register_p2_im_message_recalled_v1",
            ):
                getattr(dispatcher_builder, name).return_value = dispatcher_builder
            dispatcher_builder.build.return_value = Mock()
            fake_lark.ws.Client.return_value = Mock()

            with (
                patch("channels.feishu_channel.lark", fake_lark),
                patch("channels.feishu_channel.threading.Thread", Mock()),
            ):
                ch.start()

            dispatcher_builder.register_p2_im_message_message_read_v1.assert_called_once()
            dispatcher_builder.register_p2_im_message_recalled_v1.assert_called_once()

    def test_start_disables_lark_logger_propagation(self):
        """The lark SDK's 'Lark' logger has its own handler; if it also
        propagates to the root logger (basicConfig) every line prints twice.
        start() must turn propagation off.
        """
        import logging

        logging.getLogger("Lark").propagate = True  # reset global state

        with patch("channels.feishu_channel.FEISHU_AVAILABLE", True):
            from channels.feishu_channel import FeishuChannel

            ch = FeishuChannel(Mock(), Mock(), Mock())
            ch.db.get_setting.side_effect = lambda key: {
                "feishu_app_id": "cli_app_id_value",
                "feishu_app_secret": "secret_value",
            }.get(key, "")

            fake_lark = Mock()
            with (
                patch("channels.feishu_channel.lark", fake_lark),
                patch("channels.feishu_channel.threading.Thread", Mock()),
            ):
                ch.start()

            assert logging.getLogger("Lark").propagate is False

    def test_start_handles_build_exception(self):
        with patch("channels.feishu_channel.FEISHU_AVAILABLE", True):
            from channels.feishu_channel import FeishuChannel

            ch = FeishuChannel(Mock(), Mock(), Mock())
            ch.db.get_setting.side_effect = lambda key: {
                "feishu_app_id": "cli_app_id_value",
                "feishu_app_secret": "secret_value",
            }.get(key, "")

            fake_lark = Mock()
            fake_lark.Client.builder.side_effect = RuntimeError("boom")

            with patch("channels.feishu_channel.lark", fake_lark):
                # Must not raise — exception is caught and logged.
                ch.start()

            assert ch._ws_client is None

    def test_stop_tears_down_cleanly(self, channel):
        ws_client = Mock()
        channel._ws_client = ws_client
        channel._running = True

        channel.stop()

        assert channel._running is False
        channel.bus.unsubscribe_outbound.assert_called_once_with(channel._on_outbound)
        ws_client.stop.assert_called_once()
        assert channel._client is None
        assert channel._ws_client is None

    def test_stop_without_ws_client_is_safe(self, channel):
        channel._ws_client = None
        channel._running = True
        channel.stop()
        assert channel._running is False
        assert channel._ws_client is None

    def test_stop_swallows_ws_stop_error(self, channel):
        ws_client = Mock()
        ws_client.stop.side_effect = RuntimeError("already closed")
        channel._ws_client = ws_client
        channel.stop()
        assert channel._ws_client is None

    def test_run_ws_calls_start_and_swallows_errors(self, channel):
        ws_client = Mock()
        channel._ws_client = ws_client
        channel._running = True
        channel._run_ws()
        ws_client.start.assert_called_once()

    def test_run_ws_handles_start_exception(self, channel):
        ws_client = Mock()
        ws_client.start.side_effect = RuntimeError("connection refused")
        channel._ws_client = ws_client
        channel._running = True
        # Must not propagate.
        channel._run_ws()
        ws_client.start.assert_called_once()

    def test_run_ws_suppresses_expected_stop_exception(self, channel):
        def _start():
            channel._running = False
            raise RuntimeError("Event loop stopped before Future completed.")

        ws_client = Mock()
        ws_client.start.side_effect = _start
        channel._ws_client = ws_client
        channel._running = True

        with patch("traceback.print_exc") as print_exc:
            channel._run_ws()

        ws_client.start.assert_called_once()
        print_exc.assert_not_called()

    def test_run_ws_installs_private_sdk_loop(self, channel):
        old_loop = asyncio.new_event_loop()
        fake_ws_module = SimpleNamespace(loop=old_loop)
        captured = {}

        class _WsClient:
            def start(self):
                captured["loop"] = fake_ws_module.loop
                assert asyncio.get_event_loop() is fake_ws_module.loop

        channel._ws_client = _WsClient()
        channel._running = True
        with patch("channels.feishu_channel.lark_ws_client", fake_ws_module, create=True):
            channel._run_ws()

        assert captured["loop"] is not old_loop
        assert captured["loop"].is_closed()
        assert channel._ws_loop is None
        old_loop.close()

    def test_stop_stops_sdk_loop_without_stop_method(self, channel):
        loop = asyncio.new_event_loop()

        class _WsClientWithoutStop:
            def __init__(self):
                self.disconnected = False

            async def _disconnect(self):
                self.disconnected = True

        ws_client = _WsClientWithoutStop()

        def _run_loop():
            asyncio.set_event_loop(loop)
            loop.run_forever()

        thread = threading.Thread(target=_run_loop, daemon=True)
        thread.start()
        channel._ws_client = ws_client
        channel._ws_loop = loop
        channel._ws_thread = thread
        channel._running = True

        try:
            channel.stop()

            assert ws_client.disconnected is True
            assert thread.is_alive() is False
            assert channel._client is None
            assert channel._ws_client is None
            assert channel._ws_loop is None
        finally:
            if thread.is_alive():
                loop.call_soon_threadsafe(loop.stop)
                thread.join(timeout=2)
            if not loop.is_closed():
                loop.close()


# ── _FeishuStreamWriter plumbing ────────────────────────────────────


class TestStreamWriterPlumbing:
    def test_schedule_marks_dirty_and_starts_when_interval_elapsed(self, channel):
        writer = _writer(channel)
        writer._start_patch_locked = Mock()
        writer._last_patch = 0.0  # long ago -> delay <= 0

        writer._schedule()

        assert writer._dirty is True
        writer._start_patch_locked.assert_called_once()

    def test_schedule_noop_when_stopped(self, channel):
        writer = _writer(channel)
        writer._start_patch_locked = Mock()
        writer._stopped = True

        writer._schedule()

        assert writer._dirty is False
        writer._start_patch_locked.assert_not_called()

    def test_schedule_dirty_locked_starts_timer_when_throttled(self, channel):
        writer = _writer(channel)
        writer._dirty = True
        writer._last_patch = time.time()  # just patched -> must wait

        timers = []

        class _FakeTimer:
            def __init__(self, delay, fn):
                self.delay = delay
                self.fn = fn
                self.daemon = False
                self.started = False
                timers.append(self)

            def start(self):
                self.started = True

            def cancel(self):
                pass

        with patch("channels.feishu_channel.threading.Timer", _FakeTimer):
            writer._schedule_dirty_locked()

        assert len(timers) == 1
        assert timers[0].delay > 0
        assert timers[0].started is True
        assert writer._timer is timers[0]

    def test_schedule_dirty_locked_noop_when_patch_in_flight(self, channel):
        writer = _writer(channel)
        writer._dirty = True
        writer._patch_in_flight = True
        writer._start_patch_locked = Mock()

        writer._schedule_dirty_locked()

        writer._start_patch_locked.assert_not_called()
        assert writer._timer is None

    def test_start_patch_locked_clears_dirty_and_spawns_thread(self, channel):
        writer = _writer(channel)
        writer._dirty = True

        spawned = []

        class _FakeThread:
            def __init__(self, target=None, daemon=None):
                self.target = target
                self.daemon = daemon

            def start(self):
                spawned.append(self.target)

        with patch("channels.feishu_channel.threading.Thread", _FakeThread):
            writer._start_patch_locked()

        assert writer._patch_in_flight is True
        assert writer._dirty is False
        assert spawned == [writer._do_patch]

    def test_timer_fired_reschedules(self, channel):
        writer = _writer(channel)
        writer._timer = Mock()
        writer._dirty = True
        writer._schedule_dirty_locked = Mock()

        writer._timer_fired()

        assert writer._timer is None
        writer._schedule_dirty_locked.assert_called_once()

    def test_do_patch_builds_card_and_patches_then_reschedules(self, channel):
        writer = _writer(channel)
        with writer._parts_lock:
            writer._parts.append("hello world")
        channel._build_streaming_card = Mock(return_value={"card": True})
        channel._patch_message = Mock()
        writer._schedule_dirty_locked = Mock()

        writer._do_patch()

        channel._build_streaming_card.assert_called_once_with(
            writer.task_id, writer._task_title, "hello world"
        )
        channel._patch_message.assert_called_once_with(writer.msg_id, {"card": True})
        assert writer._patch_in_flight is False
        writer._schedule_dirty_locked.assert_called_once()

    def test_do_patch_clears_in_flight_even_when_patch_raises(self, channel):
        writer = _writer(channel)
        channel._build_streaming_card = Mock(return_value={"card": True})
        channel._patch_message = Mock(side_effect=RuntimeError("patch failed"))
        writer._patch_in_flight = True

        with pytest.raises(RuntimeError):
            writer._do_patch()

        # finally-block still ran
        assert writer._patch_in_flight is False

    def test_snapshot_text_joins_parts(self, channel):
        writer = _writer(channel)
        with writer._parts_lock:
            writer._parts.extend(["a", "b", "c"])
        assert writer.snapshot_text() == "abc"

    def test_stop_marks_stopped_and_cancels_timer(self, channel):
        writer = _writer(channel)
        timer = Mock()
        writer._timer = timer

        writer.stop()

        assert writer._stopped is True
        timer.cancel.assert_called_once()
        assert writer._timer is None

    def test_schedule_coalesces_while_in_flight(self, channel):
        writer = _writer(channel)
        writer._start_patch_locked = Mock()
        with writer._state_lock:
            writer._patch_in_flight = True

        writer._schedule()

        # Patch already running -> just mark dirty, don't start another.
        assert writer._dirty is True
        writer._start_patch_locked.assert_not_called()


# ── image path collection / canonicalization ────────────────────────


class TestImagePathHelpers:
    def test_generated_image_paths_for_task_filters_missing(self, channel, tmp_path):
        real = tmp_path / "a.png"
        real.write_bytes(b"\x89PNG\r\n\x1a\nx")
        channel.db.get_task_runs.return_value = [{"id": 5}]
        channel.db.get_run_output_events.return_value = [
            {"event_type": "generated_image", "content": json.dumps({"path": str(real)})},
            {"event_type": "generated_image", "content": json.dumps({"path": str(real)})},  # dup
            {
                "event_type": "generated_image",
                "content": json.dumps({"path": str(tmp_path / "missing.png")}),
            },
            {"event_type": "other", "content": "{}"},
            {"event_type": "generated_image", "content": "{not json"},
        ]

        paths = channel._generated_image_paths_for_task(7)

        assert paths == [str(real)]

    def test_generated_image_paths_for_task_no_runs(self, channel):
        channel.db.get_task_runs.return_value = []
        assert channel._generated_image_paths_for_task(7) == []

    def test_generated_image_paths_for_task_run_load_error(self, channel):
        channel.db.get_task_runs.side_effect = RuntimeError("db down")
        assert channel._generated_image_paths_for_task(7) == []

    def test_generated_image_paths_for_task_events_error(self, channel):
        channel.db.get_task_runs.return_value = [{"id": 5}]
        channel.db.get_run_output_events.side_effect = RuntimeError("db down")
        assert channel._generated_image_paths_for_task(7) == []

    def test_collect_generated_image_paths_merges_and_dedupes(self, channel, tmp_path):
        img = tmp_path / "shared.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\nx")
        channel.db.get_task_runs.return_value = [{"id": 1}]
        channel.db.get_run_output_events.return_value = [
            {"event_type": "generated_image", "content": json.dumps({"path": str(img)})},
        ]
        content = f"see ![pic]({img})"

        result = channel._collect_generated_image_paths(7, content, task={"working_dir": None})

        # Same file referenced twice -> deduped to one canonical path.
        assert result == [str(img.resolve())]

    def test_generated_image_paths_from_markdown_relative_to_working_dir(self, channel, tmp_path):
        img = tmp_path / "rel.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\nx")
        content = "here is ![alt](rel.png)"

        paths = channel._generated_image_paths_from_markdown(content, working_dir=str(tmp_path))

        assert paths == [str(img.resolve())]

    def test_local_image_path_from_reference_skips_remote(self, channel):
        assert channel._local_image_path_from_reference("https://x/y.png") is None
        assert channel._local_image_path_from_reference("data:image/png;base64,AAAA") is None

    def test_local_image_path_from_reference_file_uri(self, channel, tmp_path):
        img = tmp_path / "f.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\nx")
        ref = f"file://{img}"
        assert channel._local_image_path_from_reference(ref) == str(img.resolve())

    def test_local_image_path_from_reference_sandbox_prefix(self, channel, tmp_path):
        img = tmp_path / "s.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\nx")
        ref = f"sandbox:{img}"
        assert channel._local_image_path_from_reference(ref) == str(img.resolve())

    def test_local_image_path_from_reference_rejects_non_image_suffix(self, channel, tmp_path):
        txt = tmp_path / "note.txt"
        txt.write_text("hi")
        assert channel._local_image_path_from_reference(str(txt)) is None

    def test_local_image_path_from_reference_missing_file(self, channel, tmp_path):
        assert channel._local_image_path_from_reference(str(tmp_path / "nope.png")) is None

    def test_markdown_image_reference_target_angle_brackets(self, channel):
        assert channel._markdown_image_reference_target("<a b.png>") == "a b.png"

    def test_markdown_image_reference_target_quoted(self, channel):
        assert channel._markdown_image_reference_target("'quoted.png'") == "quoted.png"

    def test_markdown_image_reference_target_with_title(self, channel):
        assert channel._markdown_image_reference_target('pic.png "a title"') == "pic.png"

    def test_markdown_image_reference_target_empty(self, channel):
        assert channel._markdown_image_reference_target("  ") == ""

    def test_dedupe_image_paths_drops_missing_and_dups(self, channel, tmp_path):
        a = tmp_path / "a.png"
        a.write_bytes(b"x")
        paths = [str(a), str(a), str(tmp_path / "ghost.png")]
        assert channel._dedupe_image_paths(paths) == [str(a.resolve())]

    def test_canonical_image_path_resolves(self, channel, tmp_path):
        a = tmp_path / "a.png"
        a.write_bytes(b"x")
        assert channel._canonical_image_path(str(a)) == str(a.resolve())

    def test_canonical_image_path_missing(self, channel, tmp_path):
        assert channel._canonical_image_path(str(tmp_path / "no.png")) is None


# ── image upload ────────────────────────────────────────────────────


class TestImageUpload:
    def _ok_response(self, image_key="img_v2_ok"):
        response = Mock()
        response.success.return_value = True
        response.data.image_key = image_key
        return response

    def test_upload_image_success(self, channel, tmp_path):
        img = tmp_path / "u.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\nx")
        channel._client.im.v1.image.create.return_value = self._ok_response("img_v2_xyz")

        key = channel._upload_image(str(img))

        assert key == "img_v2_xyz"
        channel._client.im.v1.image.create.assert_called_once()

    def test_upload_image_api_failure(self, channel, tmp_path):
        img = tmp_path / "u.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\nx")
        response = Mock()
        response.success.return_value = False
        response.code = 1234
        response.msg = "nope"
        channel._client.im.v1.image.create.return_value = response

        assert channel._upload_image(str(img)) is None

    def test_upload_image_exception(self, channel, tmp_path):
        img = tmp_path / "u.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\nx")
        channel._client.im.v1.image.create.side_effect = RuntimeError("boom")
        assert channel._upload_image(str(img)) is None

    def test_upload_image_no_client(self, channel, tmp_path):
        img = tmp_path / "u.png"
        img.write_bytes(b"x")
        channel._client = None
        assert channel._upload_image(str(img)) is None

    def test_upload_image_entries_skips_failures(self, channel, tmp_path):
        a = tmp_path / "a.png"
        b = tmp_path / "b.png"
        a.write_bytes(b"\x89PNG\r\n\x1a\na")
        b.write_bytes(b"\x89PNG\r\n\x1a\nb")
        channel._upload_image = Mock(side_effect=["img_a", None])

        entries = channel._upload_image_entries([str(a), str(b)])

        assert entries == [(str(a), "img_a")]

    def test_upload_images_returns_keys(self, channel):
        channel._upload_image_entries = Mock(
            return_value=[("/a.png", "img_a"), ("/b.png", "img_b")]
        )
        assert channel._upload_images(["/a.png", "/b.png"]) == ["img_a", "img_b"]


# ── hiding generated image references ───────────────────────────────


class TestHideGeneratedImagePaths:
    def test_hide_removes_uploaded_path_line(self, channel, tmp_path):
        img = tmp_path / "g.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\nx")
        canonical = str(img.resolve())
        content = f"结果如下\n- {canonical}\n收工"

        cleaned = channel._hide_generated_image_paths(
            content, image_count=1, uploaded_paths=[canonical]
        )

        assert canonical not in cleaned
        assert "结果如下" in cleaned
        assert "收工" in cleaned

    def test_hide_removes_codex_generated_lines(self, channel):
        content = "ok\n- /home/u/.codex/generated_images/t/a.png"
        cleaned = channel._hide_generated_image_paths(content, image_count=1)
        assert "/.codex/generated_images/" not in cleaned
        assert "ok" in cleaned

    def test_hide_falls_back_when_nothing_visible(self, channel):
        content = "- /home/u/.codex/generated_images/t/a.png"
        cleaned = channel._hide_generated_image_paths(content, image_count=3)
        assert cleaned == "已生成 3 张图片。"

    def test_hide_collapses_already_generated_header(self, channel):
        content = "已生成 2 张图片：\n- whatever"
        cleaned = channel._hide_generated_image_paths(content, image_count=2)
        assert cleaned == "已生成 2 张图片。"

    def test_hide_strips_bare_list_marker_lines(self, channel, tmp_path):
        img = tmp_path / "h.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\nx")
        canonical = str(img.resolve())
        content = f"intro\n- ![pic]({canonical})"

        cleaned = channel._hide_generated_image_paths(
            content, image_count=1, uploaded_paths=[canonical]
        )

        # The markdown ref is removed, leaving only "intro" (the bare "-" dropped).
        assert cleaned == "intro"

    def test_line_is_uploaded_image_path_true_for_canonical(self, channel, tmp_path):
        img = tmp_path / "p.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\nx")
        canonical = str(img.resolve())
        assert channel._line_is_uploaded_image_path(f"- {canonical}", {canonical}) is True

    def test_line_is_uploaded_image_path_codex_match(self, channel):
        assert (
            channel._line_is_uploaded_image_path("- /x/.codex/generated_images/y/z.png", set())
            is True
        )

    def test_line_is_uploaded_image_path_non_list(self, channel):
        assert channel._line_is_uploaded_image_path("plain text", set()) is False

    def test_remove_uploaded_markdown_image_refs_noop_without_uploaded(self, channel):
        line = "see ![x](/a.png)"
        assert channel._remove_uploaded_markdown_image_refs(line, set()) == line

    def test_remove_uploaded_markdown_image_refs_strips_matching(self, channel, tmp_path):
        img = tmp_path / "m.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\nx")
        canonical = str(img.resolve())
        line = f"before ![pic]({canonical}) after"
        out = channel._remove_uploaded_markdown_image_refs(line, {canonical})
        assert "![pic]" not in out
        assert "before" in out and "after" in out


# ── image download ──────────────────────────────────────────────────


class TestDownloadImage:
    def _resp(self, raw_bytes, success=True, code=0, msg="ok"):
        response = Mock()
        response.success.return_value = success
        response.code = code
        response.msg = msg
        response.raw.content = raw_bytes
        return response

    def test_download_image_writes_png(self, channel, tmp_path):
        channel._client.im.v1.message_resource.get.return_value = self._resp(
            b"\x89PNG\r\n\x1a\nbody"
        )
        with patch("channels.feishu_channel.Path.home", return_value=tmp_path):
            path = channel._download_image("msg_1", "img_key_1")

        assert path is not None
        assert path.endswith("img_key_1.png")
        with open(path, "rb") as f:
            assert f.read() == b"\x89PNG\r\n\x1a\nbody"

    def test_download_image_detects_jpg(self, channel, tmp_path):
        channel._client.im.v1.message_resource.get.return_value = self._resp(b"\xff\xd8\xff\xe0jpg")
        with patch("channels.feishu_channel.Path.home", return_value=tmp_path):
            path = channel._download_image("msg_1", "jpg_key")
        assert path.endswith("jpg_key.jpg")

    def test_download_image_unknown_defaults_jpg(self, channel, tmp_path):
        channel._client.im.v1.message_resource.get.return_value = self._resp(b"random-bytes")
        with patch("channels.feishu_channel.Path.home", return_value=tmp_path):
            path = channel._download_image("msg_1", "unk_key")
        assert path.endswith("unk_key.jpg")

    def test_download_image_api_failure(self, channel, tmp_path):
        channel._client.im.v1.message_resource.get.return_value = self._resp(
            b"", success=False, code=99, msg="denied"
        )
        with patch("channels.feishu_channel.Path.home", return_value=tmp_path):
            assert channel._download_image("msg_1", "bad_key") is None

    def test_download_image_exception(self, channel, tmp_path):
        channel._client.im.v1.message_resource.get.side_effect = RuntimeError("net")
        with patch("channels.feishu_channel.Path.home", return_value=tmp_path):
            assert channel._download_image("msg_1", "err_key") is None

    def test_download_image_no_client(self, channel):
        channel._client = None
        assert channel._download_image("msg_1", "k") is None


# ── forwarded-content helper branches not covered elsewhere ─────────


class TestForwardedExtraBranches:
    def test_extract_forwarded_post_lang_body_list(self, channel):
        # post content where the top-level value is itself a list of paragraphs
        # (no content/zh_cn/en_us keys) -> hits the next(iter(...)) fallback.
        message = Mock()
        message.message_type = "post"
        message.content = json.dumps(
            {"other": [[{"tag": "quote", "text": "引用文本", "user": {"name": "甲"}}]]}
        )

        result = channel._extract_forwarded_content(message)

        assert result["type"] == "quote"
        assert result["sender_name"] == "甲"
        assert result["text"] == "引用文本"

    def test_extract_forwarded_post_no_quote_or_nested_returns_none(self, channel):
        message = Mock()
        message.message_type = "post"
        message.content = json.dumps(
            {"zh_cn": {"content": [[{"tag": "text", "text": "just text"}]]}}
        )
        assert channel._extract_forwarded_content(message) is None

    def test_extract_forwarded_post_malformed(self, channel):
        message = Mock()
        message.message_type = "post"
        message.content = "{bad json"
        assert channel._extract_forwarded_content(message) is None

    def test_extract_forwarded_nested_message_default_sender(self, channel):
        message = Mock()
        message.message_type = "post"
        message.content = json.dumps(
            {"content": [[{"tag": "nested_message", "nested_message": {"text": "n"}}]]}
        )
        result = channel._extract_forwarded_content(message)
        assert result["type"] == "forward"
        assert result["sender_name"] == "未知用户"

    def test_format_forwarded_prompt_default_sender_name(self, channel):
        # forwarded without sender_name -> falls back to 未知用户
        forwarded = {"type": "forward", "text": "x"}
        out = channel._format_forwarded_prompt("", forwarded)
        assert "转发自: 未知用户" in out
