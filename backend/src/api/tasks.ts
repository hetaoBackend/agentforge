/**
 * Routes for tasks: listing, run history, output and lifecycle actions.
 */

import { DEFAULT_AGENT, makeTask, ScheduleType, type Task } from "../types.ts";

import {
  type ApiContext,
  asString,
  cronNextIso,
  cronValid,
  ensureWorkingDir,
  idAt,
  jsonResponse,
  parseJsonList,
  type RouteArgs,
  type Row,
} from "./shared.ts";
import { attachDependencyMetadata, dependencyList } from "./task_graph.ts";
import type { Route } from "./router.ts";

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

async function getTasks({ ctx, origin }: RouteArgs): Promise<Response> {
  return jsonResponse(
    ctx.db.get_all_tasks().map((t) => attachDependencyMetadata(ctx.db, t)),
    200,
    origin,
  );
}

async function getTaskRuns({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const tid = idAt(path);
  return tid === null
    ? jsonResponse({ error: "not found" }, 404, origin)
    : jsonResponse(ctx.db.get_task_runs(tid), 200, origin);
}

async function getTaskOutput({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const tid = idAt(path);
  return tid === null
    ? jsonResponse({ error: "not found" }, 404, origin)
    : jsonResponse(taskOutputPayload(ctx, tid), 200, origin);
}

async function getTaskEvents({
  ctx,
  url,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const tid = idAt(path);
  if (tid === null) return jsonResponse({ error: "not found" }, 404, origin);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "1000", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const events = ctx.db.get_output_events(tid, limit, offset);
  return jsonResponse({ events, total: events.length }, 200, origin);
}

async function getTaskMessages({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const tid = idAt(path);
  return tid === null
    ? jsonResponse({ error: "not found" }, 404, origin)
    : jsonResponse(taskMessages(ctx, tid), 200, origin);
}

async function getTask({ ctx, path, origin }: RouteArgs): Promise<Response> {
  const tid = idAt(path);
  const task = tid === null ? null : ctx.db.get_task(tid);
  return task
    ? jsonResponse(attachDependencyMetadata(ctx.db, task), 200, origin)
    : jsonResponse({ error: "not found" }, 404, origin);
}

async function postTask({ ctx, origin, body }: RouteArgs): Promise<Response> {
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

async function postTaskCancel({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const tid = idAt(path);
  if (tid === null) return jsonResponse({ error: "not found" }, 404, origin);
  ctx.scheduler.cancel_task(tid);
  return jsonResponse({ status: "cancelled" }, 200, origin);
}

async function postTaskRetry({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const tid = idAt(path);
  if (tid === null) return jsonResponse({ error: "not found" }, 404, origin);
  ctx.scheduler.retry_task(tid);
  return jsonResponse({ status: "retrying" }, 200, origin);
}

async function postTaskRespond({
  ctx,
  path,
  origin,
  body,
}: RouteArgs): Promise<Response> {
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

async function postTaskResume({
  ctx,
  path,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  const tid = idAt(path);
  const task = tid === null ? null : ctx.db.get_task(tid);
  const message = asString(body["message"]).trim();
  if (!task || tid === null)
    return jsonResponse({ error: "not found" }, 404, origin);
  if (!message) return jsonResponse({ error: "message required" }, 400, origin);
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

async function putTask({
  ctx,
  path,
  origin,
  body,
}: RouteArgs): Promise<Response> {
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
  const scheduleType = asString(body["schedule_type"] ?? task["schedule_type"]);
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
    updates["image_paths"] = JSON.stringify(parseJsonList(body["image_paths"]));

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

async function deleteTask({ ctx, path, origin }: RouteArgs): Promise<Response> {
  const tid = idAt(path);
  if (tid !== null) ctx.db.delete_task(tid);
  return jsonResponse({ status: "deleted" }, 200, origin);
}

export const TASK_ROUTES: Array<Route<RouteArgs>> = [
  { method: "GET", pattern: "/api/tasks", handler: getTasks },
  { method: "GET", pattern: "/api/tasks/:task_id/runs", handler: getTaskRuns },
  {
    method: "GET",
    pattern: "/api/tasks/:task_id/output",
    handler: getTaskOutput,
  },
  {
    method: "GET",
    pattern: "/api/tasks/:task_id/events",
    handler: getTaskEvents,
  },
  {
    method: "GET",
    pattern: "/api/tasks/:task_id/messages",
    handler: getTaskMessages,
  },
  { method: "GET", pattern: "/api/tasks/:task_id+", handler: getTask },
  { method: "POST", pattern: "/api/tasks", handler: postTask },
  {
    method: "POST",
    pattern: "/api/tasks/:task_id/cancel",
    handler: postTaskCancel,
  },
  {
    method: "POST",
    pattern: "/api/tasks/:task_id/retry",
    handler: postTaskRetry,
  },
  {
    method: "POST",
    pattern: "/api/tasks/:task_id/respond",
    handler: postTaskRespond,
  },
  {
    method: "POST",
    pattern: "/api/tasks/:task_id/resume",
    handler: postTaskResume,
  },
  { method: "PUT", pattern: "/api/tasks/:task_id", handler: putTask },
  { method: "DELETE", pattern: "/api/tasks/:task_id+", handler: deleteTask },
];
