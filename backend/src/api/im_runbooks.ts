/**
 * Routes for IM runbooks: definition CRUD plus preview/run invocation.
 */

import { InboundMessageType, makeInboundMessage } from "../bus.ts";
import { runbook_from_row, type RunbookDefinition } from "../runbooks.ts";
import {
  type IMRunbook,
  makeIMRunbook,
  RunbookConfirmationPolicy,
  RunbookSourceType,
} from "../types.ts";

import {
  type ApiContext,
  asBool,
  asString,
  asStringList,
  idAt,
  jsonResponse,
  parseJsonObject,
  type ResponseData,
  type RouteArgs,
  type Row,
} from "./shared.ts";
import type { Route } from "./router.ts";

function slugifyCommandName(value: string): string {
  const compact = value.trim().replace(/\s+/g, "-").replace(/^\/+/, "");
  const ascii = compact
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || compact || "custom-command";
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

async function getIMRunbooks({ ctx, origin }: RouteArgs): Promise<Response> {
  return jsonResponse({ runbooks: allIMRunbooks(ctx) }, 200, origin);
}

async function postIMRunbook({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
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

async function postIMRunbookFromTask({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
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

async function postIMRunbookInvoke({
  ctx,
  path,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  const parts = path.split("/");
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

async function putIMRunbook({
  ctx,
  path,
  origin,
  body,
}: RouteArgs): Promise<Response> {
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

async function deleteIMRunbook({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const rid = idAt(path);
  if (rid === null)
    return jsonResponse({ error: "invalid runbook id" }, 400, origin);
  ctx.db.delete_im_runbook(rid);
  return jsonResponse({ status: "deleted" }, 200, origin);
}

export const IM_RUNBOOK_ROUTES: Array<Route<RouteArgs>> = [
  { method: "GET", pattern: "/api/im-runbooks", handler: getIMRunbooks },
  { method: "POST", pattern: "/api/im-runbooks", handler: postIMRunbook },
  {
    method: "POST",
    pattern: "/api/im-runbooks/from-task",
    handler: postIMRunbookFromTask,
  },
  {
    method: "POST",
    pattern: "/api/im-runbooks/:name/preview",
    handler: postIMRunbookInvoke,
  },
  {
    method: "POST",
    pattern: "/api/im-runbooks/:name/run",
    handler: postIMRunbookInvoke,
  },
  {
    method: "PUT",
    pattern: "/api/im-runbooks/:runbook_id",
    handler: putIMRunbook,
  },
  {
    method: "DELETE",
    pattern: "/api/im-runbooks/:runbook_id+",
    handler: deleteIMRunbook,
  },
];
