// Ported from tests/test_slack_more.py (bun:test).
//
// Additional Slack channel coverage. Focuses on branches not exercised by
// tests/slack-channel.test.ts:
//   - the _require_slack import guard (success + import failure)
//   - the start() / Socket Mode bootstrap (SDK fully faked, no network)
//   - _handle_socket_request error dispatch + unhandled event types
//   - mention/app_home edge branches
//   - send() default-channel fallback + reaction/reply error paths
//   - low-level helper guards (no web client, postMessage failures)

import { expect, mock, test } from "bun:test";

import {
  MessageBus,
  makeOutboundMessage,
  OutboundMessageType,
} from "../src/bus.ts";
import { _hooks as dir_hooks } from "../src/channels/dir_utils.ts";
import {
  _hooks as slack_hooks,
  _require_slack,
  SlackChannel,
} from "../src/channels/slack.ts";
import type { SlackSDK, SlackTaskDB } from "../src/channels/slack.ts";
import type { Task } from "../src/types.ts";

class StubDB implements SlackTaskDB {
  settings: Record<string, string> = {};
  tasks: Record<number, Record<string, unknown>> = {};
  updated: Array<[number, Record<string, unknown>]> = [];

  get_setting(key: string, defaultValue: string | null = null): string | null {
    return this.settings[key] ?? defaultValue;
  }

  set_setting(key: string, value: string): void {
    this.settings[key] = value;
  }

  get_task(task_id: number): Record<string, unknown> | null {
    return this.tasks[task_id] ?? null;
  }

  update_task(task_id: number, updates: Record<string, unknown>): void {
    this.updated.push([task_id, updates]);
    this.tasks[task_id] = {
      ...(this.tasks[task_id] ?? { id: task_id }),
      ...updates,
    };
  }
}

class StubScheduler {
  submitted: Task[] = [];

  submit_task(task: Task): number {
    this.submitted.push(task);
    return this.submitted.length;
  }
}

function make_web_client() {
  return {
    auth_test: mock(async () => ({}) as Record<string, unknown>),
    chat_postMessage: mock(async (_args: any) => ({ ts: "1700.0001" }) as any),
    reactions_add: mock(async (_args: any) => ({}) as any),
    conversations_open: mock(async (_args: any) => ({}) as any),
  };
}

type WebClientMock = ReturnType<typeof make_web_client>;

function _make_channel(db?: StubDB, scheduler?: StubScheduler) {
  const bus = new MessageBus();
  const the_db = db ?? new StubDB();
  const the_scheduler = scheduler ?? new StubScheduler();
  const channel = new SlackChannel(
    bus,
    the_db,
    the_scheduler,
    "xoxb-test",
    "xapp-test",
  );
  const web = make_web_client();
  channel._web_client = web;
  channel._bot_user_id = "UBOT";
  return { channel, bus, db: the_db, scheduler: the_scheduler, web };
}

function last_text(web: WebClientMock): string {
  return (web.chat_postMessage.mock.calls.at(-1)![0] as any).text;
}

async function with_resolved_dir<T>(
  value: string,
  fn: () => Promise<T>,
): Promise<T> {
  const orig = dir_hooks.extract_working_dir_with_claude;
  dir_hooks.extract_working_dir_with_claude = async () => value;
  try {
    return await fn();
  } finally {
    dir_hooks.extract_working_dir_with_claude = orig;
  }
}

function capture_logs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return {
    logs,
    restore: () => {
      console.log = orig;
    },
  };
}

