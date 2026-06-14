// Ported from tests/test_feishu_*.py (bun:test).
//
// The Python suite mocked the lark SDK and threaded dispatch. The TypeScript
// channel uses async SDK wrappers and structural request objects, so these
// tests inject a small fake client and await the public helper seams directly.

import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  InboundMessageType,
  MessageBus,
  makeOutboundMessage,
  OutboundMessageType,
  type InboundMessage,
} from "../src/bus.ts";
import { _hooks as dirHooks } from "../src/channels/dir_utils.ts";
import {
  _hooks as feishuHooks,
  _FeishuStreamWriter,
  _set_feishu_available,
  FEISHU_CARD_MARKDOWN_CHUNK,
  FEISHU_PANEL_MAX_LINE_ELEMENTS,
  FEISHU_THINKING_PREFIX,
  FeishuChannel,
  HELP_TEXT,
  type FeishuScheduler,
  type FeishuTaskDB,
  type OutputListener,
} from "../src/channels/feishu.ts";
import type { Task } from "../src/types.ts";

type Row = Record<string, any>;

class StubDB implements FeishuTaskDB {
  settings: Record<string, string> = {};
  tasks = new Map<number, Row>();
  updated: Array<[number, Row]> = [];
  runs: Row[] = [];
  events: Row[] = [];
  byRoot = new Map<string, Row>();

  get_setting(key: string, defaultValue: string | null = null): string | null {
    return this.settings[key] ?? defaultValue;
  }

  set_setting(key: string, value: string): void {
    this.settings[key] = value;
  }

  get_task(task_id: number): Row | null {
    return this.tasks.get(task_id) ?? null;
  }

  update_task(task_id: number, updates: Row): void {
    this.updated.push([task_id, updates]);
    this.tasks.set(task_id, {
      ...(this.tasks.get(task_id) ?? { id: task_id }),
      ...updates,
    });
  }

  get_task_runs(_task_id: number, _limit?: number): Row[] {
    return this.runs;
  }

  get_run_output_events(_run_id: number, _limit?: number): Row[] {
    return this.events;
  }

  get_task_by_feishu_root_msg(root_msg_id: string): Row | null {
    return this.byRoot.get(root_msg_id) ?? null;
  }
}

class StubScheduler implements FeishuScheduler {
  submitted: Task[] = [];
  inbound: InboundMessage[] = [];
  listeners: OutputListener[] = [];
  removed: OutputListener[] = [];
  nextBriefId = 1;

  submit_task(task: Task): number {
    this.submitted.push(task);
    return this.submitted.length;
  }

  handle_inbound_message(msg: InboundMessage): Row {
    this.inbound.push(msg);
    if (msg.type === InboundMessageType.CREATE_BRIEF) {
      return { brief_id: this.nextBriefId++, status: "draft" };
    }
    if (msg.type === InboundMessageType.CONFIRM_BRIEF) {
      return { task_id: this.submitted.length + 1, status: "created" };
    }
    if (msg.type === InboundMessageType.DISCARD_BRIEF) {
      return { brief_id: msg.payload["brief_id"], status: "discarded" };
    }
    if (msg.type === InboundMessageType.RUN_RUNBOOK) {
      if (msg.payload["name"] === "release-check") {
        return {
          brief_id: this.nextBriefId++,
          runbook: msg.payload["name"],
          status: "draft",
        };
      }
      return {
        runbook: msg.payload["name"],
        status: "created",
        task_id: this.submitted.length + 1,
      };
    }
    return { status: "ignored" };
  }

  add_output_listener(cb: OutputListener): void {
    this.listeners.push(cb);
  }

  remove_output_listener(cb: OutputListener): void {
    this.removed.push(cb);
    this.listeners = this.listeners.filter((listener) => listener !== cb);
  }
}

function larkResponse(
  opts: {
    success?: boolean;
    messageId?: string;
    imageKey?: string;
    code?: number;
    msg?: string;
    raw?: Buffer;
  } = {},
): Row {
  const success = opts.success ?? true;
  return {
    success: () => success,
    code: opts.code ?? (success ? 0 : 99),
    msg: opts.msg ?? (success ? "ok" : "bad"),
    data: {
      message_id: opts.messageId,
      image_key: opts.imageKey,
    },
    raw: { content: opts.raw ?? Buffer.from([]) },
  };
}

function makeClient() {
  return {
    im: {
      v1: {
        message: {
          create: mock(() => larkResponse({ messageId: "om_created" })),
          reply: mock(() => larkResponse({ messageId: "om_reply" })),
          patch: mock(() => larkResponse()),
        },
        image: {
          create: mock(() => larkResponse({ imageKey: "img_uploaded" })),
        },
        message_resource: {
          get: mock(() => larkResponse()),
        },
        message_reaction: {
          create: mock(() => larkResponse()),
        },
      },
    },
  };
}

function makeChannel() {
  const bus = new MessageBus();
  const db = new StubDB();
  const scheduler = new StubScheduler();
  const channel = new FeishuChannel(bus, db, scheduler);
  channel._client = makeClient();
  return { channel, bus, db, scheduler, client: channel._client };
}

function textPayload(text: string): string {
  return JSON.stringify({ text });
}

function makeEvent(
  opts: {
    content?: string;
    messageType?: string;
    senderType?: string;
    openId?: string;
    chatType?: string;
    chatId?: string;
    messageId?: string;
    parentId?: string | null;
    rootId?: string | null;
  } = {},
): Row {
  return {
    event: {
      sender: {
        sender_type: opts.senderType ?? "user",
        sender_id: { open_id: opts.openId ?? "ou_sender" },
      },
      message: {
        message_type: opts.messageType ?? "text",
        content: opts.content ?? textPayload("hello"),
        message_id: opts.messageId ?? "om_msg",
        chat_type: opts.chatType ?? "p2p",
        chat_id: opts.chatId ?? "oc_chat",
        parent_id: opts.parentId ?? null,
        root_id: opts.rootId ?? null,
      },
    },
  };
}

