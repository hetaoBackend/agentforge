import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { CronExpressionParser } from "cron-parser";

import { InboundMessageType, MessageBus, makeInboundMessage } from "./bus.ts";
import {
  parse_im_digest_recipients,
  type IMDigestRecipient,
} from "./digests.ts";
import {
  collect_im_skill_suggestions,
  render_im_skill_suggestion_text,
} from "./skill_suggestions.ts";
import type { TaskDB } from "./db.ts";
import type { TaskScheduler } from "./scheduler.ts";
import { runbook_from_row, type RunbookDefinition } from "./runbooks.ts";
import {
  DEFAULT_AGENT,
  DEFAULT_TIMEOUT_SECONDS,
  HeartbeatScheduleType,
  RunbookConfirmationPolicy,
  RunbookSourceType,
  ScheduleType,
  TaskBriefStatus,
  makeHeartbeat,
  makeIMRunbook,
  makeTask,
  makeTaskBrief,
  type Heartbeat,
  type IMRunbook,
  type Task,
  type TaskBrief,
} from "./types.ts";
import { dateToLocalIso } from "./util.ts";
import { FeishuChannel } from "./channels/feishu.ts";
import { SlackChannel } from "./channels/slack.ts";
import {
  create_telegram_channel,
  type TelegramChannel,
} from "./channels/telegram.ts";
import { WeixinChannel } from "./channels/weixin.ts";

type Row = Record<string, any>;

export interface ApiContext {
  db: TaskDB;
  scheduler: TaskScheduler;
  bus: MessageBus;
  telegram_channel: TelegramChannel | null;
  slack_channel: SlackChannel | null;
  weixin_channel: WeixinChannel | null;
  feishu_channel: FeishuChannel | null;
}

const CSRF_TOKEN = crypto.randomBytes(32).toString("hex");
const MAX_BODY_SIZE = 10 * 1024 * 1024;

function isAllowedOrigin(origin: string): boolean {
  if (origin === "null") return true;
  if (!origin) return true;
  return (
    origin === "http://localhost" || origin.startsWith("http://localhost:")
  );
}

function corsHeaders(origin: string): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token",
  });
  if (isAllowedOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

function jsonResponse(data: unknown, status = 200, origin = ""): Response {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { status, headers });
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function checkCsrf(req: Request): boolean {
  const origin = req.headers.get("Origin") ?? "";
  if (!origin) return true;
  return timingSafeEqual(req.headers.get("X-CSRF-Token") ?? "", CSRF_TOKEN);
}

async function readJsonBody(
  req: Request,
  origin: string,
): Promise<Row | Response> {
  const rawLength = req.headers.get("Content-Length") ?? "0";
  const length = Number.parseInt(rawLength, 10) || 0;
  if (length > MAX_BODY_SIZE) {
    void req.body?.cancel();
    return jsonResponse({ error: "request body too large" }, 413, origin);
  }
  const raw = await req.text();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Row;
    }
    return {};
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, origin);
  }
}

function idAt(path: string, index = 3): number | null {
  const raw = path.split("/")[index];
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return Boolean(value);
}

function asString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function slugifyCommandName(value: string): string {
  const compact = value.trim().replace(/\s+/g, "-").replace(/^\/+/, "");
  const ascii = compact
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || compact || "custom-command";
}

