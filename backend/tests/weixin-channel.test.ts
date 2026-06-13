// Weixin channel startup tests.
//
// The Weixin channel uses a sidecar bridge process instead of a chat SDK. These
// tests lock down the packaging-sensitive command selection and spawn env.

import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  makeOutboundMessage,
  MessageBus,
  OutboundMessageType,
} from "../src/bus.ts";
import { _hooks as dirHooks } from "../src/channels/dir_utils.ts";
import {
  _find_bun_executable,
  _hooks,
  WeixinChannel,
  type WeixinBridgeProcess,
  type WeixinScheduler,
  type WeixinTaskDB,
} from "../src/channels/weixin.ts";
import type { Task } from "../src/types.ts";

type Row = Record<string, any>;

class StubDB implements WeixinTaskDB {
  settings: Record<string, string> = {};
  tasks = new Map<number, Row>();
  updated: Array<[number, Row]> = [];
  runs: unknown = [];
  events: unknown = [];

  get_task(task_id: number): Row | null {
    return this.tasks.get(task_id) ?? null;
  }

  get_setting(key: string, defaultValue: string | null = null): string | null {
    return this.settings[key] ?? defaultValue;
  }

  set_setting(key: string, value: string): void {
    this.settings[key] = value;
  }

  update_task(task_id: number, updates: Record<string, unknown>): void {
    this.updated.push([task_id, updates]);
    this.tasks.set(task_id, {
      ...(this.tasks.get(task_id) ?? { id: task_id }),
      ...updates,
    });
  }

  get_task_runs(_task_id: number, _limit?: number): unknown {
    return this.runs;
  }

  get_run_output_events(_run_id: number, _limit?: number): unknown {
    return this.events;
  }
}

class StubScheduler implements WeixinScheduler {
  submitted: Task[] = [];

  submit_task(task: Task): number {
    this.submitted.push(task);
    return this.submitted.length;
  }
}

const originalHooks = { ..._hooks };
const originalDirHooks = { ...dirHooks };
const originalBridgeEnv = process.env.AGENTFORGE_WEIXIN_BRIDGE;

afterEach(() => {
  _hooks.spawn_bridge = originalHooks.spawn_bridge;
  _hooks.which = originalHooks.which;
  _hooks.path_exists = originalHooks.path_exists;
  _hooks.handle_dir_command = originalHooks.handle_dir_command;
  _hooks.handle_agent_command = originalHooks.handle_agent_command;
  dirHooks.extract_working_dir_with_claude =
    originalDirHooks.extract_working_dir_with_claude;
  if (originalBridgeEnv === undefined) {
    delete process.env.AGENTFORGE_WEIXIN_BRIDGE;
  } else {
    process.env.AGENTFORGE_WEIXIN_BRIDGE = originalBridgeEnv;
  }
});

function makeChannel(bridge_cmd: string[] | null = null) {
  const bus = new MessageBus();
  const db = new StubDB();
  const scheduler = new StubScheduler();
  const channel = new WeixinChannel(bus, db, scheduler, bridge_cmd);
  return { channel, bus, db, scheduler };
}

function fakeBridgeProcess(): WeixinBridgeProcess {
  return {
    stdin: { write: mock(() => undefined) },
    stdout: [],
    poll: mock(() => null),
    terminate: mock(() => undefined),
    wait: mock(() => undefined),
  };
}

function writtenCommands(proc: WeixinBridgeProcess): Row[] {
  const write = proc.stdin!.write as ReturnType<typeof mock>;
  return write.mock.calls.map((call) => JSON.parse(String(call[0]).trim()));
}

function writeImage(filePath: string, bytes: number[]): string {
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return fs.realpathSync(filePath);
}

async function withResolvedDir<T>(
  value: string,
  fn: () => Promise<T>,
): Promise<T> {
  dirHooks.extract_working_dir_with_claude = async () => value;
  return await fn();
}

