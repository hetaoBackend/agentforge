"""Coverage for process/server lifecycle helpers in taskboard.py.

Covers _kill_stale_process_on_port, _pid_alive, QuietHTTPServer.handle_error,
and run_server's channel-enable wiring (with serve_forever/signal/channels
patched to no-ops so nothing real spawns or blocks).
"""

import os
from unittest import mock

import taskboard

# ── _pid_alive ─────────────────────────────────────────────────────────────


def test_pid_alive_true_when_no_exception():
    with mock.patch.object(taskboard.os, "kill", return_value=None) as kill:
        assert taskboard._pid_alive(1234) is True
        kill.assert_called_once_with(1234, 0)


def test_pid_alive_false_on_oserror():
    with mock.patch.object(taskboard.os, "kill", side_effect=ProcessLookupError()):
        assert taskboard._pid_alive(1234) is False


def test_pid_alive_false_on_generic_oserror():
    with mock.patch.object(taskboard.os, "kill", side_effect=OSError()):
        assert taskboard._pid_alive(1234) is False


# ── _kill_stale_process_on_port ────────────────────────────────────────────


def _fake_free_socket():
    """A socket whose connect() refuses — i.e. the port is free."""
    sock = mock.Mock()
    sock.connect.side_effect = ConnectionRefusedError()
    return sock


def _fake_occupied_socket():
    """A socket whose connect() succeeds — i.e. the port is occupied."""
    sock = mock.Mock()
    sock.connect.return_value = None
    return sock


def test_kill_stale_returns_when_port_free():
    with mock.patch("socket.socket", return_value=_fake_free_socket()):
        with mock.patch.object(taskboard, "subprocess") as sub:
            taskboard._kill_stale_process_on_port(9712)
            sub.run.assert_not_called()


def test_kill_stale_kills_found_pid():
    occupied = _fake_occupied_socket()
    lsof_result = mock.Mock()
    lsof_result.stdout = "4242\n"

    with (
        mock.patch("socket.socket", return_value=occupied),
        mock.patch.object(taskboard.subprocess, "run", return_value=lsof_result),
        mock.patch.object(taskboard.os, "kill") as kill,
        mock.patch.object(taskboard.os, "getpid", return_value=1),
        mock.patch.object(taskboard.time, "sleep", return_value=None),
        mock.patch.object(taskboard, "_pid_alive", return_value=False),
    ):
        taskboard._kill_stale_process_on_port(9712)

    # SIGTERM was sent to the stale pid.
    kill.assert_any_call(4242, taskboard.signal.SIGTERM)


def test_kill_stale_force_kills_survivor():
    occupied = _fake_occupied_socket()
    lsof_result = mock.Mock()
    lsof_result.stdout = "4242\n"

    with (
        mock.patch("socket.socket", return_value=occupied),
        mock.patch.object(taskboard.subprocess, "run", return_value=lsof_result),
        mock.patch.object(taskboard.os, "kill") as kill,
        mock.patch.object(taskboard.os, "getpid", return_value=1),
        mock.patch.object(taskboard.time, "sleep", return_value=None),
        mock.patch.object(
            taskboard,
            "_pid_alive",
            return_value=True,  # never dies → force kill
        ),
    ):
        taskboard._kill_stale_process_on_port(9712)

    kill.assert_any_call(4242, taskboard.signal.SIGTERM)
    kill.assert_any_call(4242, taskboard.signal.SIGKILL)


def test_kill_stale_skips_self_pid():
    occupied = _fake_occupied_socket()
    lsof_result = mock.Mock()
    lsof_result.stdout = "999\n"  # equals our pid → skipped

    with (
        mock.patch("socket.socket", return_value=occupied),
        mock.patch.object(taskboard.subprocess, "run", return_value=lsof_result),
        mock.patch.object(taskboard.os, "kill") as kill,
        mock.patch.object(taskboard.os, "getpid", return_value=999),
        mock.patch.object(taskboard.time, "sleep", return_value=None),
    ):
        taskboard._kill_stale_process_on_port(9712)

    kill.assert_not_called()


