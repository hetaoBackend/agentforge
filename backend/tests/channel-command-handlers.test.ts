// Shared channel command flows: briefs, runbooks, and skill suggestions.
//
// These three flows used to be written out once per channel, so the only way
// to exercise them was to drive a whole Feishu/Slack/Telegram/WeChat channel.
// Now that they live behind `ChannelCommandContext`, a stub context reaches
// every branch directly — including the ones the channel tests never hit.
//
// What these tests pin down is the contract the four channels rely on: which
// InboundMessageType each flow raises, what goes on the payload, which text
// comes back, and which side of the seam owns the reply.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { InboundMessageType, type InboundMessage } from "../src/bus.ts";
import { DEFAULT_AGENT } from "../src/channels/agent_utils.ts";
import {
  format_brief_created_reply,
  format_brief_discarded_reply,
  format_brief_help,
  format_brief_started_reply,
  format_runbook_brief_reply,
  format_runbook_created_reply,
  format_skill_suggestion_help,
} from "../src/channels/brief_utils.ts";
import {
  handle_brief_command,
  handle_runbook_command,
  handle_skill_suggestion_command,
  type TaskCommandContext,
} from "../src/channels/command_handlers.ts";
import { _hooks as dirHooks } from "../src/channels/dir_utils.ts";

type Row = Record<string, unknown>;

const _original_extract = dirHooks.extract_working_dir_with_claude;
beforeEach(() => {
  dirHooks.extract_working_dir_with_claude = async () => null;
});
afterEach(() => {
  dirHooks.extract_working_dir_with_claude = _original_extract;
});

interface Recorder {
  ctx: TaskCommandContext;
  replies: string[];
  started: Array<[number, string]>;
  raised: InboundMessage[];
}

/**
 * Build a context whose every outward effect is recorded.
 *
 * `result` is what the stub scheduler hands back; passing a function instead
 * lets a test throw from inside the dispatch.
 */
function makeCtx(
  result: Row | (() => Row) = {},
  opts: { settings?: Record<string, string>; prefix?: string } = {},
): Recorder {
  const replies: string[] = [];
  const started: Array<[number, string]> = [];
  const raised: InboundMessage[] = [];
  const settings = opts.settings ?? {};

  // A method, not an arrow: it must still see `this` once the shared code
  // has pulled it off the scheduler.
  const scheduler = {
    seen: raised,
    handle_inbound_message(msg: InboundMessage): Row {
      this.seen.push(msg);
      return typeof result === "function" ? result() : result;
    },
  };

  const ctx: TaskCommandContext = {
    channel: "stubchan",
    db: {
      get_setting: (key: string, dflt: string | null = null) =>
        settings[key] ?? dflt,
      set_setting: (key: string, value: string) => {
        settings[key] = value;
      },
    },
    scheduler,
    make_inbound: (msg_type, payload, reply_to, metadata) =>
      ({
        type: msg_type,
        payload,
        reply_to,
        metadata,
      }) as unknown as InboundMessage,
    error_prefix: opts.prefix ?? "❌",
    metadata: { origin: "unit" },
    target: "peer-1",
    source_ref: "msg-9",
    reply: (text: string) => {
      replies.push(text);
    },
    on_task_started: (task_id: number, announcement: string) => {
      started.push([task_id, announcement]);
    },
  };
  return { ctx, replies, started, raised };
}