function parseJsonList(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asStringList(value: unknown): string[] {
  return parseJsonList(value)
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function parseJsonObject(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Row;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Row;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function cronValid(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

function cronNextIso(expr: string): string {
  return dateToLocalIso(CronExpressionParser.parse(expr).next().toDate());
}

function ensureWorkingDir(
  workingDir: string,
  missingMessage: string,
): Row | null {
  if (workingDir && workingDir !== ".") {
    const expanded =
      workingDir === "~"
        ? os.homedir()
        : workingDir.replace(/^~\//, `${os.homedir()}/`);
    if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) {
      return { error: missingMessage, field: "working_dir" };
    }
  }
  return null;
}

function dependencyList(
  value: unknown,
  forceInject = false,
): Array<{ task_id: number; inject_result: boolean }> {
  const deps: Array<{ task_id: number; inject_result: boolean }> = [];
  if (!Array.isArray(value)) return deps;
  for (const item of value) {
    if (Number.isInteger(item)) {
      deps.push({ task_id: item, inject_result: forceInject });
    } else if (item && typeof item === "object" && "task_id" in item) {
      deps.push({
        task_id: Number((item as Row)["task_id"]),
        inject_result: forceInject || Boolean((item as Row)["inject_result"]),
      });
    }
  }
  return deps.filter((d) => Number.isInteger(d.task_id));
}

function attachDependencyMetadata(db: TaskDB, task: Row): Row {
  const tid = Number(task["id"]);
  return {
    ...task,
    dependencies: db.get_dependencies(tid),
    dependents: db.get_dependents(tid).map((d) => d["task_id"]),
  };
}

function validateTaskBriefPayload(
  body: Row,
  existing: Row | null = null,
): { brief?: TaskBrief; response?: ResponseData } {
  const title = asString(body["title"] ?? existing?.["title"]).trim();
  if (!title) {
    return {
      response: [{ error: "title cannot be empty", field: "title" }, 400],
    };
  }
  const goal = asString(body["goal"] ?? existing?.["goal"]).trim();
  if (!goal) {
    return {
      response: [{ error: "goal cannot be empty", field: "goal" }, 400],
    };
  }
  const sourceChannel = asString(
    body["source_channel"] ?? existing?.["source_channel"],
  ).trim();
  if (!sourceChannel) {
    return {
      response: [
        { error: "source_channel cannot be empty", field: "source_channel" },
        400,
      ],
    };
  }
  const sourceRef = asString(body["source_ref"] ?? existing?.["source_ref"])
    .trim()
    .slice(0, 1000);
  if (!sourceRef) {
    return {
      response: [
        { error: "source_ref cannot be empty", field: "source_ref" },
        400,
      ],
    };
  }

  const acceptanceCriteria =
    "acceptance_criteria" in body
      ? asStringList(body["acceptance_criteria"])
      : Array.isArray(existing?.["acceptance_criteria"])
        ? existing["acceptance_criteria"].map(String)
        : [];
  const sourceMetadata =
    "source_metadata" in body
      ? parseJsonObject(body["source_metadata"])
      : parseJsonObject(existing?.["source_metadata"] ?? {});

  const workingDirRaw =
    body["working_dir"] ?? existing?.["working_dir"] ?? null;
  const workingDir =
    workingDirRaw === null || workingDirRaw === undefined
      ? null
      : asString(workingDirRaw).trim() || null;

  return {
    brief: makeTaskBrief({
      id: existing?.["id"] ?? null,
      status: asString(
        body["status"] ?? existing?.["status"] ?? TaskBriefStatus.DRAFT,
      ) as TaskBrief["status"],
      title,
      goal,
      context_summary: asString(
        body["context_summary"] ?? existing?.["context_summary"] ?? "",
      ),
      acceptance_criteria: acceptanceCriteria,
      working_dir: workingDir,
      working_dir_confidence: asString(
        body["working_dir_confidence"] ??
          existing?.["working_dir_confidence"] ??
          "unknown",
      ),
      agent:
        body["agent"] === null
          ? null
          : asString(body["agent"] ?? existing?.["agent"] ?? "") || null,
      risk_level: asString(
        body["risk_level"] ?? existing?.["risk_level"] ?? "normal",
      ),
      needs_confirmation: asBool(
        body["needs_confirmation"] ?? existing?.["needs_confirmation"] ?? true,
      ),
      source_channel: sourceChannel,
      source_ref: sourceRef,
      source_metadata: sourceMetadata,
      created_task_id: existing?.["created_task_id"] ?? null,
      created_at: existing?.["created_at"] ?? null,
      updated_at: existing?.["updated_at"] ?? null,
      expires_at:
        body["expires_at"] === null
          ? null
          : asString(body["expires_at"] ?? existing?.["expires_at"] ?? "") ||
            null,
    }),
  };
}

function validateIMRunbookPayload(
  body: Row,
  existing: Row | null = null,
): { runbook?: IMRunbook; response?: ResponseData } {
  const name = asString(body["name"] ?? existing?.["name"])
    .trim()
    .toLowerCase();
  if (!name) {
    return {
      response: [{ error: "name cannot be empty", field: "name" }, 400],
    };
  }
  if (!/^[^\s/@]+$/u.test(name)) {
    return {
      response: [
        {
          error:
            "name must be a single slash-command word without spaces, slashes, or bot mentions",
          field: "name",
        },
        400,
      ],
    };
  }

  const promptTemplate = asString(
    body["prompt_template"] ?? existing?.["prompt_template"],
  );
  if (!promptTemplate.trim()) {
    return {
      response: [
        { error: "prompt_template cannot be empty", field: "prompt_template" },
        400,
      ],
    };
  }

  const sourceType = asString(
    body["source_type"] ??
      existing?.["source_type"] ??
      RunbookSourceType.TEMPLATE,
  );
  if (!Object.values(RunbookSourceType).includes(sourceType as any)) {
    return {
      response: [{ error: "invalid source_type", field: "source_type" }, 400],
    };
  }

  const confirmationPolicy = asString(
    body["confirmation_policy"] ??
      existing?.["confirmation_policy"] ??
      RunbookConfirmationPolicy.REQUIRED,
  );
  if (
    !Object.values(RunbookConfirmationPolicy).includes(
      confirmationPolicy as any,
    )
  ) {
    return {
      response: [
        {
          error: "invalid confirmation_policy",
          field: "confirmation_policy",
        },
        400,
      ],
    };
  }

  return {
    runbook: makeIMRunbook({
      id: existing?.["id"] ?? null,
      name,
      aliases:
        "aliases" in body
          ? asStringList(body["aliases"]).map((alias) => alias.toLowerCase())
          : Array.isArray(existing?.["aliases"])
            ? existing["aliases"].map((alias: unknown) =>
                String(alias).toLowerCase(),
              )
            : [],
      description: asString(
        body["description"] ?? existing?.["description"] ?? "",
      ),
      source_type: sourceType as IMRunbook["source_type"],
      source_id:
        body["source_id"] === null
          ? null
          : asString(body["source_id"] ?? existing?.["source_id"] ?? "") ||
            null,
      command_schema:
        "command_schema" in body
          ? parseJsonObject(body["command_schema"])
          : parseJsonObject(existing?.["command_schema"] ?? {}),
      prompt_template: promptTemplate,
      default_agent:
        body["default_agent"] === null
          ? null
          : asString(
              body["default_agent"] ?? existing?.["default_agent"] ?? "",
            ) || null,
      confirmation_policy:
        confirmationPolicy as IMRunbook["confirmation_policy"],
      enabled: asBool(body["enabled"] ?? existing?.["enabled"] ?? true),
      created_at: existing?.["created_at"] ?? null,
      updated_at: existing?.["updated_at"] ?? null,
    }),
  };
}

function commandFromTaskPayload(
  ctx: ApiContext,
  body: Row,
): { runbook?: IMRunbook; response?: ResponseData } {
  const taskId = Number(body["task_id"]);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return {
      response: [{ error: "task_id is required", field: "task_id" }, 400],
    };
  }
  const task = ctx.db.get_task(taskId);
  if (!task) {
    return { response: [{ error: "task not found" }, 404] };
  }

  const title = asString(task["title"] ?? "Custom command").trim();
  const prompt = asString(task["prompt"] ?? "").trim();
  const description =
    asString(body["description"]).trim() ||
    title.replace(/^\[[^\]]+\]\s*/, "") ||
    "Custom AgentForge command";
  const name = asString(body["name"]).trim() || slugifyCommandName(description);
  const promptTemplate = [
    "Repeat this AgentForge workflow with the user's latest input.",
    "",
    "Original task title:",
    title,
    "",
    "Original task prompt:",
    prompt || "(no prompt recorded)",
    "",
    "Latest input:",
    "{{raw_args}}",
  ].join("\n");

  return validateIMRunbookPayload({
    name,
    aliases: body["aliases"] ?? [],
    description,
    source_type: RunbookSourceType.TASK,
    source_id: String(taskId),
    command_schema: body["command_schema"] ?? { args: [] },
    prompt_template: promptTemplate,
    default_agent:
      body["default_agent"] === undefined
        ? task["agent"]
        : body["default_agent"],
    confirmation_policy:
      body["confirmation_policy"] ?? RunbookConfirmationPolicy.REQUIRED,
    enabled: body["enabled"] ?? true,
  });
}

function runbookResponse(runbook: RunbookDefinition, extras: Row = {}): Row {
  return {
    id: null,
    name: runbook.name,
    aliases: runbook.aliases,
    description: runbook.description,
    source_type: runbook.source_type,
    source_id: runbook.source_id,
    command_schema: runbook.command_schema,
    prompt_template: runbook.prompt_template,
    default_agent: runbook.default_agent,
    confirmation_policy: runbook.confirmation_policy,
    enabled: runbook.enabled,
    created_at: null,
    updated_at: null,
    ...extras,
  };
}

function allIMRunbooks(ctx: ApiContext): Row[] {
  return ctx.db
    .get_im_runbooks()
    .map((row) => runbookResponse(runbook_from_row(row), row));
}

function digestPayload(body: Row): Row {
  return {
    include_empty: asBool(body["include_empty"] ?? false),
    limit:
      body["limit"] === undefined || body["limit"] === null
        ? undefined
        : Number(body["limit"]),
    since:
      body["since"] === undefined || body["since"] === null
        ? null
        : asString(body["since"]),
  };
}

function triggerDigest(ctx: ApiContext, body: Row): Row {
  return ctx.scheduler.handle_inbound_message(
    makeInboundMessage({
      type: InboundMessageType.TRIGGER_DIGEST,
      source: "api",
      payload: digestPayload(body),
    }),
  );
}

function digestRecipients(ctx: ApiContext, body: Row): IMDigestRecipient[] {
  if ("recipients" in body) {
    return parse_im_digest_recipients(body["recipients"]);
  }
  return parse_im_digest_recipients(
    ctx.db.get_setting("im_digest_channels", "[]"),
  );
}

function skillSuggestionRecipients(
  ctx: ApiContext,
  body: Row,
): IMDigestRecipient[] {
  if ("recipients" in body) {
    return parse_im_digest_recipients(body["recipients"]);
  }
  return parse_im_digest_recipients(
    ctx.db.get_setting("im_skill_suggestion_channels", "[]"),
  );
}

function skillSuggestionPreview(ctx: ApiContext, body: Row): Row {
  const channel = asString(body["channel"]).trim() || null;
  const limit =
    body["limit"] === undefined || body["limit"] === null
      ? undefined
      : Number(body["limit"]);
  const suggestions = collect_im_skill_suggestions(ctx.db, {
    channel,
    limit,
  });
  return {
    suggestions,
    texts: suggestions.map((suggestion) =>
      render_im_skill_suggestion_text(suggestion),
    ),
  };
}

async function sendIMDigest(
  ctx: ApiContext,
  recipient: IMDigestRecipient,
  text: string,
): Promise<void> {
  if (recipient.channel === "slack") {
    const channel = ctx.slack_channel as any;
    if (!channel?._reply) throw new Error("slack channel is not running");
    await channel._reply(recipient.target, null, text);
    return;
  }
  if (recipient.channel === "feishu") {
    const channel = ctx.feishu_channel as any;
    if (!channel?._send_message)
      throw new Error("feishu channel is not running");
    await channel._send_message(recipient.target, text);
    return;
  }
  if (recipient.channel === "telegram") {
    const channel = ctx.telegram_channel as any;
    if (!channel?._api) throw new Error("telegram channel is not running");
    await channel._api("sendMessage", {
      chat_id: recipient.target,
      text,
    });
    return;
  }
  if (recipient.channel === "weixin") {
    const channel = ctx.weixin_channel as any;
    if (!channel?._reply_to_event)
      throw new Error("weixin channel is not running");
    channel._reply_to_event({ peer_id: recipient.target }, text);
    return;
  }
  throw new Error(`unsupported digest channel: ${recipient.channel}`);
}

function taskPromptFromBrief(brief: Row): string {
  const lines = ["Goal:", String(brief["goal"]).trim()];
  const context = String(brief["context_summary"] ?? "").trim();
  if (context) {
    lines.push("", "Context:", context);
  }
  const criteria = Array.isArray(brief["acceptance_criteria"])
    ? brief["acceptance_criteria"].map(String).filter(Boolean)
    : [];
  if (criteria.length) {
    lines.push("", "Acceptance criteria:");
    criteria.forEach((criterion, index) => {
      lines.push(`${index + 1}. ${criterion}`);
    });
  }
  return lines.join("\n");
}

function taskFromBrief(ctx: ApiContext, brief: Row): Task {
  const sourceChannel = String(brief["source_channel"] ?? "").trim();
  const tags = ["im-inbox", sourceChannel].filter(Boolean).join(",");
  return makeTask({
    title: String(brief["title"] ?? "Untitled"),
    prompt: taskPromptFromBrief(brief),
    working_dir: String(brief["working_dir"] || "."),
    schedule_type: ScheduleType.IMMEDIATE,
    tags,
    agent: String(
      brief["agent"] ||
        ctx.db.get_setting("default_agent", DEFAULT_AGENT) ||
        DEFAULT_AGENT,
    ),
  });
}

function taskOutputPayload(ctx: ApiContext, taskId: number): Row {
  const isRunning = ctx.scheduler._live_output.has(taskId);
  if (isRunning) {
    return {
      output: ctx.scheduler._live_output.get(taskId) ?? "",
      is_running: true,
    };
  }
  const runs = ctx.db.get_task_runs(taskId, 1);
  return { output: runs[0]?.["raw_output"] ?? "", is_running: false };
}

function taskMessages(ctx: ApiContext, taskId: number): Row[] {
  const messages: Row[] = [];
  const runs = ctx.db.get_task_runs(taskId, 50);
  for (const run of [...runs].reverse()) {
    for (const rawLine of String(run["raw_output"] ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line) as Row;
        const content = event["message"]?.["content"] ?? [];
        if (event["type"] === "user") {
          const text = content
            .map((c: unknown) =>
              typeof c === "string"
                ? c
                : c && typeof c === "object" && (c as Row)["type"] === "text"
                  ? (c as Row)["text"]
                  : "",
            )
            .join("");
          if (text.trim())
            messages.push({ role: "user", text, run_id: run["id"] });
        } else if (event["type"] === "assistant") {
          const text = Array.isArray(content)
            ? content
                .map((c) =>
                  c && typeof c === "object" && c["type"] === "text"
                    ? c["text"]
                    : "",
                )
                .join("")
            : "";
          if (text.trim())
            messages.push({ role: "assistant", text, run_id: run["id"] });
        }
      } catch {
        // Keep the Python route's tolerant "skip malformed NDJSON" behavior.
      }
    }
  }
  return messages;
}

function validateHeartbeatPayload(
  ctx: ApiContext,
  body: Row,
  existing: Row | null = null,
): { heartbeat?: Heartbeat; response?: ResponseData } {
  const name = body["name"] ?? existing?.["name"] ?? "Untitled heartbeat";
  const checkPrompt = body["check_prompt"] ?? existing?.["check_prompt"] ?? "";
  if (!String(checkPrompt).trim()) {
    return {
      response: [
        { error: "check_prompt cannot be empty", field: "check_prompt" },
        400,
      ],
    };
  }

  const workingDir = asString(
    body["working_dir"] ?? existing?.["working_dir"] ?? ".",
  );
  const workingDirError = ensureWorkingDir(
    workingDir,
    `working_dir does not exist or is not a directory: ${workingDir}`,
  );
  if (workingDirError) return { response: [workingDirError, 400] };

  const scheduleType = asString(
    body["schedule_type"] ?? existing?.["schedule_type"] ?? "interval",
  );
  if (
    scheduleType !== HeartbeatScheduleType.CRON &&
    scheduleType !== HeartbeatScheduleType.INTERVAL
  ) {
    return {
      response: [
        {
          error: `invalid heartbeat schedule_type: ${scheduleType}`,
          field: "schedule_type",
        },
        400,
      ],
    };
  }

  let cronExpr = body["cron_expr"] ?? existing?.["cron_expr"] ?? null;
  let intervalSeconds =
    body["interval_seconds"] ?? existing?.["interval_seconds"] ?? null;
  if (scheduleType === HeartbeatScheduleType.CRON) {
    if (!String(cronExpr ?? "").trim()) {
      return {
        response: [
          {
            error: "cron_expr is required for cron heartbeat",
            field: "cron_expr",
          },
          400,
        ],
      };
    }
    if (!cronValid(String(cronExpr))) {
      return {
        response: [
          { error: `invalid cron expression: ${cronExpr}`, field: "cron_expr" },
          400,
        ],
      };
    }
    intervalSeconds = null;
  } else {
    const parsed = Number.parseInt(String(intervalSeconds ?? ""), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return {
        response: [
          {
            error: "interval_seconds must be a positive integer",
            field: "interval_seconds",
          },
          400,
        ],
      };
    }
    intervalSeconds = parsed;
    cronExpr = null;
  }

  const cooldownSeconds = Number.parseInt(
    String(body["cooldown_seconds"] ?? existing?.["cooldown_seconds"] ?? 0),
    10,
  );
  if (!Number.isInteger(cooldownSeconds)) {
    return {
      response: [
        {
          error: "cooldown_seconds must be an integer",
          field: "cooldown_seconds",
        },
        400,
      ],
    };
  }
  if (cooldownSeconds < 0) {
    return {
      response: [
        {
          error: "cooldown_seconds cannot be negative",
          field: "cooldown_seconds",
        },
        400,
      ],
    };
  }

  const heartbeat = makeHeartbeat({
    id: existing?.["id"] ?? null,
    name: String(name),
    enabled: asBool(body["enabled"] ?? existing?.["enabled"] ?? true),
    working_dir: workingDir,
    schedule_type: scheduleType,
    cron_expr: cronExpr === null ? null : String(cronExpr),
    interval_seconds: intervalSeconds === null ? null : Number(intervalSeconds),
    check_prompt: String(checkPrompt),
    action_prompt_template: String(
      body["action_prompt_template"] ??
        existing?.["action_prompt_template"] ??
        "",
    ),
    default_agent: String(
      body["default_agent"] ??
        existing?.["default_agent"] ??
        ctx.db.get_setting("default_agent", DEFAULT_AGENT),
    ),
    cooldown_seconds: cooldownSeconds,
    next_run_at: existing?.["next_run_at"] ?? null,
    last_tick_at: existing?.["last_tick_at"] ?? null,
    last_decision: existing?.["last_decision"] ?? null,
    last_error: existing?.["last_error"] ?? null,
    last_triggered_at: existing?.["last_triggered_at"] ?? null,
    last_dedupe_key: existing?.["last_dedupe_key"] ?? null,
  });
  heartbeat.next_run_at = ctx.db._compute_heartbeat_next_run_at(
    heartbeat,
    new Date(),
  );
  return { heartbeat };
}

type ResponseData = [unknown, number?];

function weixinStatus(ctx: ApiContext): Row {
  const snapshot = ctx.weixin_channel?.get_status_snapshot?.() ?? {};
  const runtimeAccount = asString(snapshot["account_id"]);
  const configuredAccount = ctx.db.get_setting("weixin_account_id", "") ?? "";
  return {
    enabled: ctx.db.get_setting("weixin_enabled", "false") === "true",
    configured: Boolean(snapshot["configured"]),
    running: Boolean(ctx.weixin_channel?._running),
    default_working_dir: ctx.db.get_setting("weixin_default_working_dir", "~"),
    base_url: ctx.db.get_setting(
      "weixin_base_url",
      "https://ilinkai.weixin.qq.com",
    ),
    account_id: runtimeAccount || configuredAccount,
    login_status: snapshot["login_status"] ?? "idle",
    qr_code_url: snapshot["qr_code_url"] ?? "",
    last_error: snapshot["last_error"] ?? "",
    user_id: snapshot["user_id"] ?? "",
  };
}

function channelsStatus(ctx: ApiContext): Row {
  const tgToken =
    ctx.db.get_setting("telegram_bot_token", "") ||
    process.env.TELEGRAM_BOT_TOKEN ||
    "";
  const slBot =
    ctx.db.get_setting("slack_bot_token", "") ||
    process.env.SLACK_BOT_TOKEN ||
    "";
  const slApp =
    ctx.db.get_setting("slack_app_token", "") ||
    process.env.SLACK_APP_TOKEN ||
    "";
  return {
    telegram: {
      enabled: ctx.db.get_setting("telegram_enabled", "false") === "true",
      configured: Boolean(tgToken),
      running: Boolean(ctx.telegram_channel?._running),
      default_working_dir: ctx.db.get_setting(
        "telegram_default_working_dir",
        "~",
      ),
      default_chat_id: ctx.db.get_setting("telegram_default_chat_id", ""),
      allowed_users: ctx.db.get_setting("telegram_allowed_users", ""),
    },
    slack: {
      enabled: ctx.db.get_setting("slack_enabled", "false") === "true",
      configured: Boolean(slBot && slApp),
      running: Boolean(ctx.slack_channel?._running),
      default_working_dir: ctx.db.get_setting("slack_default_working_dir", "~"),
      default_channel: ctx.db.get_setting("slack_default_channel", ""),
      default_user: ctx.db.get_setting("slack_default_user", ""),
    },
    weixin: weixinStatus(ctx),
    feishu: {
      configured: ctx.db.get_setting("feishu_enabled", "false") === "true",
      running: Boolean(ctx.feishu_channel?._running),
    },
  };
}

async function restartChannels(ctx: ApiContext, body: Row): Promise<void> {
  if (ctx.telegram_channel) {
    ctx.telegram_channel.stop();
    ctx.telegram_channel = null;
  }
  const tgEnabled =
    (body["telegram_enabled"] ??
      ctx.db.get_setting("telegram_enabled", "false")) === "true";
  if (tgEnabled) {
    const token =
      ctx.db.get_setting("telegram_bot_token", "") ||
      process.env.TELEGRAM_BOT_TOKEN ||
      "";
    const allowed =
      ctx.db.get_setting("telegram_allowed_users", "") ||
      process.env.TELEGRAM_ALLOWED_USERS ||
      "";
    if (token) {
      ctx.telegram_channel = create_telegram_channel(
        ctx.db,
        ctx.scheduler,
        ctx.bus,
        token,
        allowed,
      );
      ctx.telegram_channel?.start();
    }
  }

  if (ctx.slack_channel) {
    ctx.slack_channel.stop();
    ctx.slack_channel = null;
  }
  const slEnabled =
    (body["slack_enabled"] ?? ctx.db.get_setting("slack_enabled", "false")) ===
    "true";
  if (slEnabled) {
    const botToken =
      ctx.db.get_setting("slack_bot_token", "") ||
      process.env.SLACK_BOT_TOKEN ||
      "";
    const appToken =
      ctx.db.get_setting("slack_app_token", "") ||
      process.env.SLACK_APP_TOKEN ||
      "";
    if (botToken && appToken) {
      ctx.slack_channel = new SlackChannel(
        ctx.bus,
        ctx.db,
        ctx.scheduler,
        botToken,
        appToken,
      );
      await ctx.slack_channel.start();
    }
  }

  if (ctx.weixin_channel) {
    ctx.weixin_channel.stop();
    ctx.weixin_channel = null;
  }
  const wxEnabled =
    (body["weixin_enabled"] ??
      ctx.db.get_setting("weixin_enabled", "false")) === "true";
  if (wxEnabled) {
    ctx.weixin_channel = new WeixinChannel(ctx.bus, ctx.db, ctx.scheduler);
    ctx.weixin_channel.start();
  }

  if (ctx.feishu_channel) {
    ctx.feishu_channel.stop();
    ctx.feishu_channel = null;
  }
  const fsEnabled =
    (body["feishu_enabled"] ??
      ctx.db.get_setting("feishu_enabled", "false")) === "true";
  if (fsEnabled) {
    ctx.feishu_channel = new FeishuChannel(ctx.bus, ctx.db, ctx.scheduler);
    ctx.feishu_channel.start();
  }
}

async function handleGet(
  ctx: ApiContext,
  req: Request,
  url: URL,
  origin: string,
): Promise<Response> {
  const path = url.pathname;

  if (path === "/api/heartbeats") {
    return jsonResponse(ctx.db.get_all_heartbeats(), 200, origin);
  }
  if (
    path.startsWith("/api/heartbeats/") &&
    path.includes("/ticks/") &&
    path.endsWith("/output")
  ) {
    const hid = idAt(path);
    const tickId = idAt(path, 5);
    if (hid === null || tickId === null)
      return jsonResponse({ error: "not found" }, 404, origin);
    const tick = ctx.db.get_heartbeat_tick(hid, tickId);
    if (!tick) return jsonResponse({ error: "not found" }, 404, origin);
    const output =
      ctx.scheduler._live_heartbeat_output.get(tickId) ??
      tick["raw_output"] ??
      "";
    return jsonResponse(
      { output, is_running: ctx.scheduler._live_heartbeat_output.has(tickId) },
      200,
      origin,
    );
  }
  if (path.startsWith("/api/heartbeats/") && path.endsWith("/ticks")) {
    const hid = idAt(path);
    if (hid === null) return jsonResponse({ error: "not found" }, 404, origin);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    return jsonResponse(
      { ticks: ctx.db.get_heartbeat_ticks(hid, limit) },
      200,
      origin,
    );
  }
  if (path.startsWith("/api/heartbeats/")) {
    const hid = idAt(path);
    if (hid === null) return jsonResponse({ error: "not found" }, 404, origin);
    const heartbeat = ctx.db.get_heartbeat(hid);
    return heartbeat
      ? jsonResponse(heartbeat, 200, origin)
      : jsonResponse({ error: "not found" }, 404, origin);
  }

  if (path === "/api/task-briefs") {
    const status = url.searchParams.get("status");
    return jsonResponse(
      { briefs: ctx.db.get_task_briefs(status || null) },
      200,
      origin,
    );
  }
  if (path.startsWith("/api/task-briefs/")) {
    const bid = idAt(path);
    const brief = bid === null ? null : ctx.db.get_task_brief(bid);
    return brief
      ? jsonResponse(brief, 200, origin)
      : jsonResponse({ error: "not found" }, 404, origin);
  }

  if (path === "/api/im-runbooks") {
    return jsonResponse({ runbooks: allIMRunbooks(ctx) }, 200, origin);
  }

  if (path === "/api/tasks") {
    return jsonResponse(
      ctx.db.get_all_tasks().map((t) => attachDependencyMetadata(ctx.db, t)),
      200,
      origin,
    );
  }
  if (path.startsWith("/api/tasks/") && path.endsWith("/runs")) {
    const tid = idAt(path);
    return tid === null
      ? jsonResponse({ error: "not found" }, 404, origin)
      : jsonResponse(ctx.db.get_task_runs(tid), 200, origin);
  }
  if (path.startsWith("/api/tasks/") && path.endsWith("/output")) {
    const tid = idAt(path);
    return tid === null
      ? jsonResponse({ error: "not found" }, 404, origin)
      : jsonResponse(taskOutputPayload(ctx, tid), 200, origin);
  }
  if (path.startsWith("/api/tasks/") && path.endsWith("/events")) {
    const tid = idAt(path);
    if (tid === null) return jsonResponse({ error: "not found" }, 404, origin);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "1000", 10);
    const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
    const events = ctx.db.get_output_events(tid, limit, offset);
    return jsonResponse({ events, total: events.length }, 200, origin);
  }
  if (path.startsWith("/api/tasks/") && path.endsWith("/messages")) {
    const tid = idAt(path);
    return tid === null
      ? jsonResponse({ error: "not found" }, 404, origin)
      : jsonResponse(taskMessages(ctx, tid), 200, origin);
  }
  if (path.startsWith("/api/tasks/") && path.endsWith("/dependencies")) {
    const tid = idAt(path);
    return tid === null
      ? jsonResponse({ error: "not found" }, 404, origin)
      : jsonResponse(ctx.db.get_dependencies(tid), 200, origin);
  }
  if (path.startsWith("/api/tasks/") && path.endsWith("/dependents")) {
    const tid = idAt(path);
    return tid === null
      ? jsonResponse({ error: "not found" }, 404, origin)
      : jsonResponse(ctx.db.get_dependents(tid), 200, origin);
  }
  if (path.startsWith("/api/dag/")) {
    const dagId = decodeURIComponent(path.slice("/api/dag/".length));
    const tasks = ctx.db
      .get_dag_tasks(dagId)
      .map((t) => attachDependencyMetadata(ctx.db, t));
    return jsonResponse(tasks, 200, origin);
  }
  if (path.startsWith("/api/tasks/")) {
    const tid = idAt(path);
    const task = tid === null ? null : ctx.db.get_task(tid);
    return task
      ? jsonResponse(attachDependencyMetadata(ctx.db, task), 200, origin)
      : jsonResponse({ error: "not found" }, 404, origin);
  }

  if (path === "/api/skill-patterns") {
    return jsonResponse(
      {
        patterns: ctx.db.get_skill_patterns(),
        sweep: ctx.scheduler.skill_sweep_status(),
      },
      200,
      origin,
    );
  }
  if (path === "/api/skills") {
    return jsonResponse({ skills: ctx.db.get_skills() }, 200, origin);
  }
  if (path.startsWith("/api/skills/") && path.endsWith("/content")) {
    const sid = idAt(path);
    const skill = sid === null ? null : ctx.db.get_skill(sid);
    if (!skill) return jsonResponse({ error: "not found" }, 404, origin);
    let content: string;
    try {
      content = fs.readFileSync(String(skill["path"]), "utf8");
    } catch (e) {
      content = `(无法读取 SKILL.md：${e})`;
    }
    return jsonResponse({ content, path: skill["path"], skill }, 200, origin);
  }

  if (path === "/api/csrf-token")
    return jsonResponse({ csrf_token: CSRF_TOKEN }, 200, origin);
  if (path === "/api/health")
    return jsonResponse(
      { status: "ok", tasks: ctx.db.get_all_tasks().length },
      200,
      origin,
    );
  if (path === "/api/settings") {
    return jsonResponse(
      {
        default_agent: ctx.db.get_setting("default_agent", DEFAULT_AGENT),
        timeout: Number.parseInt(
          ctx.db.get_setting("timeout", String(DEFAULT_TIMEOUT_SECONDS)) ??
            String(DEFAULT_TIMEOUT_SECONDS),
          10,
        ),
        skill_library_enabled:
          ctx.db.get_setting("skill_library_enabled", "0") === "1",
        skill_sweep_agent: ctx.db.get_setting(
          "skill_sweep_agent",
          DEFAULT_AGENT,
        ),
        skill_sweep_cron: ctx.db.get_setting("skill_sweep_cron", "0 3 * * *"),
        im_digest_enabled: ctx.db.get_setting("im_digest_enabled", "0") === "1",
        im_digest_cron: ctx.db.get_setting("im_digest_cron", "0 9 * * 1-5"),
        im_digest_channels: parse_im_digest_recipients(
          ctx.db.get_setting("im_digest_channels", "[]"),
        ),
        im_attention_digest_minutes: Number.parseInt(
          ctx.db.get_setting("im_attention_digest_minutes", "20") ?? "20",
          10,
        ),
        im_skill_suggestions_enabled:
          ctx.db.get_setting("im_skill_suggestions_enabled", "0") === "1",
        im_skill_suggestion_channels: parse_im_digest_recipients(
          ctx.db.get_setting("im_skill_suggestion_channels", "[]"),
        ),
      },
      200,
      origin,
    );
  }
  if (path === "/api/feishu/settings") {
    return jsonResponse(
      {
        feishu_app_id: ctx.db.get_setting("feishu_app_id", ""),
        feishu_app_secret: ctx.db.get_setting("feishu_app_secret", ""),
        feishu_default_chat_id: ctx.db.get_setting(
          "feishu_default_chat_id",
          "",
        ),
        feishu_default_working_dir: ctx.db.get_setting(
          "feishu_default_working_dir",
          "~",
        ),
        feishu_enabled: ctx.db.get_setting("feishu_enabled", "false"),
      },
      200,
      origin,
    );
  }
  if (path === "/api/channels/status") {
    return jsonResponse(channelsStatus(ctx), 200, origin);
  }

  return jsonResponse({ error: "not found" }, 404, origin);
}