async function _wait_threads(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// ── _require_slack import guard ──────────────────────────────────

test("test_require_slack_returns_sdk_symbols", async () => {
  const { WebClient, SocketModeClient } = await _require_slack();
  // The real @slack packages are installed in this environment; just confirm
  // the constructors are returned. (The TS SDK has no SocketModeResponse /
  // SocketModeRequest classes; acks go through the adapter instead.)
  expect(WebClient).toBeDefined();
  expect(SocketModeClient).toBeDefined();
});

test("test_require_slack_raises_on_missing_dependency", async () => {
  // Hide the slack SDK so the import inside _require_slack fails.
  const orig = slack_hooks.import_slack;
  slack_hooks.import_slack = async () => {
    throw new Error("Cannot find package '@slack/web-api'");
  };
  try {
    let error: Error | null = null;
    try {
      await _require_slack();
      throw new Error("expected import error");
    } catch (e) {
      error = e as Error;
    }
    expect(String(error)).toContain(
      "@slack/web-api and @slack/socket-mode are required",
    );
  } finally {
    slack_hooks.import_slack = orig;
  }
});

// ── start() Socket Mode bootstrap ────────────────────────────────

/** Build a stand-in slack SDK so start() runs without a real connection. */
function _install_fake_slack_sdk(opts: { auth_raises?: boolean } = {}) {
  class FakeWebClient {
    token: string | undefined;

    constructor(token?: string) {
      this.token = token;
    }

    async auth_test(): Promise<Record<string, unknown>> {
      if (opts.auth_raises) {
        throw new Error("bad token");
      }
      return { user_id: "UBOT99", team: "T1", user: "agentbot" };
    }
  }

  class FakeSocketModeClient {
    app_token: string | undefined;
    web_client: unknown;
    socket_mode_request_listeners: unknown[] = [];
    connected = false;

    constructor(o: { app_token?: string; web_client?: unknown }) {
      this.app_token = o.app_token;
      this.web_client = o.web_client;
    }

    connect(): void {
      // No-op: never opens a real socket, returns immediately.
      this.connected = true;
    }

    disconnect(): void {
      this.connected = false;
    }
  }

  const orig = slack_hooks.import_slack;
  slack_hooks.import_slack = async () =>
    ({
      WebClient: FakeWebClient,
      SocketModeClient: FakeSocketModeClient,
    }) as unknown as SlackSDK;
  return {
    restore: () => {
      slack_hooks.import_slack = orig;
    },
  };
}

test("test_start_bootstraps_socket_mode", async () => {
  const { restore } = _install_fake_slack_sdk();
  try {
    const channel = new SlackChannel(
      new MessageBus(),
      new StubDB(),
      new StubScheduler(),
      "xoxb-real",
      "xapp-real",
    );
    await channel.start();

    expect(channel._running).toBe(true);
    expect(channel._bot_user_id).toBe("UBOT99");
    // Connected (no real network) and our listener registered.
    expect((channel._socket_client as any).connected).toBe(true);
    expect(channel._socket_client!.socket_mode_request_listeners).toContain(
      channel._handle_socket_request,
    );
  } finally {
    restore();
  }
});

test("test_start_aborts_when_auth_test_fails", async () => {
  const { restore } = _install_fake_slack_sdk({ auth_raises: true });
  try {
    const channel = new SlackChannel(
      new MessageBus(),
      new StubDB(),
      new StubScheduler(),
      "xoxb-real",
      "xapp-real",
    );
    await channel.start();

    // auth_test failed → bootstrap returns before creating the socket client.
    expect(channel._bot_user_id).toBeNull();
    expect(channel._socket_client).toBeNull();
  } finally {
    restore();
  }
});

// ── _handle_socket_request dispatch branches ─────────────────────

test("test_socket_request_dispatches_mention", async () => {
  const { channel, scheduler } = _make_channel();
  const client = { send_socket_mode_response: mock((_resp: any) => {}) };

  const req = {
    type: "events_api",
    envelope_id: "envelope-mention-1",
    payload: {
      event: {
        type: "app_mention",
        user: "U1",
        text: "<@UBOT> do the thing",
        channel: "C1",
        ts: "1.0",
      },
    },
  };

  await with_resolved_dir("~", () =>
    channel._handle_socket_request(client, req),
  );
  expect(scheduler.submitted.length).toBe(1);
  expect(scheduler.submitted[0]!.prompt).toBe("do the thing");
});

test("test_socket_request_dispatches_app_home_opened", async () => {
  const { channel, web } = _make_channel();
  web.conversations_open.mockImplementation(async () => ({
    channel: { id: "D9" },
  }));
  const client = { send_socket_mode_response: mock((_resp: any) => {}) };

  const req = {
    type: "events_api",
    envelope_id: "envelope-home-12345",
    payload: { event: { type: "app_home_opened", user: "U2", tab: "home" } },
  };

  await channel._handle_socket_request(client, req);
  expect(last_text(web)).toContain("AgentForge Bot");
});

test("test_socket_request_unhandled_event_type", async () => {
  const { channel, scheduler } = _make_channel();
  const client = { send_socket_mode_response: mock((_resp: any) => {}) };

  const req = {
    type: "events_api",
    envelope_id: "envelope-unknown-99",
    payload: { event: { type: "reaction_added" } },
  };

  await channel._handle_socket_request(client, req);
  expect(client.send_socket_mode_response).toHaveBeenCalledTimes(1);
  expect(scheduler.submitted.length).toBe(0);
});

test("test_socket_request_swallows_handler_exception", async () => {
  const { channel } = _make_channel();
  const client = { send_socket_mode_response: mock((_resp: any) => {}) };

  const req = {
    type: "events_api",
    envelope_id: "envelope-boom-123",
    payload: { event: { type: "message", channel_type: "im" } },
  };

  // Force the message handler to blow up so the except branch runs.
  (channel as any)._handle_message_event = () => {
    throw new Error("kaboom");
  };
  await channel._handle_socket_request(client, req);
  // Ack still sent; exception is caught, not propagated.
  expect(client.send_socket_mode_response).toHaveBeenCalledTimes(1);
});

// ── message/mention strip-prefix branches ────────────────────────

test("test_mention_without_prefix_keeps_text", async () => {
  const { channel, scheduler } = _make_channel();
  // No leading "<@UBOT>" so the strip branch is skipped.
  await with_resolved_dir("~", () =>
    channel._handle_mention_event({
      user: "U1",
      text: "just build it",
      channel: "C1",
      ts: "2.0",
    }),
  );
  expect(scheduler.submitted[0]!.prompt).toBe("just build it");
});

test("test_mention_when_bot_user_id_unset", async () => {
  const { channel, scheduler } = _make_channel();
  channel._bot_user_id = null; // skip the "if self._bot_user_id" strip block
  await with_resolved_dir("~", () =>
    channel._handle_mention_event({
      user: "U1",
      text: "<@UX> hi",
      channel: "C1",
      ts: "3.0",
    }),
  );
  expect(scheduler.submitted[0]!.prompt).toBe("<@UX> hi");
});

test("test_app_home_opened_ignores_self_and_empty_user", async () => {
  const { channel, web } = _make_channel();
  await channel._handle_app_home_opened({ user: "UBOT", tab: "home" }); // self
  await channel._handle_app_home_opened({ user: "", tab: "home" }); // empty
  expect(web.chat_postMessage).not.toHaveBeenCalled();
});

test("test_app_home_opened_dm_open_fails", async () => {
  const { channel, web } = _make_channel();
  web.conversations_open.mockImplementation(async () => {
    throw new Error("nope");
  });
  const { logs, restore } = capture_logs();
  try {
    await channel._handle_app_home_opened({ user: "U7", tab: "home" });
  } finally {
    restore();
  }
  // _open_dm_channel returned null → the else branch logs a failure.
  expect(logs.join("\n")).toContain("Failed to open DM channel");
  expect(web.chat_postMessage).not.toHaveBeenCalled();
});

// ── _cmd_status error/result rendering ───────────────────────────

test("test_cmd_status_renders_error_only", async () => {
  const db = new StubDB();
  db.tasks[3] = {
    id: 3,
    title: "Broke",
    status: "failed",
    created_at: "2026-01-01",
    last_run_at: null,
    error: "stack trace here",
    result: null,
  };
  const { channel, web } = _make_channel(db);
  await channel._cmd_status("#3", "C1", "1.0");
  const text = last_text(web);
  expect(text).toContain("Error:");
  expect(text).toContain("stack trace here");
  expect(text).not.toContain("Result:");
});

// ── send() default-channel fallback message format ───────────────

test("test_send_default_channel_failure_prefixes_x_emoji", async () => {
  const db = new StubDB();
  db.settings["slack_default_channel"] = "C-DEF";
  const { channel, web } = _make_channel(db);

  channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_FAILED,
      task_id: 21,
      payload: { title: "Job", error: "broke" },
    }),
  );
  // _send_and_track runs detached; drain it.
  await _wait_threads();

  const call = web.chat_postMessage.mock.calls.at(-1)![0] as any;
  expect(call.channel).toBe("C-DEF");
  expect(call.text).toContain(":x:");
  expect(call.text).toContain("broke");
  // The sent ts was tracked back to the task.
  expect(channel._notification_map.get("1700.0001")).toBe(21);
});