describe("shared brief command flow", () => {
  test("help replies without reaching the scheduler", async () => {
    const r = makeCtx();
    await handle_brief_command(r.ctx, {
      action: "help",
      reason: "invalid_brief_id",
    });
    expect(r.replies).toEqual([format_brief_help("invalid_brief_id")]);
    expect(r.raised).toHaveLength(0);
  });

  test("a scheduler without the inbound flow is reported", async () => {
    const r = makeCtx();
    r.ctx.scheduler = {};
    await handle_brief_command(r.ctx, { action: "create", goal: "ship it" });
    expect(r.replies).toEqual([
      "❌ Draft task flow is not available in this scheduler.",
    ]);
    expect(r.raised).toHaveLength(0);
  });

  test("create raises CREATE_BRIEF with resolved dir and agent", async () => {
    const r = makeCtx(
      { brief_id: 12 },
      { settings: { stubchan_default_working_dir: "/w", default_agent: "cx" } },
    );
    await handle_brief_command(r.ctx, { action: "create", goal: "ship it" });

    expect(r.raised).toHaveLength(1);
    const msg = r.raised[0]!;
    expect(msg.type).toBe(InboundMessageType.CREATE_BRIEF);
    expect(msg.reply_to).toBe("peer-1");
    expect(msg.metadata).toEqual({ origin: "unit" });
    const payload = msg.payload as Row;
    expect(payload["goal"]).toBe("ship it");
    expect(payload["source_channel"]).toBe("stubchan");
    expect(payload["source_ref"]).toBe("msg-9");
    expect(payload["source_metadata"]).toEqual({ origin: "unit" });
    expect(payload["working_dir"]).toBe("/w");
    expect(payload["agent"]).toBe("cx");
    expect(r.replies).toEqual([
      format_brief_created_reply(12, String(payload["title"])),
    ]);
  });

  test("create falls back to ~ and the default agent", async () => {
    const r = makeCtx({ brief_id: 1 });
    await handle_brief_command(r.ctx, { action: "create", goal: "go" });
    const payload = r.raised[0]!.payload as Row;
    expect(payload["working_dir"]).toBe("~");
    expect(payload["agent"]).toBe(DEFAULT_AGENT);
  });

  test("confirm hands the announcement to on_task_started", async () => {
    const r = makeCtx({ task_id: 44 });
    await handle_brief_command(r.ctx, { action: "confirm", brief_id: 5 });

    expect(r.raised[0]!.type).toBe(InboundMessageType.CONFIRM_BRIEF);
    expect(r.raised[0]!.payload).toEqual({ brief_id: 5 });
    // The shared code must not reply itself — Feishu streams into a card.
    expect(r.replies).toEqual([]);
    expect(r.started).toEqual([[44, format_brief_started_reply(5, 44)]]);
  });

  test.each([
    ["zero", { task_id: 0 }],
    ["negative", { task_id: -1 }],
    ["fractional", { task_id: 1.5 }],
    ["absent", {}],
  ])("confirm rejects a %s task id", async (_label, result) => {
    const r = makeCtx(result);
    await handle_brief_command(r.ctx, { action: "confirm", brief_id: 5 });
    expect(r.replies).toEqual(["❌ Draft task confirmation failed."]);
    expect(r.started).toEqual([]);
  });

  test("discard raises DISCARD_BRIEF and echoes the id", async () => {
    const r = makeCtx({ brief_id: 8 });
    await handle_brief_command(r.ctx, { action: "discard", brief_id: 8 });
    expect(r.raised[0]!.type).toBe(InboundMessageType.DISCARD_BRIEF);
    expect(r.replies).toEqual([format_brief_discarded_reply(8)]);
  });

  test("a thrown error comes back behind the channel's prefix", async () => {
    const r = makeCtx(
      () => {
        throw new Error("db down");
      },
      { prefix: ":x:" },
    );
    await handle_brief_command(r.ctx, { action: "discard", brief_id: 3 });
    expect(r.replies).toEqual([":x: db down"]);
  });
});