async function handlePost(
  ctx: ApiContext,
  req: Request,
  url: URL,
  origin: string,
): Promise<Response> {
  const bodyOrResponse = await readJsonBody(req, origin);
  if (bodyOrResponse instanceof Response) return bodyOrResponse;
  const body = bodyOrResponse;
  const path = url.pathname;

  if (path === "/api/heartbeats") {
    const validated = validateHeartbeatPayload(ctx, body);
    if (validated.response)
      return jsonResponse(
        validated.response[0],
        validated.response[1] ?? 200,
        origin,
      );
    const id = ctx.db.add_heartbeat(validated.heartbeat!);
    return jsonResponse({ id, status: "created" }, 201, origin);
  }
  if (path.startsWith("/api/heartbeats/") && path.endsWith("/run-now")) {
    const hid = idAt(path);
    if (hid === null) return jsonResponse({ error: "not found" }, 404, origin);
    try {
      ctx.scheduler.trigger_heartbeat_now(hid);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse(
        { error: msg },
        msg.includes("not found") ? 404 : 409,
        origin,
      );
    }
    return jsonResponse({ status: "scheduled" }, 200, origin);
  }
  if (path.startsWith("/api/heartbeats/") && path.endsWith("/pause")) {
    const hid = idAt(path);
    if (hid === null) return jsonResponse({ error: "not found" }, 404, origin);
    try {
      ctx.scheduler.pause_heartbeat(hid);
    } catch (e) {
      return jsonResponse(
        { error: e instanceof Error ? e.message : String(e) },
        404,
        origin,
      );
    }
    return jsonResponse({ status: "paused" }, 200, origin);
  }
  if (path.startsWith("/api/heartbeats/") && path.endsWith("/resume")) {
    const hid = idAt(path);
    if (hid === null) return jsonResponse({ error: "not found" }, 404, origin);
    try {
      ctx.scheduler.resume_heartbeat(hid);
    } catch (e) {
      return jsonResponse(
        { error: e instanceof Error ? e.message : String(e) },
        404,
        origin,
      );
    }
    return jsonResponse({ status: "resumed" }, 200, origin);
  }

  if (path === "/api/task-briefs") {
    const validated = validateTaskBriefPayload(body);
    if (validated.response) {
      return jsonResponse(
        validated.response[0],
        validated.response[1] ?? 200,
        origin,
      );
    }
    const id = ctx.db.add_task_brief(validated.brief!);
    return jsonResponse(ctx.db.get_task_brief(id), 201, origin);
  }
  if (path.startsWith("/api/task-briefs/") && path.endsWith("/confirm")) {
    const bid = idAt(path);
    const brief = bid === null ? null : ctx.db.get_task_brief(bid);
    if (!brief || bid === null)
      return jsonResponse({ error: "not found" }, 404, origin);
    if (brief["status"] !== TaskBriefStatus.DRAFT) {
      return jsonResponse(
        {
          error: `Cannot confirm draft task with status '${brief["status"]}'.`,
        },
        409,
        origin,
      );
    }
    const task = taskFromBrief(ctx, brief);
    const dirError = ensureWorkingDir(
      task.working_dir,
      `working_dir does not exist or is not a directory: ${task.working_dir}`,
    );
    if (dirError) return jsonResponse(dirError, 400, origin);
    const taskId = ctx.scheduler.submit_task(task);
    ctx.db.confirm_task_brief(bid, taskId);
    return jsonResponse(
      {
        status: "created",
        task_id: taskId,
        brief: ctx.db.get_task_brief(bid),
      },
      201,
      origin,
    );
  }
  if (path.startsWith("/api/task-briefs/") && path.endsWith("/discard")) {
    const bid = idAt(path);
    const brief = bid === null ? null : ctx.db.get_task_brief(bid);
    if (!brief || bid === null)
      return jsonResponse({ error: "not found" }, 404, origin);
    if (brief["status"] !== TaskBriefStatus.DRAFT) {
      return jsonResponse(
        {
          error: `Cannot discard draft task with status '${brief["status"]}'.`,
        },
        409,
        origin,
      );
    }
    ctx.db.discard_task_brief(bid);
    return jsonResponse(ctx.db.get_task_brief(bid), 200, origin);
  }

  if (path === "/api/im-runbooks") {
    const validated = validateIMRunbookPayload(body);
    if (validated.response) {
      return jsonResponse(
        validated.response[0],
        validated.response[1] ?? 200,
        origin,
      );
    }
    const id = ctx.db.add_im_runbook(validated.runbook!);
    return jsonResponse(ctx.db.get_im_runbook(id), 201, origin);
  }
  if (path === "/api/im-runbooks/from-task") {
    const validated = commandFromTaskPayload(ctx, body);
    if (validated.response) {
      return jsonResponse(
        validated.response[0],
        validated.response[1] ?? 200,
        origin,
      );
    }
    const id = ctx.db.add_im_runbook(validated.runbook!);
    return jsonResponse(ctx.db.get_im_runbook(id), 201, origin);
  }
  {
    const parts = path.split("/");
    if (
      parts.length === 5 &&
      parts[2] === "im-runbooks" &&
      (parts[4] === "preview" || parts[4] === "run")
    ) {
      const name = decodeURIComponent(parts[3] ?? "");
      const sourceRef = asString(body["source_ref"] ?? `api:${name}`).trim();
      try {
        const result = ctx.scheduler.handle_inbound_message(
          makeInboundMessage({
            type:
              parts[4] === "preview"
                ? InboundMessageType.PREVIEW_RUNBOOK
                : InboundMessageType.RUN_RUNBOOK,
            source: "api",
            payload: {
              ...body,
              name,
              raw_args: asString(body["raw_args"] ?? ""),
              source_channel:
                asString(body["source_channel"] ?? "api").trim() || "api",
              source_ref: sourceRef || `api:${name}`,
            },
            metadata: { source_ref: sourceRef || `api:${name}` },
          }),
        );
        return jsonResponse(result, 201, origin);
      } catch (e) {
        return jsonResponse(
          { error: e instanceof Error ? e.message : String(e) },
          400,
          origin,
        );
      }
    }
  }

  if (path === "/api/im-digests/preview") {
    return jsonResponse(triggerDigest(ctx, body), 200, origin);
  }
  if (path === "/api/im-digests/send") {
    const recipients = digestRecipients(ctx, body);
    if (!recipients.length) {
      return jsonResponse(
        { error: "no digest recipients configured" },
        409,
        origin,
      );
    }
    const result = triggerDigest(ctx, body);
    if (result["status"] === "quiet") {
      return jsonResponse(result, 200, origin);
    }
    const text = asString(result["text"]);
    try {
      for (const recipient of recipients) {
        await sendIMDigest(ctx, recipient, text);
      }
    } catch (e) {
      return jsonResponse(
        { error: e instanceof Error ? e.message : String(e) },
        409,
        origin,
      );
    }
    return jsonResponse(
      {
        status: "sent",
        sent: recipients.length,
        digest: result["digest"],
      },
      200,
      origin,
    );
  }

  if (path === "/api/im-skill-suggestions/preview") {
    return jsonResponse(skillSuggestionPreview(ctx, body), 200, origin);
  }
  if (path === "/api/im-skill-suggestions/send") {
    const recipients = skillSuggestionRecipients(ctx, body);
    if (!recipients.length) {
      return jsonResponse(
        { error: "no skill suggestion recipients configured" },
        409,
        origin,
      );
    }
    const includeSent = Boolean(body["include_sent"] ?? false);
    const sentSuggestions: Row[] = [];
    try {
      for (const recipient of recipients) {
        const suggestions = collect_im_skill_suggestions(ctx.db, {
          channel: recipient.channel,
          limit:
            body["limit"] === undefined || body["limit"] === null
              ? undefined
              : Number(body["limit"]),
        });
        for (const suggestion of suggestions) {
          if (
            !includeSent &&
            !ctx.db.should_send_im_skill_suggestion(
              suggestion.pattern_id,
              recipient.channel,
              recipient.target,
            )
          ) {
            continue;
          }
          await sendIMDigest(
            ctx,
            recipient,
            render_im_skill_suggestion_text(suggestion),
          );
          ctx.db.upsert_im_skill_suggestion({
            pattern_id: suggestion.pattern_id,
            channel: recipient.channel,
            target: recipient.target,
            status: "suggested",
          });
          sentSuggestions.push({
            pattern_id: suggestion.pattern_id,
            channel: recipient.channel,
            target: recipient.target,
          });
        }
      }
    } catch (e) {
      return jsonResponse(
        { error: e instanceof Error ? e.message : String(e) },
        409,
        origin,
      );
    }
    return jsonResponse(
      {
        status: "sent",
        sent: sentSuggestions.length,
        suggestions: sentSuggestions,
      },
      200,
      origin,
    );
  }
  if (
    path.startsWith("/api/im-skill-suggestions/") &&
    path.endsWith("/action")
  ) {
    const patternId = idAt(path);
    if (patternId === null) {
      return jsonResponse({ error: "pattern not found" }, 404, origin);
    }
    try {
      const result = ctx.scheduler.handle_inbound_message(
        makeInboundMessage({
          type: InboundMessageType.SKILL_SUGGESTION_ACTION,
          source: "api",
          reply_to:
            body["target"] === undefined || body["target"] === null
              ? null
              : String(body["target"]),
          payload: {
            ...body,
            pattern_id: patternId,
            source_channel:
              asString(
                body["source_channel"] ?? body["channel"] ?? "api",
              ).trim() || "api",
            target: asString(body["target"] ?? ""),
          },
        }),
      );
      return jsonResponse(result, 200, origin);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse(
        { error: msg },
        msg.includes("not found") ? 404 : 400,
        origin,
      );
    }
  }

  if (path === "/api/skills/sweep") {
    const started = ctx.scheduler.trigger_skill_sweep(
      body["agent"] ?? null,
      Boolean(body["full"] ?? true),
    );
    return started
      ? jsonResponse({ status: "started" }, 200, origin)
      : jsonResponse({ error: "sweep already running" }, 409, origin);
  }
  if (path.startsWith("/api/skill-patterns/") && path.endsWith("/draft")) {
    const pid = idAt(path);
    if (
      pid === null ||
      !ctx.scheduler.trigger_skill_draft(pid, body["agent"] ?? null)
    ) {
      return jsonResponse({ error: "pattern not found" }, 404, origin);
    }
    return jsonResponse({ status: "drafting" }, 200, origin);
  }
  if (path.startsWith("/api/skill-patterns/") && path.endsWith("/approve")) {
    const pid = idAt(path);
    if (pid === null)
      return jsonResponse({ error: "pattern not found" }, 404, origin);
    const draft = ctx.db.get_skill_draft(pid);
    try {
      const skill = ctx.scheduler.approve_skill(
        pid,
        String(body["name"] ?? draft?.["name"] ?? ""),
        String(body["description"] ?? draft?.["description"] ?? ""),
        String(body["body"] ?? draft?.["body"] ?? ""),
      );
      return jsonResponse({ status: "approved", skill }, 200, origin);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse(
        { error: msg },
        msg.includes("not found") ? 404 : 400,
        origin,
      );
    }
  }
  if (path.startsWith("/api/skill-patterns/") && path.endsWith("/dismiss")) {
    const pid = idAt(path);
    try {
      if (pid === null) throw new Error("pattern not found");
      ctx.scheduler.dismiss_skill_pattern(pid);
    } catch (e) {
      return jsonResponse(
        { error: e instanceof Error ? e.message : String(e) },
        404,
        origin,
      );
    }
    return jsonResponse({ status: "dismissed" }, 200, origin);
  }

  if (path === "/api/tasks") {
    const prompt = asString(body["prompt"]);
    if (!prompt.trim())
      return jsonResponse(
        { error: "prompt cannot be empty", field: "prompt" },
        400,
        origin,
      );
    const workingDir = asString(body["working_dir"], ".");
    const dirError = ensureWorkingDir(
      workingDir,
      `working_dir does not exist or is not a directory: ${workingDir}`,
    );
    if (dirError) return jsonResponse(dirError, 400, origin);
    const scheduleType = asString(body["schedule_type"], "immediate");
    const cronExpr =
      body["cron_expr"] === undefined ? null : asString(body["cron_expr"]);
    if (scheduleType === "cron") {
      if (!cronExpr?.trim())
        return jsonResponse(
          {
            error: "cron_expr is required for cron schedule",
            field: "cron_expr",
          },
          400,
          origin,
        );
      if (!cronValid(cronExpr))
        return jsonResponse(
          { error: `invalid cron expression: ${cronExpr}`, field: "cron_expr" },
          400,
          origin,
        );
    }
    const deps = dependencyList(
      body["depends_on"],
      Boolean(body["inject_result"]),
    );
    const task: Task = makeTask({
      title: asString(body["title"], "Untitled"),
      prompt,
      working_dir: workingDir,
      schedule_type: scheduleType as ScheduleType,
      cron_expr: cronExpr,
      delay_seconds: body["delay_seconds"] ?? null,
      next_run_at: body["next_run_at"] ?? null,
      max_runs: body["max_runs"] ?? null,
      tags: asString(body["tags"]),
      agent: asString(
        body["agent"] ?? ctx.db.get_setting("default_agent", DEFAULT_AGENT),
        DEFAULT_AGENT,
      ),
      prompt_images: parseJsonList(body["prompt_images"]),
      image_paths: parseJsonList(body["image_paths"]).map(String),
      dag_id: body["dag_id"] ?? null,
    });
    const id = ctx.scheduler.submit_task(task, deps);
    return jsonResponse({ id, status: "created" }, 201, origin);
  }

  if (path === "/api/settings") {
    for (const [key, value] of Object.entries(body))
      ctx.db.set_setting(key, String(value));
    return jsonResponse({ status: "updated" }, 200, origin);
  }
  if (path === "/api/feishu/settings") {
    for (const key of [
      "feishu_app_id",
      "feishu_app_secret",
      "feishu_default_chat_id",
      "feishu_default_working_dir",
      "feishu_enabled",
    ]) {
      if (key in body) ctx.db.set_setting(key, String(body[key]));
    }
    await restartChannels(ctx, body);
    return jsonResponse({ status: "updated" }, 200, origin);
  }
  if (path === "/api/channels/settings") {
    const allowed = new Set([
      "telegram_bot_token",
      "telegram_allowed_users",
      "telegram_default_working_dir",
      "telegram_enabled",
      "telegram_default_chat_id",
      "slack_bot_token",
      "slack_app_token",
      "slack_default_working_dir",
      "slack_default_channel",
      "slack_default_user",
      "slack_enabled",
      "weixin_default_working_dir",
      "weixin_base_url",
      "weixin_account_id",
      "weixin_enabled",
    ]);
    for (const [key, value] of Object.entries(body)) {
      if (allowed.has(key)) ctx.db.set_setting(key, String(value));
    }
    await restartChannels(ctx, body);
    return jsonResponse({ status: "updated" }, 200, origin);
  }
  if (path === "/api/channels/weixin/action") {
    const action = asString(body["action"]).trim().toLowerCase();
    if (!ctx.weixin_channel)
      return jsonResponse({ error: "weixin channel not running" }, 400, origin);
    if (action === "login" || action === "reconnect") {
      ctx.weixin_channel.request_login();
      return jsonResponse({ status: "ok", action }, 200, origin);
    }
    if (action === "logout") {
      ctx.weixin_channel.request_logout();
      return jsonResponse({ status: "ok", action }, 200, origin);
    }
    return jsonResponse({ error: "unsupported action" }, 400, origin);
  }

  if (path === "/api/dag") {
    const taskDefs = Array.isArray(body["tasks"])
      ? (body["tasks"] as Row[])
      : [];
    if (!taskDefs.length)
      return jsonResponse({ error: "tasks list is required" }, 400, origin);
    const dagId = asString(
      body["dag_id"],
      `dag-${Math.trunc(Date.now() / 1000)}`,
    );
    const refToId = new Map<string, number>();
    const results: Row = {};
    for (const tdef of taskDefs) {
      const ref = asString(tdef["ref"], String(refToId.size));
      const dependsOn: Array<{ task_id: number; inject_result: boolean }> = [];
      for (const depRef of Array.isArray(tdef["depends_on_refs"])
        ? tdef["depends_on_refs"]
        : []) {
        const upstreamId = refToId.get(String(depRef));
        if (upstreamId === undefined) {
          return jsonResponse(
            {
              error: `ref '${depRef}' not found - declare tasks in topological order`,
            },
            400,
            origin,
          );
        }
        dependsOn.push({
          task_id: upstreamId,
          inject_result: Boolean(tdef["inject_result"]),
        });
      }
      const task = makeTask({
        title: asString(tdef["title"], asString(tdef["prompt"]).slice(0, 60)),
        prompt: asString(tdef["prompt"]),
        working_dir: asString(tdef["working_dir"], "."),
        schedule_type: asString(
          tdef["schedule_type"],
          "immediate",
        ) as ScheduleType,
        cron_expr: tdef["cron_expr"] ?? null,
        delay_seconds: tdef["delay_seconds"] ?? null,
        next_run_at: tdef["next_run_at"] ?? null,
        max_runs: tdef["max_runs"] ?? null,
        tags: asString(tdef["tags"]),
        agent: asString(
          tdef["agent"] ?? ctx.db.get_setting("default_agent", DEFAULT_AGENT),
          DEFAULT_AGENT,
        ),
        prompt_images: parseJsonList(tdef["prompt_images"]),
        dag_id: dagId,
      });
      const taskId = ctx.scheduler.submit_task(task, dependsOn);
      refToId.set(ref, taskId);
      results[ref] = taskId;
    }
    return jsonResponse({ dag_id: dagId, task_ids: results }, 201, origin);
  }

  if (path.startsWith("/api/tasks/") && path.endsWith("/dependencies")) {
    const tid = idAt(path);
    const depTaskId = Number(body["depends_on_task_id"]);
    if (tid === null || !Number.isInteger(depTaskId))
      return jsonResponse(
        { error: "depends_on_task_id required" },
        400,
        origin,
      );
    const task = ctx.db.get_task(tid);
    const upstream = ctx.db.get_task(depTaskId);
    if (!task || !upstream)
      return jsonResponse({ error: "task not found" }, 404, origin);
    const shouldBlock =
      upstream["status"] !== "completed" &&
      ["pending", "scheduled"].includes(task["status"]);
    ctx.db.transaction(() => {
      ctx.db.add_dependency(tid, depTaskId, Boolean(body["inject_result"]));
      if (shouldBlock) ctx.db.update_task(tid, { status: "blocked" });
    });
    if (shouldBlock) ctx.scheduler._notify(tid);
    return jsonResponse({ status: "added" }, 200, origin);
  }
  if (path.startsWith("/api/tasks/") && path.endsWith("/cancel")) {
    const tid = idAt(path);
    if (tid === null) return jsonResponse({ error: "not found" }, 404, origin);
    ctx.scheduler.cancel_task(tid);
    return jsonResponse({ status: "cancelled" }, 200, origin);
  }
  if (path.startsWith("/api/tasks/") && path.endsWith("/retry")) {
    const tid = idAt(path);
    if (tid === null) return jsonResponse({ error: "not found" }, 404, origin);
    ctx.scheduler.retry_task(tid);
    return jsonResponse({ status: "retrying" }, 200, origin);
  }
  if (path.startsWith("/api/tasks/") && path.endsWith("/respond")) {
    const tid = idAt(path);
    const task = tid === null ? null : ctx.db.get_task(tid);
    if (!task || tid === null)
      return jsonResponse({ error: "not found" }, 404, origin);
    const answer = asString(body["answer"]);
    ctx.db.update_task(tid, {
      status: "pending",
      prompt: answer,
      answer,
      question: null,
      error: null,
    });
    return jsonResponse({ status: "responding" }, 200, origin);
  }
  if (path.startsWith("/api/tasks/") && path.endsWith("/resume")) {
    const tid = idAt(path);
    const task = tid === null ? null : ctx.db.get_task(tid);
    const message = asString(body["message"]).trim();
    if (!task || tid === null)
      return jsonResponse({ error: "not found" }, 404, origin);
    if (!message)
      return jsonResponse({ error: "message required" }, 400, origin);
    if (!task["session_id"])
      return jsonResponse(
        { error: "no session_id - cannot resume" },
        400,
        origin,
      );
    ctx.db.update_task(tid, {
      status: "pending",
      prompt: message,
      result: null,
      error: null,
      question: null,
    });
    return jsonResponse({ status: "resuming" }, 200, origin);
  }

  return jsonResponse({ error: "not found" }, 404, origin);
}