async function withResolvedDir<T>(
  value: string,
  fn: () => Promise<T>,
): Promise<T> {
  const original = dirHooks.extract_working_dir_with_claude;
  dirHooks.extract_working_dir_with_claude = async () => value;
  try {
    return await fn();
  } finally {
    dirHooks.extract_working_dir_with_claude = original;
  }
}

function panelTexts(panel: Row): string[] {
  return (panel["elements"] as Row[])
    .filter((element) => element["tag"] === "div")
    .map((element) => element["text"]["content"]);
}

describe("Feishu lifecycle", () => {
  test("start noops when SDK is unavailable or import fails", async () => {
    const { channel, db } = makeChannel();
    db.settings["feishu_app_id"] = "cli_id";
    db.settings["feishu_app_secret"] = "secret";
    channel._client = null;

    _set_feishu_available(false);
    try {
      await channel._start();
      expect(channel._running).toBe(false);
      expect(channel._client).toBeNull();
    } finally {
      _set_feishu_available(true);
    }

    const original = feishuHooks.import_lark;
    feishuHooks.import_lark = async () => {
      throw new Error("sdk unavailable");
    };
    try {
      await channel._start();
    } finally {
      feishuHooks.import_lark = original;
    }

    expect(channel._running).toBe(false);
    expect(channel._client).toBeNull();
    expect(channel._ws_client).toBeNull();
  });

  test("start passes an EventDispatcher into WSClient.start and keeps running", async () => {
    const { channel, db } = makeChannel();
    db.settings["feishu_app_id"] = "cli_1234567890abcdef";
    db.settings["feishu_app_secret"] = "secret";

    const start = mock(async (_params: Row) => undefined);
    const close = mock((_opts?: Row) => undefined);
    const register = mock(function (this: Row, handlers: Row) {
      this.handlers = handlers;
      return this;
    });
    const dispatcher: Row = { register };
    const fakeLark = {
      AppType: { SelfBuild: 0 },
      Domain: { Feishu: 0 },
      Client: mock(function Client(this: Row, params: Row) {
        this.params = params;
      }),
      WSClient: mock(function WSClient(_this: Row, params: Row) {
        return { params, start, close };
      }),
      EventDispatcher: mock(function EventDispatcher() {
        return dispatcher;
      }),
    };
    const original = feishuHooks.import_lark;
    feishuHooks.import_lark = async () => fakeLark;
    try {
      await channel._start();
      await channel._ws_promise;
    } finally {
      feishuHooks.import_lark = original;
    }

    expect(fakeLark.WSClient.mock.calls[0][0]).toEqual({
      appId: "cli_1234567890abcdef",
      appSecret: "secret",
    });
    expect(register.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        "im.message.receive_v1": expect.any(Function),
        "im.chat.member.bot.added_v1": expect.any(Function),
        "im.message.reaction.created_v1": expect.any(Function),
        "im.message.reaction.deleted_v1": expect.any(Function),
      }),
    );
    expect(start.mock.calls[0][0]).toEqual({ eventDispatcher: dispatcher });
    expect(channel._running).toBe(true);
  });

  test("event dispatcher fallback and websocket connect/error branches", async () => {
    const { channel } = makeChannel();
    const dispatcher = channel._build_event_dispatcher({});
    expect(Object.keys(dispatcher.register)).toContain("im.message.receive_v1");

    const connect = mock(async () => undefined);
    channel._running = true;
    channel._ws_client = { connect };
    await channel._run_ws();
    expect(connect).toHaveBeenCalledTimes(1);

    channel._running = true;
    channel._ws_client = {
      start: mock(async () => {
        throw new Error("ws down");
      }),
    };
    await channel._run_ws({});
    expect(channel._running).toBe(false);
  });

  test("stop handles ws stop, disconnect, close, and thrown close errors", () => {
    const { channel } = makeChannel();

    const stop = mock(() => undefined);
    channel._ws_client = { stop };
    channel.stop();
    expect(stop).toHaveBeenCalledTimes(1);

    const disconnect = mock(async () => undefined);
    channel._ws_client = { disconnect };
    channel.stop();
    expect(disconnect).toHaveBeenCalledTimes(1);

    const close = mock(() => undefined);
    channel._ws_client = { close };
    channel.stop();
    expect((close as any).mock.calls[0][0]).toEqual({ force: true });

    channel._ws_client = {
      close: mock(() => {
        throw new Error("close down");
      }),
    };
    expect(() => channel.stop()).not.toThrow();
  });
});

describe("Feishu stream writer", () => {
  test("formats assistant and trace events without leaking secret fields", () => {
    const { channel } = makeChannel();
    const writer = new _FeishuStreamWriter(1, "om_stream", channel, "Task");

    expect(
      writer._display_content(
        "assistant",
        `${FEISHU_THINKING_PREFIX}thinking aloud`,
      ),
    ).toBe("thinking aloud");
    expect(
      writer._format_trace_event(
        "tool_call",
        JSON.stringify({
          server: "mcp",
          name: "search",
          input: { query: "coverage", token: "secret" },
          status: "ok",
        }),
      ),
    ).toContain("mcp.search");
    expect(
      writer._format_trace_event(
        "tool_result",
        JSON.stringify({ is_error: true, tool_use_id: "toolu_1", content: [] }),
      ),
    ).toContain("工具错误");
    expect(
      writer._format_trace_event(
        "command_execution",
        JSON.stringify({
          command: "bun test",
          output: "ok",
          exit_code: 0,
          status: "done",
        }),
      ),
    ).toContain("退出码 0");
    expect(
      writer._format_trace_event(
        "file_change",
        JSON.stringify({
          changes: [
            { kind: "edit", path: "a.ts" },
            { kind: "add", path: "b.ts" },
            { kind: "delete", path: "c.ts" },
            { kind: "edit", path: "d.ts" },
          ],
        }),
      ),
    ).toContain("等 4 项");
    expect(
      writer._format_trace_event(
        "web_search",
        JSON.stringify({ query: "bun coverage", status: "ok" }),
      ),
    ).toContain("网页搜索");
    expect(writer._format_trace_event("error", "plain failure")).toContain(
      "plain failure",
    );
    expect(writer._format_trace_event("custom", "raw")).toContain("[custom]");

    const compact = writer._compact_trace_summary({
      password: "hidden",
      message: "hello\nworld",
    });
    expect(compact).toBe("hello");
    expect(
      writer._compact_trace_summary([{ text: "first" }, { text: "second" }]),
    ).toContain("等 2 项");
    expect(writer._truncate_trace_text("x ".repeat(200), 20)).toEndWith("…");
  });

  test("patch scheduling writes cards, resets on new run, and stops timers", async () => {
    const { channel } = makeChannel();
    channel._patch_message = mock(async () => true) as any;
    const writer = new _FeishuStreamWriter(2, "om_stream", channel, "Task");
    writer._last_patch = 0;

    writer.on_event(99, 1, "assistant", "ignored");
    writer.on_event(2, 1, "assistant", "hello");
    writer.on_event(2, 1, "tool_call", JSON.stringify({ name: "tool" }));
    await Promise.resolve();

    expect(writer.snapshot_text()).toContain("hello");
    expect(channel._patch_message).toHaveBeenCalled();

    writer._last_patch = Date.now() / 1000;
    writer.on_event(2, 2, "assistant", "fresh");
    expect(writer.snapshot_text()).toBe("fresh");
    expect(writer._timer).not.toBeNull();
    writer.stop();
    expect(writer._timer).toBeNull();
    writer._dirty = false;
    writer._schedule();
    expect(writer._dirty).toBe(false);
  });
});