describe("shared runbook command flow", () => {
  const cmd = { name: "deploy", args: [], raw_args: "prod" };

  test("a scheduler without the inbound flow is reported", async () => {
    const r = makeCtx();
    r.ctx.scheduler = {};
    await handle_runbook_command(r.ctx, cmd);
    expect(r.replies).toEqual([
      "❌ Custom command flow is not available in this scheduler.",
    ]);
  });

  test("created hands the announcement to on_task_started", async () => {
    const r = makeCtx({ status: "created", task_id: 71 });
    await handle_runbook_command(r.ctx, cmd);

    const msg = r.raised[0]!;
    expect(msg.type).toBe(InboundMessageType.RUN_RUNBOOK);
    const payload = msg.payload as Row;
    expect(payload["name"]).toBe("deploy");
    expect(payload["raw_args"]).toBe("prod");
    expect(payload["source_ref"]).toBe("msg-9");
    expect(r.replies).toEqual([]);
    expect(r.started).toEqual([
      [71, format_runbook_created_reply(71, "deploy")],
    ]);
  });

  test("the working dir is resolved from raw_args, then the name", async () => {
    const seen: string[] = [];
    dirHooks.extract_working_dir_with_claude = async (prompt: string) => {
      seen.push(prompt);
      return null;
    };
    const r = makeCtx({ status: "created", task_id: 1 });
    await handle_runbook_command(r.ctx, cmd);
    await handle_runbook_command(r.ctx, { ...cmd, raw_args: "" });
    expect(seen).toEqual(["prod", "deploy"]);
  });

  test("draft replies instead of starting a task", async () => {
    const r = makeCtx({ status: "draft", brief_id: 22 });
    await handle_runbook_command(r.ctx, cmd);
    expect(r.replies).toEqual([format_runbook_brief_reply(22, "deploy")]);
    expect(r.started).toEqual([]);
  });

  test("any other status is a failure", async () => {
    const r = makeCtx({ status: "rejected" });
    await handle_runbook_command(r.ctx, cmd);
    expect(r.replies).toEqual(["❌ Custom command failed."]);
  });

  test("a thrown error comes back behind the prefix", async () => {
    const r = makeCtx(() => {
      throw new Error("nope");
    });
    await handle_runbook_command(r.ctx, cmd);
    expect(r.replies).toEqual(["❌ nope"]);
  });
});

describe("shared skill suggestion flow", () => {
  test("help replies without reaching the scheduler", async () => {
    const r = makeCtx();
    await handle_skill_suggestion_command(r.ctx, {
      action: "help",
      reason: "invalid_pattern_id",
    });
    expect(r.replies).toEqual([
      format_skill_suggestion_help("invalid_pattern_id"),
    ]);
    expect(r.raised).toHaveLength(0);
  });

  test("a scheduler without the inbound flow is reported", async () => {
    const r = makeCtx();
    r.ctx.scheduler = {};
    await handle_skill_suggestion_command(r.ctx, {
      action: "approve",
      pattern_id: 4,
    });
    expect(r.replies).toEqual([
      "❌ Skill suggestion flow is not available in this scheduler.",
    ]);
  });

  test("the action payload carries the channel, target and metadata", async () => {
    const r = makeCtx({ status: "approved", pattern_id: 4 });
    await handle_skill_suggestion_command(r.ctx, {
      action: "approve",
      pattern_id: 4,
    });

    const msg = r.raised[0]!;
    expect(msg.type).toBe(InboundMessageType.SKILL_SUGGESTION_ACTION);
    expect(msg.payload).toEqual({
      action: "approve",
      pattern_id: 4,
      source_channel: "stubchan",
      target: "peer-1",
      source_metadata: { origin: "unit" },
    });
    expect(r.replies).toHaveLength(1);
  });

  test("a thrown error comes back behind the prefix", async () => {
    const r = makeCtx(
      () => {
        throw new Error("boom");
      },
      { prefix: ":x:" },
    );
    await handle_skill_suggestion_command(r.ctx, {
      action: "dismiss",
      pattern_id: 1,
    });
    expect(r.replies).toEqual([":x: boom"]);
  });

  test("a non-Error throw is stringified", async () => {
    const r = makeCtx(() => {
      throw "plain string";
    });
    await handle_skill_suggestion_command(r.ctx, {
      action: "show",
      pattern_id: 2,
    });
    expect(r.replies).toEqual(["❌ plain string"]);
  });
});

describe("scheduler receiver", () => {
  // The shared code lifts handle_inbound_message off the scheduler to narrow
  // it. Lifting it unbound would break any scheduler whose implementation
  // touches `this` — which is why it is bound back on the way out.
  test("handle_inbound_message keeps its receiver", async () => {
    const r = makeCtx({ brief_id: 1 });
    await handle_brief_command(r.ctx, { action: "discard", brief_id: 1 });
    expect(r.raised).toHaveLength(1);
  });
});