async function handlePut(
  ctx: ApiContext,
  req: Request,
  url: URL,
  origin: string,
): Promise<Response> {
  const bodyOrResponse = await readJsonBody(req, origin);
  if (bodyOrResponse instanceof Response) return bodyOrResponse;
  const body = bodyOrResponse;
  const path = url.pathname;

  if (path === "/api/settings") {
    for (const [key, value] of Object.entries(body))
      ctx.db.set_setting(key, String(value));
    return jsonResponse({ status: "updated" }, 200, origin);
  }
  if (path.startsWith("/api/task-briefs/") && path.split("/").length === 4) {
    const bid = idAt(path);
    const existing = bid === null ? null : ctx.db.get_task_brief(bid);
    if (!existing || bid === null)
      return jsonResponse({ error: "not found" }, 404, origin);
    if (existing["status"] !== TaskBriefStatus.DRAFT) {
      return jsonResponse(
        {
          error: `Cannot edit draft task with status '${existing["status"]}'.`,
        },
        409,
        origin,
      );
    }
    const validated = validateTaskBriefPayload(body, existing);
    if (validated.response) {
      return jsonResponse(
        validated.response[0],
        validated.response[1] ?? 200,
        origin,
      );
    }
    const brief = validated.brief!;
    ctx.db.update_task_brief(bid, {
      title: brief.title,
      goal: brief.goal,
      context_summary: brief.context_summary,
      acceptance_criteria: brief.acceptance_criteria,
      working_dir: brief.working_dir,
      working_dir_confidence: brief.working_dir_confidence,
      agent: brief.agent,
      risk_level: brief.risk_level,
      needs_confirmation: brief.needs_confirmation,
      source_channel: brief.source_channel,
      source_ref: brief.source_ref,
      source_metadata: brief.source_metadata,
      expires_at: brief.expires_at,
    });
    return jsonResponse(ctx.db.get_task_brief(bid), 200, origin);
  }
  if (path.startsWith("/api/im-runbooks/") && path.split("/").length === 4) {
    const rid = idAt(path);
    if (rid === null)
      return jsonResponse({ error: "invalid runbook id" }, 400, origin);
    const existing = ctx.db.get_im_runbook(rid);
    if (!existing) return jsonResponse({ error: "not found" }, 404, origin);
    const validated = validateIMRunbookPayload(body, existing);
    if (validated.response) {
      return jsonResponse(
        validated.response[0],
        validated.response[1] ?? 200,
        origin,
      );
    }
    const runbook = validated.runbook!;
    ctx.db.update_im_runbook(rid, {
      name: runbook.name,
      aliases: runbook.aliases,
      description: runbook.description,
      source_type: runbook.source_type,
      source_id: runbook.source_id,
      command_schema: runbook.command_schema,
      prompt_template: runbook.prompt_template,
      default_agent: runbook.default_agent,
      confirmation_policy: runbook.confirmation_policy,
      enabled: runbook.enabled,
    });
    return jsonResponse(ctx.db.get_im_runbook(rid), 200, origin);
  }
  if (path.startsWith("/api/skills/")) {
    const sid = idAt(path);
    if (sid === null)
      return jsonResponse({ error: "invalid skill id" }, 400, origin);
    try {
      const skill = ctx.scheduler.toggle_skill(
        sid,
        Boolean(body["enabled"] ?? true),
      );
      return jsonResponse({ status: "updated", skill }, 200, origin);
    } catch (e) {
      return jsonResponse(
        { error: e instanceof Error ? e.message : String(e) },
        404,
        origin,
      );
    }
  }
  if (path.startsWith("/api/heartbeats/") && path.split("/").length === 4) {
    const hid = idAt(path);
    if (hid === null)
      return jsonResponse({ error: "invalid heartbeat id" }, 400, origin);
    const existing = ctx.db.get_heartbeat(hid);
    if (!existing) return jsonResponse({ error: "not found" }, 404, origin);
    const validated = validateHeartbeatPayload(ctx, body, existing);
    if (validated.response)
      return jsonResponse(
        validated.response[0],
        validated.response[1] ?? 200,
        origin,
      );
    const hb = validated.heartbeat!;
    ctx.db.update_heartbeat(hid, {
      name: hb.name,
      enabled: hb.enabled ? 1 : 0,
      working_dir: hb.working_dir,
      schedule_type: hb.schedule_type,
      cron_expr: hb.cron_expr,
      interval_seconds: hb.interval_seconds,
      check_prompt: hb.check_prompt,
      action_prompt_template: hb.action_prompt_template,
      default_agent: hb.default_agent,
      cooldown_seconds: hb.cooldown_seconds,
      next_run_at: hb.next_run_at,
    });
    return jsonResponse(ctx.db.get_heartbeat(hid), 200, origin);
  }
  if (path.startsWith("/api/tasks/") && path.split("/").length === 4) {
    const tid = idAt(path);
    if (tid === null)
      return jsonResponse({ error: "invalid task id" }, 400, origin);
    const task = ctx.db.get_task(tid);
    if (!task) return jsonResponse({ error: "not found" }, 404, origin);
    if (!["pending", "scheduled", "blocked"].includes(task["status"])) {
      return jsonResponse(
        {
          error: `Cannot edit task with status '${task["status"]}'. Only pending, scheduled, or blocked tasks can be edited.`,
        },
        409,
        origin,
      );
    }
    const prompt = asString(body["prompt"] ?? task["prompt"]);
    if (!prompt.trim())
      return jsonResponse(
        { error: "prompt cannot be empty", field: "prompt" },
        400,
        origin,
      );
    const workingDir = asString(body["working_dir"] ?? task["working_dir"]);
    const dirError = ensureWorkingDir(
      workingDir,
      `working_dir does not exist: ${workingDir}`,
    );
    if (dirError) return jsonResponse(dirError, 400, origin);
    const scheduleType = asString(
      body["schedule_type"] ?? task["schedule_type"],
    );
    const cronExpr = asString(body["cron_expr"] ?? task["cron_expr"]);
    if (scheduleType === "cron") {
      if (!cronExpr.trim())
        return jsonResponse(
          { error: "cron_expr required for cron schedule", field: "cron_expr" },
          400,
          origin,
        );
      if (!cronValid(cronExpr))
        return jsonResponse(
          { error: `invalid cron expression: ${cronExpr}`, field: "cron_expr" },
          400,
          origin,
        );
    }

    const updates: Row = {};
    for (const field of [
      "title",
      "prompt",
      "working_dir",
      "schedule_type",
      "cron_expr",
      "delay_seconds",
      "max_runs",
      "tags",
      "agent",
      "dag_id",
    ]) {
      if (field in body) updates[field] = body[field];
    }
    if ("prompt_images" in body)
      updates["prompt_images"] = JSON.stringify(
        parseJsonList(body["prompt_images"]),
      );
    if ("image_paths" in body)
      updates["image_paths"] = JSON.stringify(
        parseJsonList(body["image_paths"]),
      );

    const newScheduleType = asString(
      updates["schedule_type"] ?? task["schedule_type"],
    );
    if (newScheduleType === "immediate") {
      Object.assign(updates, {
        status: "pending",
        next_run_at: null,
        cron_expr: null,
        delay_seconds: null,
      });
    } else if (newScheduleType === "delayed") {
      Object.assign(updates, {
        status: "pending",
        next_run_at: null,
        cron_expr: null,
      });
    } else if (newScheduleType === "scheduled_at") {
      const nextRunAt = body["next_run_at"] ?? task["next_run_at"];
      if (!nextRunAt)
        return jsonResponse(
          {
            error: "next_run_at required for scheduled_at",
            field: "next_run_at",
          },
          400,
          origin,
        );
      Object.assign(updates, {
        next_run_at: nextRunAt,
        status: "scheduled",
        cron_expr: null,
        delay_seconds: null,
      });
    } else if (newScheduleType === "cron") {
      const newCron = asString(updates["cron_expr"] ?? task["cron_expr"]);
      Object.assign(updates, {
        next_run_at: cronNextIso(newCron),
        status: "scheduled",
        delay_seconds: null,
      });
    }

    if ("depends_on" in body) {
      ctx.db.clear_dependencies(tid);
      const deps = dependencyList(body["depends_on"]);
      if (deps.length) {
        ctx.db.add_dependencies_batch(tid, deps);
        if (
          deps.some(
            (dep) => ctx.db.get_task(dep.task_id)?.["status"] !== "completed",
          )
        ) {
          updates["status"] = "blocked";
        }
      }
    }
    if (Object.keys(updates).length) ctx.db.update_task(tid, updates);
    const updated = ctx.db.get_task(tid);
    return jsonResponse(
      updated ? attachDependencyMetadata(ctx.db, updated) : null,
      200,
      origin,
    );
  }
  return jsonResponse({ error: "not found" }, 404, origin);
}

