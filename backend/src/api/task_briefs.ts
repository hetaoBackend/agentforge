/**
 * Routes for task briefs and their promotion into tasks.
 */

import {
  DEFAULT_AGENT,
  makeTask,
  makeTaskBrief,
  ScheduleType,
  type Task,
  type TaskBrief,
  TaskBriefStatus,
} from "../types.ts";

import {
  type ApiContext,
  asBool,
  asString,
  asStringList,
  ensureWorkingDir,
  idAt,
  jsonResponse,
  parseJsonObject,
  type ResponseData,
  type RouteArgs,
  type Row,
} from "./shared.ts";
import type { Route } from "./router.ts";

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

async function getTaskBriefs({
  ctx,
  url,
  origin,
}: RouteArgs): Promise<Response> {
  const status = url.searchParams.get("status");
  return jsonResponse(
    { briefs: ctx.db.get_task_briefs(status || null) },
    200,
    origin,
  );
}

async function getTaskBrief({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const bid = idAt(path);
  const brief = bid === null ? null : ctx.db.get_task_brief(bid);
  return brief
    ? jsonResponse(brief, 200, origin)
    : jsonResponse({ error: "not found" }, 404, origin);
}

async function postTaskBrief({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
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

async function postTaskBriefConfirm({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
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

async function postTaskBriefDiscard({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
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

async function putTaskBrief({
  ctx,
  path,
  origin,
  body,
}: RouteArgs): Promise<Response> {
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

export const TASK_BRIEF_ROUTES: Array<Route<RouteArgs>> = [
  { method: "GET", pattern: "/api/task-briefs", handler: getTaskBriefs },
  {
    method: "GET",
    pattern: "/api/task-briefs/:brief_id+",
    handler: getTaskBrief,
  },
  { method: "POST", pattern: "/api/task-briefs", handler: postTaskBrief },
  {
    method: "POST",
    pattern: "/api/task-briefs/:brief_id/confirm",
    handler: postTaskBriefConfirm,
  },
  {
    method: "POST",
    pattern: "/api/task-briefs/:brief_id/discard",
    handler: postTaskBriefDiscard,
  },
  {
    method: "PUT",
    pattern: "/api/task-briefs/:brief_id",
    handler: putTaskBrief,
  },
];