def test_kill_stale_handles_empty_and_nondigit_lsof():
    occupied = _fake_occupied_socket()
    lsof_result = mock.Mock()
    lsof_result.stdout = "\nabc\n"  # nothing usable

    with (
        mock.patch("socket.socket", return_value=occupied),
        mock.patch.object(taskboard.subprocess, "run", return_value=lsof_result),
        mock.patch.object(taskboard.os, "kill") as kill,
        mock.patch.object(taskboard.os, "getpid", return_value=1),
        mock.patch.object(taskboard.time, "sleep", return_value=None),
    ):
        taskboard._kill_stale_process_on_port(9712)

    kill.assert_not_called()


def test_kill_stale_swallows_subprocess_error():
    occupied = _fake_occupied_socket()

    with (
        mock.patch("socket.socket", return_value=occupied),
        mock.patch.object(taskboard.subprocess, "run", side_effect=RuntimeError("lsof exploded")),
    ):
        # Should not raise — the except branch logs a warning.
        taskboard._kill_stale_process_on_port(9712)


# ── QuietHTTPServer.handle_error ───────────────────────────────────────────


def test_handle_error_swallows_broken_pipe():
    server = taskboard.QuietHTTPServer.__new__(taskboard.QuietHTTPServer)
    try:
        raise BrokenPipeError()
    except BrokenPipeError:
        # Must not raise and must not call super().handle_error.
        with mock.patch.object(taskboard.HTTPServer, "handle_error") as super_handle:
            server.handle_error(object(), ("127.0.0.1", 1234))
            super_handle.assert_not_called()


def test_handle_error_delegates_other_errors():
    server = taskboard.QuietHTTPServer.__new__(taskboard.QuietHTTPServer)
    try:
        raise ValueError("not a pipe")
    except ValueError:
        with mock.patch.object(taskboard.HTTPServer, "handle_error") as super_handle:
            server.handle_error(object(), ("127.0.0.1", 1234))
            super_handle.assert_called_once()


# ── run_server wiring (channels disabled by default) ───────────────────────


def test_run_server_wires_disabled_channels(tmp_path):
    """run_server with all channels off: confirms it reaches serve_forever and
    leaves every channel reference None on the handler."""

    db = taskboard.TaskDB(str(tmp_path / "t.db"))

    fake_scheduler = mock.Mock()
    fake_ui = mock.Mock()

    # Strip channel-autoenable env vars so nothing real tries to start.
    clean_env = {
        k: v
        for k, v in os.environ.items()
        if k not in {"TELEGRAM_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"}
    }

    with (
        mock.patch.dict(os.environ, clean_env, clear=True),
        mock.patch.object(taskboard, "_kill_stale_process_on_port"),
        mock.patch.object(taskboard, "TaskDB", return_value=db),
        mock.patch.object(taskboard, "UIChannel", return_value=fake_ui),
        mock.patch.object(taskboard, "TaskScheduler", return_value=fake_scheduler),
        mock.patch.object(taskboard.QuietHTTPServer, "serve_forever", return_value=None) as serve,
        mock.patch.object(taskboard.QuietHTTPServer, "server_bind", return_value=None),
        mock.patch.object(taskboard.QuietHTTPServer, "server_activate", return_value=None),
        mock.patch.object(taskboard.signal, "signal", return_value=None),
    ):
        taskboard.run_server(port=0)

    serve.assert_called_once()
    fake_ui.start.assert_called_once()
    fake_scheduler.start.assert_called_once()
    assert taskboard.TaskAPIHandler.feishu_channel is None
    assert taskboard.TaskAPIHandler.telegram_channel is None
    assert taskboard.TaskAPIHandler.slack_channel is None
    assert taskboard.TaskAPIHandler.weixin_channel is None
    assert taskboard.TaskAPIHandler.scheduler is fake_scheduler