describe("Weixin bridge startup", () => {
  test("finds Bun from hooks before common fallback paths", () => {
    _hooks.which = mock(() => "/opt/homebrew/bin/bun");
    _hooks.path_exists = mock(() => false);

    expect(_find_bun_executable()).toBe("/opt/homebrew/bin/bun");
  });

  test("finds Bun from common fallback paths and returns null when absent", () => {
    _hooks.which = mock(() => null);
    _hooks.path_exists = mock((candidate: string) =>
      candidate.endsWith(path.join(".bun", "bin", "bun")),
    );

    expect(_find_bun_executable()).toBe(
      path.join(os.homedir(), ".bun", "bin", "bun"),
    );

    _hooks.path_exists = mock(() => false);
    expect(_find_bun_executable()).toBeNull();
  });

  test("uses a packaged bridge binary override directly", () => {
    process.env.AGENTFORGE_WEIXIN_BRIDGE =
      "/Applications/AgentForge/Contents/Resources/weixin-bridge";

    const { channel } = makeChannel();

    expect(channel.bridge_cmd).toEqual([
      "/Applications/AgentForge/Contents/Resources/weixin-bridge",
    ]);
  });

  test("runs a script bridge override through Bun", () => {
    process.env.AGENTFORGE_WEIXIN_BRIDGE = "/tmp/weixin_bridge/index.ts";
    _hooks.which = mock(() => "/usr/local/bin/bun");
    _hooks.path_exists = mock(() => false);

    const { channel } = makeChannel();

    expect(channel.bridge_cmd).toEqual([
      "/usr/local/bin/bun",
      "/tmp/weixin_bridge/index.ts",
    ]);
  });

  test("start spawns the bridge with configured environment", async () => {
    const proc = fakeBridgeProcess();
    const spawn_bridge = mock((_cmd: string[], _env: Row) => proc);
    _hooks.spawn_bridge = spawn_bridge;

    const { channel, db } = makeChannel(["/tmp/weixin-bridge"]);
    db.settings["weixin_base_url"] = "https://weixin.example.test";
    db.settings["weixin_account_id"] = "account-1";

    channel.start();
    await channel._reader_promise;

    expect(spawn_bridge.mock.calls[0][0]).toEqual(["/tmp/weixin-bridge"]);
    expect(spawn_bridge.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        AGENTFORGE_WEIXIN_DATA_DIR: path.join(
          os.homedir(),
          ".agentforge",
          "weixin",
        ),
        AGENTFORGE_WEIXIN_BASE_URL: "https://weixin.example.test",
        AGENTFORGE_WEIXIN_ACCOUNT_ID: "account-1",
      }),
    );
    expect(channel._running).toBe(true);

    channel.stop();
    expect(proc.terminate).toHaveBeenCalledTimes(1);
  });

  test("start records missing Bun and generic bridge startup failures", () => {
    const missing: NodeJS.ErrnoException = new Error("missing");
    missing.code = "ENOENT";
    _hooks.spawn_bridge = mock(() => {
      throw missing;
    });

    const missingCase = makeChannel(["bun", "bridge.ts"]);
    missingCase.channel.start();

    expect(missingCase.channel._running).toBe(false);
    expect(missingCase.channel.get_status_snapshot()).toEqual(
      expect.objectContaining({
        login_status: "error",
        last_error: expect.stringContaining("Bun not found"),
      }),
    );

    _hooks.spawn_bridge = mock(() => {
      throw new Error("boom");
    });

    const genericCase = makeChannel(["/tmp/weixin-bridge"]);
    genericCase.channel.start();

    expect(genericCase.channel._running).toBe(false);
    expect(genericCase.channel.get_status_snapshot()).toEqual(
      expect.objectContaining({
        login_status: "error",
        last_error: expect.stringContaining("Failed to start Weixin bridge"),
      }),
    );
  });
});

