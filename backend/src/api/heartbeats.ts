/**
 * Routes for heartbeats and their ticks.
 */

import {
  DEFAULT_AGENT,
  type Heartbeat,
  HeartbeatScheduleType,
  makeHeartbeat,
} from "../types.ts";

import {
  type ApiContext,
  asBool,
  asString,
  cronValid,
  ensureWorkingDir,
  idAt,
  jsonResponse,
  type ResponseData,
  type RouteArgs,
  type Row,
} from "./shared.ts";
import type { Route } from "./router.ts";

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

async function getHeartbeats({ ctx, origin }: RouteArgs): Promise<Response> {
  return jsonResponse(ctx.db.get_all_heartbeats(), 200, origin);
}

async function getHeartbeatTickOutput({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
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

async function getHeartbeatTicks({
  ctx,
  url,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const hid = idAt(path);
  if (hid === null) return jsonResponse({ error: "not found" }, 404, origin);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  return jsonResponse(
    { ticks: ctx.db.get_heartbeat_ticks(hid, limit) },
    200,
    origin,
  );
}

async function getHeartbeat({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const hid = idAt(path);
  if (hid === null) return jsonResponse({ error: "not found" }, 404, origin);
  const heartbeat = ctx.db.get_heartbeat(hid);
  return heartbeat
    ? jsonResponse(heartbeat, 200, origin)
    : jsonResponse({ error: "not found" }, 404, origin);
}

async function postHeartbeat({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
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

async function postHeartbeatRunNow({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
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

async function postHeartbeatPause({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
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

async function postHeartbeatResume({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
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

async function putHeartbeat({
  ctx,
  path,
  origin,
  body,
}: RouteArgs): Promise<Response> {
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

async function deleteHeartbeat({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const hid = idAt(path);
  if (hid !== null) ctx.db.delete_heartbeat(hid);
  return jsonResponse({ status: "deleted" }, 200, origin);
}

export const HEARTBEAT_ROUTES: Array<Route<RouteArgs>> = [
  { method: "GET", pattern: "/api/heartbeats", handler: getHeartbeats },
  {
    method: "GET",
    pattern: "/api/heartbeats/:hid/ticks/:tick_id/output",
    handler: getHeartbeatTickOutput,
  },
  {
    method: "GET",
    pattern: "/api/heartbeats/:hid/ticks",
    handler: getHeartbeatTicks,
  },
  { method: "GET", pattern: "/api/heartbeats/:hid+", handler: getHeartbeat },
  { method: "POST", pattern: "/api/heartbeats", handler: postHeartbeat },
  {
    method: "POST",
    pattern: "/api/heartbeats/:hid/run-now",
    handler: postHeartbeatRunNow,
  },
  {
    method: "POST",
    pattern: "/api/heartbeats/:hid/pause",
    handler: postHeartbeatPause,
  },
  {
    method: "POST",
    pattern: "/api/heartbeats/:hid/resume",
    handler: postHeartbeatResume,
  },
  { method: "PUT", pattern: "/api/heartbeats/:hid", handler: putHeartbeat },
  {
    method: "DELETE",
    pattern: "/api/heartbeats/:hid+",
    handler: deleteHeartbeat,
  },
];