describe("Feishu notification cards", () => {
  test("completed card shows result content without task metadata", () => {
    const { channel } = makeChannel();

    const card = channel._build_notification_card({
      task_id: 42,
      task: {
        id: 42,
        title: "Fix Feishu rendering",
        prompt: "make it scan well",
        agent: "codex",
        working_dir: "~/workspace/agentforge",
      },
      is_completed: true,
      body_text: "Done.\n\n- summary\n- details",
    });

    expect(card["schema"]).toBe("2.0");
    expect(card["config"]["summary"]["content"]).toBe("Done.");
    expect(card["body"]["elements"]).toEqual([
      { tag: "markdown", content: "Done.\n\n- summary\n- details" },
    ]);
    expect(JSON.stringify(card)).not.toContain("Task #42");
    expect(JSON.stringify(card)).not.toContain("Prompt");
  });

  test("failed card appends a status hint", () => {
    const { channel } = makeChannel();

    const card = channel._build_notification_card({
      task_id: 7,
      task: { id: 7, title: "Broken task", prompt: "debug", agent: "claude" },
      is_completed: false,
      body_text: "Traceback: boom",
    });

    expect(
      card["body"]["elements"].some(
        (element: Row) =>
          element["tag"] === "markdown" &&
          String(element["content"]).includes("/status 7"),
      ),
    ).toBe(true);
  });

  test("streaming history is placed above final result", () => {
    const { channel } = makeChannel();

    const card = channel._build_notification_card({
      task_id: 103,
      task: { id: 103, title: "Finished", prompt: "go", agent: "codex" },
      is_completed: true,
      body_text: "final result",
      streaming_history: "step one\nstep two",
    });

    const [panel, result] = card["body"]["elements"];
    expect(panel["tag"]).toBe("collapsible_panel");
    expect(panel["expanded"]).toBe(false);
    expect(panel["header"]["title"]["content"]).toBe("执行过程");
    expect(panelTexts(panel)).toEqual(["step one", "step two"]);
    expect(result).toEqual({ tag: "markdown", content: "final result" });
  });
});

describe("Feishu outbound dispatch", () => {
  test("non-terminal outbound messages are ignored", async () => {
    const { channel, db } = makeChannel();
    db.get_task = mock(() => null) as any;

    await channel._send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_STARTED,
        task_id: 1,
      }),
    );

    expect((db.get_task as any).mock.calls).toHaveLength(0);
  });

  test("terminal outbound messages handle missing client, task, and destination", async () => {
    const { channel, db } = makeChannel();

    channel._client = null;
    await channel._send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_COMPLETED,
        task_id: 1,
      }),
    );

    channel._client = makeClient();
    await channel._send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_COMPLETED,
        task_id: 404,
      }),
    );

    db.tasks.set(12, { id: 12, title: "No destination", result: "" });
    await channel._send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_COMPLETED,
        task_id: 12,
      }),
    );

    expect(channel._notification_map.size).toBe(0);
  });

  test("completed notification falls back to default chat and maps message id", async () => {
    const { channel, db } = makeChannel();
    db.settings["feishu_default_chat_id"] = "oc_default";
    db.tasks.set(5, {
      id: 5,
      title: "Done",
      prompt: "p",
      agent: "codex",
      result: "all good",
    });
    channel._stop_streaming = mock(() => null) as any;
    channel._collect_generated_image_paths = mock(() => []) as any;
    channel._send_message = mock(async () => "om_sent") as any;

    await channel._send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_COMPLETED,
        task_id: 5,
        payload: { result: "all good" },
      }),
    );

    expect((channel._send_message as any).mock.calls[0][0]).toBe("oc_default");
    expect((channel._send_message as any).mock.calls[0][1]).toBe("all good");
    expect((channel._send_message as any).mock.calls[0][3]).toBe("all good");
    expect(channel._notification_map.get("om_sent")).toBe(5);
  });

  test("failed notification replies to origin and uses cry reaction", async () => {
    const { channel, db } = makeChannel();
    db.tasks.set(8, {
      id: 8,
      title: "Boom",
      prompt: "p",
      agent: "codex",
      result: null,
    });
    channel._task_origin.set(8, ["oc_chat", "om_root", "om_trigger"]);
    channel._stop_streaming = mock(() => null) as any;
    channel._add_reaction = mock(() => undefined) as any;
    channel._reply_message = mock(async () => "om_reply") as any;

    await channel._send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_FAILED,
        task_id: 8,
        payload: { error: "nope" },
      }),
    );

    expect((channel._add_reaction as any).mock.calls[0]).toEqual([
      "om_trigger",
      "Cry",
    ]);
    expect((channel._reply_message as any).mock.calls[0][0]).toBe("om_root");
    expect(channel._notification_map.get("om_reply")).toBe(8);
    expect(channel._task_origin.has(8)).toBe(false);
  });

  test("streaming card is patched when present", async () => {
    const { channel, db } = makeChannel();
    db.tasks.set(9, {
      id: 9,
      title: "Done",
      prompt: "p",
      agent: "codex",
      result: "final",
    });
    channel._task_origin.set(9, ["oc_chat", "om_root", "om_trigger"]);
    channel._streaming_msg.set(9, "om_stream");
    channel._stop_streaming = mock(() => "history") as any;
    channel._collect_generated_image_paths = mock(() => []) as any;
    channel._add_reaction = mock(() => undefined) as any;
    channel._patch_message = mock(async () => true) as any;
    channel._reply_message = mock(async () => "om_reply") as any;

    await channel._send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_COMPLETED,
        task_id: 9,
        payload: { result: "final" },
      }),
    );

    expect((channel._patch_message as any).mock.calls[0][0]).toBe("om_stream");
    expect((channel._reply_message as any).mock.calls).toHaveLength(0);
    expect(channel._notification_map.get("om_stream")).toBe(9);
  });

  test("uploaded generated images are attached to the card", async () => {
    const { channel, db } = makeChannel();
    db.settings["feishu_default_chat_id"] = "oc_default";
    db.tasks.set(11, {
      id: 11,
      title: "Image",
      prompt: "p",
      agent: "codex",
      result: "see image",
    });
    channel._stop_streaming = mock(() => null) as any;
    channel._collect_generated_image_paths = mock(() => ["/tmp/a.png"]) as any;
    channel._upload_image_entries = mock(async () => [
      ["/tmp/a.png", "img_key_1"],
    ]) as any;
    channel._hide_generated_image_paths = mock(() => "see image") as any;
    channel._send_message = mock(async () => "om_sent") as any;

    await channel._send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_COMPLETED,
        task_id: 11,
        payload: { result: "see image" },
      }),
    );

    const card = (channel._send_message as any).mock.calls[0][2];
    expect(card["body"]["elements"].at(-1)).toEqual({
      tag: "img",
      img_key: "img_key_1",
      alt: { tag: "plain_text", content: "generated image 1" },
    });
  });
});