describe("Weixin bridge events and commands", () => {
  test("bridge reader ignores noise and updates status for lifecycle events", async () => {
    const proc = fakeBridgeProcess();
    proc.stdout = [
      "\n",
      "not-json\n",
      JSON.stringify({
        type: "qr",
        qrcode_url: "https://qr.example",
        account_id: "acct-1",
      }) + "\n",
      JSON.stringify({ type: "scaned" }) + "\n",
      JSON.stringify({
        type: "login_success",
        account_id: "acct-2",
        user_id: "user-1",
      }) + "\n",
      JSON.stringify({ type: "ready", account_id: "acct-3" }) + "\n",
      JSON.stringify({ type: "logged_out" }) + "\n",
      JSON.stringify({ type: "error", message: "bridge down" }) + "\n",
    ];
    _hooks.spawn_bridge = mock(() => proc);

    const { channel } = makeChannel(["/tmp/weixin-bridge"]);
    channel.start();
    await channel._reader_promise;

    expect(channel.get_status_snapshot()).toEqual(
      expect.objectContaining({
        configured: false,
        login_status: "error",
        qr_code_url: "",
        account_id: "acct-3",
        user_id: "",
        last_error: "bridge down",
      }),
    );
  });

  test("sent events clear pending notification requests", () => {
    const { channel } = makeChannel();
    channel._pending_notifications.set("req-1", 42);

    channel._handle_sent_event({ request_id: "", message_id: "om_x" });
    channel._handle_sent_event({ request_id: "unknown", message_id: "om_x" });
    expect(channel._pending_notifications.has("req-1")).toBe(true);

    channel._handle_sent_event({ request_id: "req-1", message_id: "msg-1" });
    expect(channel._pending_notifications.has("req-1")).toBe(false);

    channel._pending_notifications.set("req-2", 43);
    channel._handle_sent_event({
      request_id: "req-2",
      quoted_message_id: "quote-1",
    });
    expect(channel._pending_notifications.has("req-2")).toBe(false);
  });

  test("request login and logout reset status and write bridge commands", () => {
    const proc = fakeBridgeProcess();
    const { channel } = makeChannel();
    channel._running = true;
    channel._bridge_proc = proc;
    channel._update_status({
      configured: true,
      login_status: "connected",
      qr_code_url: "qr",
      last_error: "old",
      user_id: "user-1",
    });

    channel.request_login();
    channel.request_logout();

    expect(writtenCommands(proc).map((cmd) => cmd["type"])).toEqual([
      "login",
      "logout",
    ]);
    expect(channel.get_status_snapshot()).toEqual(
      expect.objectContaining({
        configured: false,
        login_status: "idle",
        qr_code_url: "",
        last_error: "",
        user_id: "",
      }),
    );
  });

  test("send ignores inactive cases and emits completed and failed notifications", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-weixin-"));
    const image = writeImage(
      path.join(tmpDir, "generated.png"),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    const proc = fakeBridgeProcess();
    const { channel, db } = makeChannel();
    channel._bridge_proc = proc;
    db.tasks.set(7, {
      id: 7,
      title: "Render",
      working_dir: tmpDir,
    });
    db.tasks.set(8, { id: 8, title: "Broken" });
    db.runs = [{ id: 70 }];
    db.events = [
      { event_type: "generated_image", content: "{bad json" },
      {
        event_type: "generated_image",
        content: JSON.stringify({ path: image }),
      },
    ];

    try {
      channel.send(
        makeOutboundMessage({
          type: OutboundMessageType.TASK_COMPLETED,
          task_id: 7,
          payload: { title: "No origin", result: "ignored" },
        }),
      );
      expect(writtenCommands(proc)).toHaveLength(0);

      channel._running = true;
      channel.send(
        makeOutboundMessage({
          type: OutboundMessageType.TASK_STARTED,
          task_id: 7,
        }),
      );
      expect(writtenCommands(proc)).toHaveLength(0);

      channel._task_origin.set(7, {
        account_id: "acct",
        peer_id: "peer",
        context_token: "ctx",
        message_id: "origin-msg",
      });
      channel.send(
        makeOutboundMessage({
          type: OutboundMessageType.TASK_COMPLETED,
          task_id: 7,
          payload: {
            title: "Render",
            result: `Done\n- ${image}\n![out](${image})`,
          },
        }),
      );

      channel._task_origin.set(8, {
        account_id: "acct",
        peer_id: "peer",
        message_id: "origin-fail",
      });
      channel.send(
        makeOutboundMessage({
          type: OutboundMessageType.TASK_FAILED,
          task_id: 8,
          payload: { title: "Broken", error: "boom" },
        }),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const commands = writtenCommands(proc);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(
      expect.objectContaining({
        type: "send_message",
        account_id: "acct",
        peer_id: "peer",
        context_token: "ctx",
        image_paths: [image],
      }),
    );
    expect(commands[0]).not.toHaveProperty("reply_to_message_id");
    expect(commands[1]).not.toHaveProperty("reply_to_message_id");
    expect(commands[0]["text"]).not.toContain("Task #");
    expect(commands[0]["text"]).not.toContain("Render");
    expect(String(commands[0]["text"])).not.toStartWith("✅");
    expect(commands[0]["text"]).toContain("Done");
    expect(commands[0]["text"]).not.toContain(image);
    expect(commands[1]["text"]).not.toContain("Task #");
    expect(commands[1]["text"]).not.toContain("Broken");
    expect(commands[1]["text"]).toContain("❌");
    expect(commands[1]["text"]).toContain("boom");
    expect(channel._task_origin.has(7)).toBe(false);
    expect(channel._task_origin.has(8)).toBe(false);
  });
});

describe("Weixin inbound messages", () => {
  test("handles empty, new-session, dir, and agent command branches", async () => {
    const proc = fakeBridgeProcess();
    const { channel } = makeChannel();
    channel._running = true;
    channel._bridge_proc = proc;
    channel._set_peer_current_task("acct:peer", 99);

    await channel._handle_message_event({ text: "   " });
    expect(writtenCommands(proc)).toHaveLength(0);

    await channel._handle_message_event({
      text: "/new",
      account_id: "acct",
      peer_id: "peer",
      message_id: "msg-new",
    });
    await channel._handle_message_event({
      text: "/dir /tmp/project",
      account_id: "acct",
      peer_id: "peer",
      message_id: "msg-dir",
    });
    await channel._handle_message_event({
      text: "/agent llama",
      account_id: "acct",
      peer_id: "peer",
      message_id: "msg-agent",
    });

    const replies = writtenCommands(proc).map((cmd) => cmd["text"]);
    expect(replies[0]).toContain("新的 Weixin session");
    expect(replies[1]).toContain("Working directory set to: /tmp/project");
    expect(replies[2]).toContain("Unknown agent");
    expect(channel._get_peer_current_task("acct:peer")).toBeNull();
  });

  test("creates image tasks and resumes mapped sessions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-weixin-"));
    const image = writeImage(
      path.join(tmpDir, "inbound.jpg"),
      [0xff, 0xd8, 0xff, 0x00],
    );
    const proc = fakeBridgeProcess();
    const { channel, db, scheduler } = makeChannel();
    channel._running = true;
    channel._bridge_proc = proc;
    db.settings["default_agent"] = "claude";

    try {
      await withResolvedDir("/tmp/workspace", async () => {
        await channel._handle_message_event({
          image_paths: [image, image],
          account_id: "acct",
          peer_id: "peer",
          context_token: "ctx",
          message_id: "msg-img",
        });
      });

      expect(scheduler.submitted).toHaveLength(1);
      expect(scheduler.submitted[0]!.prompt).toBe("请分析这张图片。");
      expect(scheduler.submitted[0]!.working_dir).toBe("/tmp/workspace");
      expect(scheduler.submitted[0]!.agent).toBe("claude");
      expect(scheduler.submitted[0]!.prompt_images).toEqual([
        expect.objectContaining({
          name: "inbound.jpg",
          media_type: "image/jpeg",
        }),
      ]);
      expect(channel._task_origin.get(1)).toEqual({
        account_id: "acct",
        peer_id: "peer",
        context_token: "ctx",
        message_id: "msg-img",
      });
      expect(channel._get_peer_current_task("acct:peer")).toBe(1);

      db.tasks.set(1, {
        id: 1,
        session_id: "sess-1",
        status: "completed",
      });
      db.tasks.set(9, {
        id: 9,
        session_id: "sess-9",
        status: "completed",
      });
      await channel._handle_message_event({
        text: "continue",
        reply_to_message_id: "notice-1",
        account_id: "acct",
        peer_id: "peer",
        context_token: "ctx2",
        message_id: "msg-resume",
      });

      expect(db.updated[0]).toEqual([
        1,
        {
          status: "pending",
          prompt: "continue",
          result: null,
          error: null,
          question: null,
        },
      ]);
      expect(channel._task_origin.get(1)).toEqual({
        account_id: "acct",
        peer_id: "peer",
        context_token: "ctx2",
        message_id: "msg-resume",
      });
      expect(channel._task_origin.has(9)).toBe(false);
      expect(
        writtenCommands(proc).every(
          (cmd) => !String(cmd["text"]).includes("▶️"),
        ),
      ).toBe(true);

      db.tasks.set(12, { id: 12, status: "completed" });
      await channel._handle_message_event({
        text: "resume?",
        reply_to_message_title: "Task #12 finished",
        account_id: "acct",
        peer_id: "other-peer",
        message_id: "msg-no-session",
      });
      expect(scheduler.submitted).toHaveLength(2);
      expect(scheduler.submitted[1]!.prompt).toBe("resume?");
      expect(writtenCommands(proc).at(-1)?.["text"]).toBe("收到，正在处理。");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("new task and room-session resume replies do not expose task ids", async () => {
    const proc = fakeBridgeProcess();
    const { channel, db } = makeChannel();
    channel._running = true;
    channel._bridge_proc = proc;

    await channel._handle_message_event({
      text: "first",
      account_id: "acct",
      peer_id: "peer",
      message_id: "msg-first",
    });
    db.tasks.set(1, { id: 1, status: "completed", session_id: "s1" });
    await channel._handle_message_event({
      text: "follow up",
      account_id: "acct",
      peer_id: "peer",
      message_id: "msg-follow",
    });

    const replies = writtenCommands(proc).map((cmd) => String(cmd["text"]));
    expect(replies[0]).not.toContain("Task #");
    expect(replies[1]).not.toContain("Task #");
    expect(replies[1]).not.toContain("▶️");
  });

  test("room-session resume survives channel restart", async () => {
    const proc = fakeBridgeProcess();
    const bus = new MessageBus();
    const db = new StubDB();
    const firstScheduler = new StubScheduler();
    const first = new WeixinChannel(bus, db, firstScheduler);
    first._running = true;
    first._bridge_proc = proc;

    await first._handle_message_event({
      text: "first",
      account_id: "acct",
      peer_id: "peer",
      message_id: "msg-first",
    });
    db.tasks.set(1, { id: 1, status: "completed", session_id: "s1" });

    const restartedScheduler = new StubScheduler();
    const restarted = new WeixinChannel(bus, db, restartedScheduler);
    restarted._running = true;
    restarted._bridge_proc = proc;
    await restarted._handle_message_event({
      text: "after restart",
      account_id: "acct",
      peer_id: "peer",
      message_id: "msg-follow",
    });

    expect(restartedScheduler.submitted).toHaveLength(0);
    expect(db.updated.at(-1)).toEqual([
      1,
      {
        status: "pending",
        prompt: "after restart",
        result: null,
        error: null,
        question: null,
      },
    ]);
    expect(restarted._task_origin.get(1)).toEqual({
      account_id: "acct",
      peer_id: "peer",
      context_token: "",
      message_id: "msg-follow",
    });
  });
});

describe("Weixin image and task-output helpers", () => {
  test("extracts inbound image paths, prompt images, and media types", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-weixin-"));
    const png = writeImage(
      path.join(tmpDir, "a.png"),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    const jpg = writeImage(
      path.join(tmpDir, "b.unknown"),
      [0xff, 0xd8, 0xff, 0x00],
    );
    const gif = writeImage(
      path.join(tmpDir, "c.gif"),
      [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    );
    const webp = writeImage(
      path.join(tmpDir, "d.webp"),
      [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
    );
    const missing = path.join(tmpDir, "missing.png");
    const { channel } = makeChannel();

    try {
      expect(
        channel._extract_image_paths({
          image_paths: [png, png, "", missing],
          images: [{ path: gif }, { local_path: webp }, "bad"],
        }),
      ).toEqual([png, gif, webp]);
      expect(channel._default_image_prompt([png])).toBe("请分析这张图片。");
      expect(channel._default_image_prompt([png, gif])).toBe(
        "请分析这 2 张图片。",
      );
      expect(channel._build_resume_updates("", [png])).toEqual(
        expect.objectContaining({
          status: "pending",
          prompt: "请分析这张图片。",
          image_paths: JSON.stringify([png]),
        }),
      );
      expect(channel._build_prompt_images([png, missing])).toEqual([
        expect.objectContaining({
          name: "a.png",
          media_type: "image/png",
        }),
      ]);
      expect(channel._image_media_type(png)).toBe("image/png");
      expect(channel._image_media_type(jpg)).toBe("image/jpeg");
      expect(channel._image_media_type(gif)).toBe("image/gif");
      expect(channel._image_media_type(webp)).toBe("image/webp");
      expect(channel._image_media_type(path.join(tmpDir, "missing"))).toBe(
        "image/jpeg",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("collects generated images from DB events and markdown references", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-weixin-"));
    const fromEvent = writeImage(
      path.join(tmpDir, "event.png"),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    const fromMarkdown = writeImage(
      path.join(tmpDir, "markdown.png"),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    const { channel, db } = makeChannel();
    db.runs = [{ id: 101 }];
    db.events = [
      { event_type: "assistant", content: "skip" },
      { event_type: "generated_image", content: "bad json" },
      {
        event_type: "generated_image",
        content: JSON.stringify({ path: fromEvent }),
      },
      {
        event_type: "generated_image",
        content: JSON.stringify({ path: fromEvent }),
      },
    ];

    try {
      expect(
        channel._collect_generated_image_paths(
          5,
          `![local](markdown.png)\n![remote](https://example.test/x.png)`,
          { working_dir: tmpDir },
        ),
      ).toEqual([fromEvent, fromMarkdown]);
      expect(
        channel._generated_image_paths_from_markdown("![x](data:abc)"),
      ).toEqual([]);

      db.runs = [];
      expect(channel._generated_image_paths_for_task(5)).toEqual([]);

      db.runs = [{ id: 101 }];
      db.get_run_output_events = mock(() => {
        throw new Error("events down");
      }) as any;
      expect(channel._generated_image_paths_for_task(5)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("normalizes markdown references and hides uploaded image paths", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-weixin-"));
    const image = writeImage(
      path.join(tmpDir, "space image.png"),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    const relative = path.basename(image).replace(" ", "%20");
    const { channel } = makeChannel();

    try {
      expect(
        channel._markdown_image_reference_target(`<${image}> "title"`),
      ).toBe(image);
      expect(channel._markdown_image_reference_target(`'${image}'`)).toBe(
        image,
      );
      expect(
        channel._local_image_path_from_reference("https://x/y.png"),
      ).toBeNull();
      expect(channel._local_image_path_from_reference(`file://${image}`)).toBe(
        image,
      );
      expect(channel._local_image_path_from_reference(`sandbox:${image}`)).toBe(
        image,
      );
      expect(channel._local_image_path_from_reference(relative, tmpDir)).toBe(
        image,
      );
      expect(channel._dedupe_image_paths([image, image, "/nope.txt"])).toEqual([
        image,
      ]);
      expect(
        channel._line_is_uploaded_image_path(`- ${image}`, new Set([image])),
      ).toBe(true);
      expect(
        channel._line_is_uploaded_image_path(
          "- /tmp/.codex/generated_images/x.png",
          new Set(),
        ),
      ).toBe(true);
      expect(
        channel._remove_uploaded_markdown_image_refs(
          `keep ![x](${image}) text`,
          new Set([image]),
        ),
      ).toBe("keep  text");
      expect(
        channel._hide_generated_image_paths(
          `Done\n- ${image}\n![x](${image})\n-`,
          1,
          [image],
        ),
      ).toBe("Done");
      expect(channel._hide_generated_image_paths("已生成图片", 2, [])).toBe(
        "已生成 2 张图片。",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("reply and send command handle missing peers and missing bridge", () => {
    const proc = fakeBridgeProcess();
    const { channel } = makeChannel();

    channel._reply_to_event({ message_id: "no-peer" }, "ignored");
    expect(writtenCommands(proc)).toHaveLength(0);

    channel._bridge_proc = proc;
    channel._reply_to_event(
      {
        from_user_id: "user-1",
        account_id: "acct",
        context_token: "ctx",
        message_id: "msg-1",
      },
      "hello",
    );
    channel._bridge_proc = null;
    channel._send_command({ type: "dropped" });

    expect(writtenCommands(proc)).toEqual([
      expect.objectContaining({
        type: "send_message",
        account_id: "acct",
        peer_id: "user-1",
        context_token: "ctx",
        text: "hello",
      }),
    ]);
    expect(writtenCommands(proc)[0]).not.toHaveProperty("reply_to_message_id");
  });
});