test("test_send_dm_fallback_fails_to_open_skips", async () => {
  const db = new StubDB();
  db.settings["slack_default_user"] = "U-DM";
  const { channel, web } = _make_channel(db);
  web.conversations_open.mockImplementation(async () => {
    throw new Error("denied");
  });

  const { logs, restore } = capture_logs();
  try {
    channel.send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_COMPLETED,
        task_id: 22,
        payload: { title: "Job", result: "ok" },
      }),
    );
    await _wait_threads();
  } finally {
    restore();
  }

  expect(logs.join("\n")).toContain("Failed to open DM");
  expect(web.chat_postMessage).not.toHaveBeenCalled();
});

// ── _on_outbound passthrough ─────────────────────────────────────

test("test_on_outbound_delegates_to_send", () => {
  const { channel } = _make_channel();
  const send = mock((_msg: any) => {});
  (channel as any).send = send;
  const msg = makeOutboundMessage({
    type: OutboundMessageType.TASK_STARTED,
    task_id: 1,
    payload: {},
  });
  channel._on_outbound(msg);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toBe(msg);
});

// ── helper no-web-client / failure guards ────────────────────────

test("test_open_dm_channel_returns_none_without_web_client", async () => {
  const { channel } = _make_channel();
  channel._web_client = null;
  expect(await channel._open_dm_channel("U1")).toBeNull();
});