async function handleDelete(
  ctx: ApiContext,
  url: URL,
  origin: string,
): Promise<Response> {
  const path = url.pathname;
  const parts = path.split("/");
  if (
    parts.length === 6 &&
    parts[2] === "tasks" &&
    parts[4] === "dependencies"
  ) {
    const tid = Number(parts[3]);
    const depId = Number(parts[5]);
    ctx.db.remove_dependency(tid, depId);
    return jsonResponse({ status: "removed" }, 200, origin);
  }
  if (path.startsWith("/api/heartbeats/")) {
    const hid = idAt(path);
    if (hid !== null) ctx.db.delete_heartbeat(hid);
    return jsonResponse({ status: "deleted" }, 200, origin);
  }
  if (path.startsWith("/api/im-runbooks/")) {
    const rid = idAt(path);
    if (rid === null)
      return jsonResponse({ error: "invalid runbook id" }, 400, origin);
    ctx.db.delete_im_runbook(rid);
    return jsonResponse({ status: "deleted" }, 200, origin);
  }
  if (path.startsWith("/api/skills/")) {
    const sid = idAt(path);
    if (sid === null)
      return jsonResponse({ error: "invalid skill id" }, 400, origin);
    try {
      ctx.scheduler.remove_skill(sid);
      return jsonResponse({ status: "deleted" }, 200, origin);
    } catch (e) {
      return jsonResponse(
        { error: e instanceof Error ? e.message : String(e) },
        404,
        origin,
      );
    }
  }
  if (path.startsWith("/api/tasks/")) {
    const tid = idAt(path);
    if (tid !== null) ctx.db.delete_task(tid);
    return jsonResponse({ status: "deleted" }, 200, origin);
  }
  return jsonResponse({ error: "not found" }, 404, origin);
}