describe("Feishu SDK wrappers", () => {
  test("create message returns message id and sends interactive content", async () => {
    const { channel, client } = makeChannel();

    const result = await channel._create_message("chat_id", "oc_x", {
      schema: "2.0",
    });

    expect(result).toBe("om_created");
    const req = client.im.v1.message.create.mock.calls[0][0];
    expect(req.receive_id_type).toBe("chat_id");
    expect(req.request_body.receive_id).toBe("oc_x");
    expect(req.request_body.msg_type).toBe("interactive");
    expect(JSON.parse(req.request_body.content)).toEqual({ schema: "2.0" });
  });

  test("create reply sets reply-in-thread flag", async () => {
    const { channel, client } = makeChannel();

    const result = await channel._create_reply("om_parent", { schema: "2.0" });

    expect(result).toBe("om_reply");
    const req = client.im.v1.message.reply.mock.calls[0][0];
    expect(req.message_id).toBe("om_parent");
    expect(req.request_body.reply_in_thread).toBe(true);
    expect(req.request_body.msg_type).toBe("interactive");
  });

  test("send message falls back to legacy markdown card when card send fails", async () => {
    const { channel, client } = makeChannel();
    client.im.v1.message.create
      .mockImplementationOnce(() => larkResponse({ success: false }))
      .mockImplementationOnce(() => larkResponse({ messageId: "om_fallback" }));

    const result = await channel._send_message(
      "oc_chat",
      "visible content",
      { schema: "2.0" },
      "fallback",
    );

    expect(result).toBe("om_fallback");
    expect(client.im.v1.message.create.mock.calls).toHaveLength(2);
    const fallbackReq = client.im.v1.message.create.mock.calls[1][0];
    expect(JSON.parse(fallbackReq.request_body.content)).toEqual({
      config: { wide_screen_mode: true },
      elements: [{ tag: "markdown", content: "fallback" }],
    });
  });

  test("message, reply, patch, reaction, and upload wrappers cover fallback paths", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-feishu-"));
    const imagePath = path.join(tmpDir, "upload.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const legacyClient: Row = {
      im: {
        message: {
          create: mock(() => ({ code: 0, data: { messageId: "om_legacy" } })),
          reply: mock(() => ({ success: true, message_id: "om_reply_legacy" })),
          patch: mock(() => ({ code: 0 })),
        },
        image: {
          create: mock(() => ({ code: 0, data: { imageKey: "img_legacy" } })),
        },
        messageReaction: {
          create: mock(() => ({ code: 0 })),
        },
      },
    };
    const { channel } = makeChannel();
    channel._client = legacyClient;

    try {
      expect(await channel._send_message("ou_user", "hello")).toBe("om_legacy");
      expect(
        legacyClient.im.message.create.mock.calls[0][0].receive_id_type,
      ).toBe("open_id");
      expect(await channel._reply_message("om_parent", "reply")).toBe(
        "om_reply_legacy",
      );
      expect(await channel._patch_message("om_parent", { schema: "2.0" })).toBe(
        true,
      );
      expect(await channel._upload_image(imagePath)).toBe("img_legacy");
      expect(await channel._upload_images([imagePath])).toEqual(["img_legacy"]);

      legacyClient.im.message.create.mockImplementationOnce(() => {
        throw new Error("send down");
      });
      expect(await channel._send_message("oc_chat", "hello")).toBeNull();

      legacyClient.im.message.reply.mockImplementationOnce(() => {
        throw new Error("reply down");
      });
      expect(await channel._reply_message("om_parent", "hello")).toBeNull();

      legacyClient.im.message.patch.mockImplementationOnce(() => ({
        code: 99,
        msg: "bad",
      }));
      expect(await channel._patch_message("om_parent", {})).toBe(false);
      legacyClient.im.message.patch.mockImplementationOnce(() => {
        throw new Error("patch down");
      });
      expect(await channel._patch_message("om_parent", {})).toBe(false);

      legacyClient.im.image.create.mockImplementationOnce(() => ({
        code: 99,
        msg: "bad image",
      }));
      expect(await channel._upload_image(imagePath)).toBeNull();
      expect(
        await channel._upload_image(path.join(tmpDir, "missing.png")),
      ).toBeNull();

      channel._add_reaction("om_parent", "OK");
      await Promise.resolve();
      expect(legacyClient.im.messageReaction.create).toHaveBeenCalled();
      legacyClient.im.messageReaction.create.mockImplementationOnce(() => {
        throw new Error("reaction down");
      });
      channel._add_reaction("om_parent", "OK");
      await Promise.resolve();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Feishu rendering and image helpers", () => {
  test("streaming and result card helpers chunk and truncate content", () => {
    const { channel } = makeChannel();

    expect(
      channel._build_streaming_card(1, "Task", "", false)["body"]["elements"],
    ).toEqual([{ tag: "markdown", content: "Thinking ▌" }]);
    expect(
      channel._build_streaming_card(1, "Task", "done\r\nok", true)["body"][
        "elements"
      ][0]["content"],
    ).toBe("done\nok");

    const manyLines = Array.from(
      { length: FEISHU_PANEL_MAX_LINE_ELEMENTS + 1 },
      (_, i) => `line ${i}`,
    ).join("\n");
    expect(channel._build_streaming_history_elements(manyLines)[0]["tag"]).toBe(
      "markdown",
    );
    expect(
      channel._build_result_elements(
        "x".repeat(FEISHU_CARD_MARKDOWN_CHUNK + 2),
      ),
    ).toHaveLength(2);
    expect(channel._build_result_elements("", ["img_a"])).toEqual([
      { tag: "markdown", content: "Done." },
      {
        tag: "img",
        img_key: "img_a",
        alt: { tag: "plain_text", content: "generated image 1" },
      },
    ]);
    expect(
      channel._strip_final_result_from_history("step\nfinal", "final"),
    ).toBe("step");
    expect(channel._strip_final_result_from_history("step", "")).toBe("step");
    expect(channel._truncate_text("a".repeat(10), 5)).toBe(
      "aaaaa\n…(truncated)",
    );
    expect(channel._chunk_text("", 5)).toEqual([""]);
    expect(channel._escape_feishu_markdown("\\")).toBe("\\\\");
  });

  test("generated image helpers collect, normalize, and hide uploaded paths", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-feishu-"));
    const eventImage = path.join(tmpDir, "event.png");
    const markdownImage = path.join(tmpDir, "markdown image.png");
    fs.writeFileSync(eventImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(markdownImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { channel, db } = makeChannel();
    db.runs = [{ id: 5 }];
    db.events = [
      { event_type: "generated_image", content: "bad json" },
      {
        event_type: "generated_image",
        content: JSON.stringify({ path: eventImage }),
      },
      {
        event_type: "generated_image",
        content: JSON.stringify({ path: eventImage }),
      },
    ];

    try {
      expect(
        channel._collect_generated_image_paths(
          1,
          `![m](markdown%20image.png)\n![r](https://example.test/x.png)`,
          { working_dir: tmpDir },
        ),
      ).toEqual([fs.realpathSync(eventImage), fs.realpathSync(markdownImage)]);
      expect(
        channel._local_image_path_from_reference(`file://${eventImage}`),
      ).toBe(fs.realpathSync(eventImage));
      expect(
        channel._local_image_path_from_reference(`sandbox:${eventImage}`),
      ).toBe(fs.realpathSync(eventImage));
      expect(
        channel._local_image_path_from_reference("'bad.txt'", tmpDir),
      ).toBeNull();
      expect(channel._markdown_image_reference_target(`<${eventImage}>`)).toBe(
        eventImage,
      );
      expect(
        channel._dedupe_image_paths([eventImage, eventImage, null as any]),
      ).toEqual([fs.realpathSync(eventImage)]);
      expect(
        channel._line_is_uploaded_image_path(
          `- ${eventImage}`,
          new Set([fs.realpathSync(eventImage)]),
        ),
      ).toBe(true);
      expect(
        channel._line_is_uploaded_image_path(
          "- /tmp/.codex/generated_images/x.png",
          new Set(),
        ),
      ).toBe(true);
      expect(
        channel._remove_uploaded_markdown_image_refs(
          `before ![x](${eventImage}) after`,
          new Set([fs.realpathSync(eventImage)]),
        ),
      ).toBe("before  after");
      expect(
        channel._hide_generated_image_paths(`Done\n- ${eventImage}\n-`, 1, [
          eventImage,
        ]),
      ).toBe("Done");
      expect(channel._hide_generated_image_paths("已生成图片", 2, [])).toBe(
        "已生成 2 张图片。",
      );

      db.get_task_runs = mock(() => {
        throw new Error("runs down");
      }) as any;
      expect(channel._generated_image_paths_for_task(1)).toEqual([]);
      db.get_task_runs = mock(() => [{ id: 5 }]) as any;
      db.get_run_output_events = mock(() => {
        throw new Error("events down");
      }) as any;
      expect(channel._generated_image_paths_for_task(1)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Feishu forwarded, media, and command handling", () => {
  test("forwarded content parsing and formatting handles supported shapes", () => {
    const { channel } = makeChannel();

    const direct = channel._extract_forwarded_content({
      message_type: "forward",
      content: JSON.stringify({
        sender_name: "Ada",
        sender_id: "ou_ada",
        create_time: 1700000000,
        text: "forwarded body",
        images: [{ image_key: "img_1" }],
      }),
    })!;
    expect(direct["sender_name"]).toBe("Ada");
    expect(
      channel._format_forwarded_prompt("please inspect", direct),
    ).toContain("用户附加消息");
    expect(channel._format_forwarded_prompt("", direct)).toContain(
      "包含 1 张图片",
    );

    expect(
      channel._extract_forwarded_content({
        message_type: "forward",
        content: "{bad json",
      }),
    ).toBeNull();
    expect(
      channel._extract_forwarded_content({
        message_type: "post",
        content: JSON.stringify({
          content: [
            [
              {
                tag: "quote",
                user: { name: "Lin", open_id: "ou_lin" },
                text: "quoted",
              },
            ],
          ],
        }),
      })!["type"],
    ).toBe("quote");
    expect(
      channel._extract_forwarded_content({
        message_type: "post",
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                {
                  tag: "nested_message",
                  nested_message: {
                    sender_name: "Nested",
                    text: "nested body",
                  },
                },
              ],
            ],
          },
        }),
      })!["sender_name"],
    ).toBe("Nested");
    expect(
      channel._extract_forwarded_content({
        message_type: "post",
        content: "{bad json",
      }),
    ).toBeNull();
  });

  test("download and parse message content cover text, post, image, and unknown", async () => {
    const { channel, client } = makeChannel();
    const payloads = [
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("GIF89a"),
      Buffer.from("RIFFxxxxWEBP"),
    ];
    client.im.v1.message_resource.get = mock(() =>
      larkResponse({ raw: payloads.shift() ?? Buffer.from([]) }),
    );

    const downloaded = [
      await channel._download_image("om", "jpg_key"),
      await channel._download_image("om", "png_key"),
      await channel._download_image("om", "gif_key"),
      await channel._download_image("om", "webp_key"),
    ];
    expect(downloaded.map((p) => path.extname(p ?? ""))).toEqual([
      ".jpg",
      ".png",
      ".gif",
      ".webp",
    ]);

    client.im.v1.message_resource.get = mock(() =>
      larkResponse({ success: false }),
    );
    expect(await channel._download_image("om", "missing")).toBeNull();
    client.im.v1.message_resource.get = mock(() => {
      throw new Error("download down");
    });
    expect(await channel._download_image("om", "throwing")).toBeNull();

    expect(
      await channel._parse_message_content({
        message_type: "text",
        content: JSON.stringify({ text: " hi " }),
      }),
    ).toEqual({ content: "hi", image_paths: [] });
    expect(
      await channel._parse_message_content({
        message_type: "text",
        content: " raw ",
      }),
    ).toEqual({ content: "raw", image_paths: [] });
    channel._download_image = mock(async () => "/tmp/img.png") as any;
    expect(
      await channel._parse_message_content({
        message_type: "post",
        message_id: "om_post",
        content: JSON.stringify({
          zh_cn: {
            title: "Title",
            content: [
              [
                { tag: "text", text: "body" },
                { tag: "img", image_key: "img" },
              ],
            ],
          },
        }),
      }),
    ).toEqual({ content: "Title\nbody", image_paths: ["/tmp/img.png"] });
    expect(
      await channel._parse_message_content({
        message_type: "post",
        content: "{bad json",
      }),
    ).toEqual({ content: "", image_paths: [] });
    expect(
      await channel._parse_message_content({
        message_type: "image",
        message_id: "om_img",
        content: JSON.stringify({ image_key: "img" }),
      }),
    ).toEqual({
      content: "请分析这张图片的内容",
      image_paths: ["/tmp/img.png"],
    });
    expect(
      await channel._parse_message_content({
        message_type: "image",
        content: "{bad json",
      }),
    ).toEqual({ content: "请分析这张图片的内容", image_paths: [] });
    expect(
      await channel._parse_message_content({ message_type: "audio" }),
    ).toBeNull();
  });

  test("inbound command branches reply without creating tasks", async () => {
    const { channel, db, scheduler } = makeChannel();
    db.tasks.set(9, { id: 9, status: "running", title: "Run task" });
    channel._send_message = mock(async () => "om_reply") as any;
    channel._add_reaction = mock(() => undefined) as any;

    await channel._handle_inbound(makeEvent({ senderType: "bot" }));
    await channel._handle_inbound(makeEvent({ content: textPayload("/help") }));
    await channel._handle_inbound(
      makeEvent({ content: textPayload("/start") }),
    );
    await channel._handle_inbound(
      makeEvent({ content: textPayload("/dir /tmp/app") }),
    );
    await channel._handle_inbound(
      makeEvent({ content: textPayload("/agent codex") }),
    );
    await channel._handle_inbound(makeEvent({ content: textPayload("/ccu") }));
    await channel._handle_inbound(
      makeEvent({ content: textPayload("/status nope") }),
    );
    await channel._handle_inbound(
      makeEvent({ content: textPayload("/status 404") }),
    );
    await channel._handle_inbound(
      makeEvent({ content: textPayload("/status 9") }),
    );
    await channel._handle_inbound(
      makeEvent({ content: textPayload("task completed notification") }),
    );

    expect(scheduler.submitted).toHaveLength(0);
    const sent = (channel._send_message as any).mock.calls.map(
      (call: Row[]) => call[1],
    );
    expect(sent.some((text: string) => text.includes("AgentForge Bot"))).toBe(
      true,
    );
    expect(
      sent.some((text: string) => text.includes("Working directory")),
    ).toBe(true);
    expect(
      sent.some((text: string) => text.includes("Default agent switched")),
    ).toBe(true);
    expect(sent.some((text: string) => text.includes("Claude Code 用量"))).toBe(
      true,
    );
    expect(sent.some((text: string) => text.includes("not found"))).toBe(true);
    expect(sent.some((text: string) => text.includes("Run task"))).toBe(true);
  });

  test("resume command and thread resume cover usage, missing, mapped, and DB root paths", async () => {
    const { channel, db } = makeChannel();
    channel._send_message = mock(async () => "om_sent") as any;
    channel._reply_message = mock(async () => "om_thread_reply") as any;
    channel._create_reply = mock(async () => "om_running") as any;
    channel._start_streaming = mock(() => undefined) as any;

    await channel._handle_resume_command("/resume nope", "ou_user", {
      message_id: "om_resume",
    });
    await channel._handle_resume_command("/resume 404 go", "ou_user", {
      message_id: "om_resume",
    });
    db.tasks.set(10, { id: 10, title: "Resume", session_id: "sess" });
    await channel._handle_resume_command("/resume 10 continue", "ou_user", {
      message_id: "om_resume",
    });

    expect(db.updated.at(-1)).toEqual([
      10,
      {
        status: "pending",
        prompt: "continue",
        result: null,
        error: null,
        question: null,
      },
    ]);
    expect(channel._task_origin.get(10)).toEqual([
      "ou_user",
      "om_resume",
      "om_resume",
    ]);

    channel._notification_map.set("om_parent", 11);
    db.tasks.set(11, { id: 11, title: "No session" });
    expect(
      await channel._try_resume_thread_message(
        "continue",
        "ou_user",
        { message_id: "om_child" },
        "om_parent",
        null,
      ),
    ).toBe(true);
    expect((channel._reply_message as any).mock.calls.at(-1)[1]).toContain(
      "no saved session",
    );

    db.byRoot.set("om_root", { id: 12 });
    db.tasks.set(12, { id: 12, title: "Root task", session_id: "sess12" });
    expect(
      await channel._try_resume_thread_message(
        "root continue",
        "ou_user",
        { message_id: "om_child2" },
        null,
        "om_root",
      ),
    ).toBe(true);
    expect(db.updated.at(-1)![0]).toBe(12);
    expect(
      await channel._try_resume_thread_message(
        "no map",
        "ou_user",
        { message_id: "om_child3" },
        "none",
        null,
      ),
    ).toBe(false);
  });
});

describe("Feishu inbound handling", () => {
  test("bot-added event sends help text", () => {
    const { channel } = makeChannel();
    channel._send_message = mock(async () => "om_help") as any;

    channel._on_bot_added({ event: { chat_id: "oc_new" } });

    expect((channel._send_message as any).mock.calls[0]).toEqual([
      "oc_new",
      HELP_TEXT,
    ]);
  });

  test("plain text message creates a task and starts a streaming reply", async () => {
    const { channel, db, scheduler } = makeChannel();
    db.settings["default_agent"] = "claude";
    channel._add_reaction = mock(() => undefined) as any;
    channel._create_reply = mock(async () => "om_running") as any;
    channel._start_streaming = mock(() => undefined) as any;

    await withResolvedDir("/tmp/project", async () => {
      await channel._handle_inbound(
        makeEvent({
          content: textPayload("fix login"),
          messageId: "om_root",
        }),
      );
    });

    expect((channel._add_reaction as any).mock.calls[0]).toEqual([
      "om_root",
      "OK",
    ]);
    expect(scheduler.submitted).toHaveLength(1);
    const task = scheduler.submitted[0]!;
    expect(task.title).toBe("[Feishu] fix login");
    expect(task.prompt).toBe("fix login");
    expect(task.working_dir).toBe("/tmp/project");
    expect(task.tags).toBe("feishu");
    expect(task.feishu_root_msg_id).toBe("om_root");
    expect(task.agent).toBe("claude");
    expect(channel._root_msg_map.get("om_root")).toBe(1);
    expect(channel._task_origin.get(1)).toEqual([
      "ou_sender",
      "om_root",
      "om_root",
    ]);
    expect((channel._create_reply as any).mock.calls[0][0]).toBe("om_root");
    expect((channel._start_streaming as any).mock.calls[0][0]).toBe(1);
  });

  test("brief command creates a draft without submitting a task", async () => {
    const { channel, db, scheduler } = makeChannel();
    db.settings["default_agent"] = "codex";
    channel._send_message = mock(async () => "om_reply") as any;
    channel._add_reaction = mock(() => undefined) as any;

    await withResolvedDir("/tmp/repo", async () => {
      await channel._handle_inbound(
        makeEvent({
          content: textPayload("/brief fix the login redirect"),
          messageId: "om_brief",
          chatId: "oc_product",
        }),
      );
    });

    expect(scheduler.submitted).toHaveLength(0);
    expect(scheduler.inbound).toHaveLength(1);
    expect(scheduler.inbound[0]!.type).toBe(InboundMessageType.CREATE_BRIEF);
    expect(scheduler.inbound[0]!.payload["goal"]).toBe(
      "fix the login redirect",
    );
    expect(scheduler.inbound[0]!.payload["working_dir"]).toBe("/tmp/repo");
    expect(scheduler.inbound[0]!.payload["source_ref"]).toBe("om_brief");
    expect(scheduler.inbound[0]!.payload["source_metadata"]).toEqual({
      chat_id: "oc_product",
      chat_type: "p2p",
      message_id: "om_brief",
      sender_id: "ou_sender",
    });
    const sent = (channel._send_message as any).mock.calls.at(-1);
    expect(sent[0]).toBe("ou_sender");
    expect(sent[1]).toContain("Draft task brief #1");
    expect(sent[1]).toContain("/confirm-brief 1");
  });

  test("confirm and discard brief commands use text fallback", async () => {
    const { channel, bus, scheduler } = makeChannel();
    channel._send_message = mock(async () => "om_reply") as any;
    channel._create_reply = mock(async () => "om_running") as any;
    channel._start_streaming = mock(() => undefined) as any;
    channel._add_reaction = mock(() => undefined) as any;

    await channel._handle_inbound(
      makeEvent({
        content: textPayload("/confirm-brief 4"),
        messageId: "om_confirm",
      }),
    );

    expect(scheduler.inbound[0]!.type).toBe(InboundMessageType.CONFIRM_BRIEF);
    expect(scheduler.inbound[0]!.payload["brief_id"]).toBe(4);
    expect(channel._task_origin.get(1)).toEqual([
      "ou_sender",
      "om_confirm",
      "om_confirm",
    ]);
    expect(channel._root_msg_map.get("om_confirm")).toBe(1);
    expect(bus.get_task_source(1)).toBe("feishu");
    expect((channel._create_reply as any).mock.calls[0][0]).toBe("om_confirm");
    expect((channel._start_streaming as any).mock.calls[0][0]).toBe(1);

    await channel._handle_inbound(
      makeEvent({
        content: textPayload("/discard-brief #4"),
        messageId: "om_discard",
      }),
    );

    expect(scheduler.inbound[1]!.type).toBe(InboundMessageType.DISCARD_BRIEF);
    expect(scheduler.inbound[1]!.payload["brief_id"]).toBe(4);
    const sent = (channel._send_message as any).mock.calls.at(-1);
    expect(sent[0]).toBe("ou_sender");
    expect(sent[1]).toContain("discarded");
  });

  test("runbook commands use text fallback", async () => {
    const { channel, bus, scheduler } = makeChannel();
    channel._send_message = mock(async () => "om_reply") as any;
    channel._create_reply = mock(async () => "om_running") as any;
    channel._start_streaming = mock(() => undefined) as any;
    channel._add_reaction = mock(() => undefined) as any;

    await withResolvedDir("/tmp/repo", async () => {
      await channel._handle_inbound(
        makeEvent({
          content: textPayload("/review-pr https://github.com/acme/app/pull/42"),
          messageId: "om_runbook",
        }),
      );
    });

    expect(scheduler.inbound[0]!.type).toBe(InboundMessageType.RUN_RUNBOOK);
    expect(scheduler.inbound[0]!.payload["name"]).toBe("review-pr");
    expect(scheduler.inbound[0]!.payload["raw_args"]).toBe(
      "https://github.com/acme/app/pull/42",
    );
    expect(scheduler.inbound[0]!.payload["working_dir"]).toBe("/tmp/repo");
    expect(channel._task_origin.get(1)).toEqual([
      "ou_sender",
      "om_runbook",
      "om_runbook",
    ]);
    expect(channel._root_msg_map.get("om_runbook")).toBe(1);
    expect(bus.get_task_source(1)).toBe("feishu");
    expect((channel._create_reply as any).mock.calls[0][0]).toBe("om_runbook");
    expect((channel._start_streaming as any).mock.calls[0][0]).toBe(1);

    await channel._handle_inbound(
      makeEvent({
        content: textPayload("/release-check"),
        messageId: "om_release",
      }),
    );

    expect(scheduler.inbound[1]!.type).toBe(InboundMessageType.RUN_RUNBOOK);
    expect(scheduler.inbound[1]!.payload["name"]).toBe("release-check");
    const sent = (channel._send_message as any).mock.calls.at(-1);
    expect(sent[1]).toContain("Draft task brief #1");
    expect(sent[1]).toContain("/confirm-brief 1");
  });

  test("post message with only an image creates default image-analysis prompt", async () => {
    const { channel, scheduler } = makeChannel();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-feishu-"));
    const imagePath = path.join(tmpDir, "pic.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    channel._download_image = mock(async () => imagePath) as any;
    channel._add_reaction = mock(() => undefined) as any;
    channel._create_reply = mock(async () => null) as any;

    try {
      await withResolvedDir("/tmp", async () => {
        await channel._handle_inbound(
          makeEvent({
            messageType: "post",
            content: JSON.stringify({
              content: [[{ tag: "img", image_key: "img_x" }]],
            }),
            messageId: "om_img",
          }),
        );
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    expect(scheduler.submitted).toHaveLength(1);
    expect(scheduler.submitted[0]!.prompt).toBe("请分析这些图片的内容");
    expect(scheduler.submitted[0]!.image_paths).toEqual([imagePath]);
    expect(scheduler.submitted[0]!.prompt_images).toHaveLength(1);
  });

  test("resume command updates task and starts streaming", async () => {
    const { channel, db } = makeChannel();
    db.tasks.set(12, {
      id: 12,
      title: "Existing task",
      session_id: "sess_1",
      status: "completed",
    });
    channel._add_reaction = mock(() => undefined) as any;
    channel._create_reply = mock(async () => "om_running") as any;
    channel._start_streaming = mock(() => undefined) as any;

    await channel._handle_inbound(
      makeEvent({
        content: textPayload("/resume 12 continue please"),
        messageId: "om_resume",
      }),
    );

    expect(db.updated[0]).toEqual([
      12,
      {
        status: "pending",
        prompt: "continue please",
        result: null,
        error: null,
        question: null,
      },
    ]);
    expect(channel._task_origin.get(12)).toEqual([
      "ou_sender",
      "om_resume",
      "om_resume",
    ]);
    expect((channel._start_streaming as any).mock.calls[0][0]).toBe(12);
  });

  test("reply in a mapped thread resumes the task", async () => {
    const { channel, db } = makeChannel();
    db.tasks.set(33, {
      id: 33,
      title: "Mapped task",
      session_id: "sess_33",
      status: "completed",
    });
    channel._notification_map.set("om_parent", 33);
    channel._add_reaction = mock(() => undefined) as any;
    channel._create_reply = mock(async () => "om_running") as any;
    channel._start_streaming = mock(() => undefined) as any;

    await channel._handle_inbound(
      makeEvent({
        content: textPayload("continue from thread"),
        messageId: "om_child",
        parentId: "om_parent",
      }),
    );

    expect(db.updated[0]![0]).toBe(33);
    expect(db.updated[0]![1]["prompt"]).toBe("continue from thread");
    expect(channel._task_origin.get(33)).toEqual([
      "ou_sender",
      "om_parent",
      "om_child",
    ]);
  });
});

describe("Feishu streaming listener lifecycle", () => {
  test("start and stop streaming unregister the exact listener", () => {
    const { channel, scheduler } = makeChannel();

    channel._start_streaming(44, "om_stream", "Streaming task");
    expect(scheduler.listeners).toHaveLength(1);
    const listener = scheduler.listeners[0]!;

    const history = channel._stop_streaming(44);

    expect(history).toBe("");
    expect(scheduler.removed).toEqual([listener]);
    expect(scheduler.listeners).toHaveLength(0);
    expect(channel._writer_listeners.has(44)).toBe(false);
  });

  test("stop unregisters active writer listeners", () => {
    const { channel, scheduler } = makeChannel();

    channel._start_streaming(45, "om_stream", "Streaming task");
    const listener = scheduler.listeners[0]!;
    channel.stop();

    expect(scheduler.removed).toContain(listener);
    expect(scheduler.listeners).toHaveLength(0);
    expect(channel._writers.size).toBe(0);
    expect(channel._writer_listeners.size).toBe(0);
    expect(channel._streaming_msg.size).toBe(0);
  });
});