test("test_add_reaction_noop_without_web_client", () => {
  const { channel } = _make_channel();
  channel._web_client = null;
  // Should simply return without spawning anything or throwing.
  channel._add_reaction("C1", "1.0", "eyes");
});

test("test_add_reaction_handles_already_reacted_and_errors", async () => {
  const { channel, web } = _make_channel();

  // already_reacted is swallowed silently.
  web.reactions_add.mockImplementation(async () => {
    throw new Error("already_reacted");
  });
  channel._add_reaction("C1", "1.0", "eyes");

  // other errors are logged.
  web.reactions_add.mockImplementation(async () => {
    throw new Error("rate_limited");
  });
  channel._add_reaction("C1", "1.0", "eyes");

  await _wait_threads();
  expect(web.reactions_add).toHaveBeenCalledTimes(2);
});

test("test_reply_skips_without_web_client", async () => {
  const { channel } = _make_channel();
  channel._web_client = null;
  const { logs, restore } = capture_logs();
  try {
    await channel._reply("C1", null, "hi");
  } finally {
    restore();
  }
  expect(logs.join("\n")).toContain("no web_client");
});

test("test_reply_logs_postmessage_failure", async () => {
  const { channel, web } = _make_channel();
  web.chat_postMessage.mockImplementation(async () => {
    throw new Error("api down");
  });
  const { logs, restore } = capture_logs();
  try {
    await channel._reply("C1", null, "hi");
  } finally {
    restore();
  }
  expect(logs.join("\n")).toContain("chat_postMessage FAILED");
});

test("test_reply_return_ts_none_without_web_client", async () => {
  const { channel } = _make_channel();
  channel._web_client = null;
  expect(await channel._reply_return_ts("C1", null, "hi")).toBeNull();
});