export async function handleApiRequest(
  ctx: ApiContext,
  req: Request,
): Promise<Response> {
  const origin = req.headers.get("Origin") ?? "";
  if (origin && !isAllowedOrigin(origin)) {
    return new Response(null, { status: 403 });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders(origin) });
  }
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "not found" }, 404, origin);
  }
  if (
    req.method === "PATCH" &&
    !url.pathname.startsWith("/api/task-briefs/") &&
    !url.pathname.startsWith("/api/im-runbooks/")
  ) {
    void req.body?.cancel();
    return jsonResponse({ error: "method not allowed" }, 405, origin);
  }
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
    !checkCsrf(req)
  ) {
    void req.body?.cancel();
    return jsonResponse(
      { error: "CSRF token missing or invalid" },
      403,
      origin,
    );
  }

  try {
    if (req.method === "GET") return await handleGet(ctx, req, url, origin);
    if (req.method === "POST") return await handlePost(ctx, req, url, origin);
    if (req.method === "PUT" || req.method === "PATCH")
      return await handlePut(ctx, req, url, origin);
    if (req.method === "DELETE") return await handleDelete(ctx, url, origin);
    return jsonResponse({ error: "method not allowed" }, 405, origin);
  } catch (e) {
    return jsonResponse(
      { error: e instanceof Error ? e.message : String(e) },
      500,
      origin,
    );
  }
}
