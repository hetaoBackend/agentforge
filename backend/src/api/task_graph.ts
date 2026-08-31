/**
 * Routes for task dependencies and the DAG view over them.
 */

import type { TaskDB } from "../db.ts";
import { DEFAULT_AGENT, makeTask, ScheduleType } from "../types.ts";

import {
  asString,
  idAt,
  jsonResponse,
  parseJsonList,
  type RouteArgs,
  type Row,
} from "./shared.ts";
import type { Route } from "./router.ts";

export function dependencyList(
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

export function attachDependencyMetadata(db: TaskDB, task: Row): Row {
  const tid = Number(task["id"]);
  return {
    ...task,
    dependencies: db.get_dependencies(tid),
    dependents: db.get_dependents(tid).map((d) => d["task_id"]),
  };
}

async function getTaskDependencies({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const tid = idAt(path);
  return tid === null
    ? jsonResponse({ error: "not found" }, 404, origin)
    : jsonResponse(ctx.db.get_dependencies(tid), 200, origin);
}

async function getTaskDependents({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const tid = idAt(path);
  return tid === null
    ? jsonResponse({ error: "not found" }, 404, origin)
    : jsonResponse(ctx.db.get_dependents(tid), 200, origin);
}

async function getDagTasks({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const dagId = decodeURIComponent(path.slice("/api/dag/".length));
  const tasks = ctx.db
    .get_dag_tasks(dagId)
    .map((t) => attachDependencyMetadata(ctx.db, t));
  return jsonResponse(tasks, 200, origin);
}

async function postDag({ ctx, origin, body }: RouteArgs): Promise<Response> {
  const taskDefs = Array.isArray(body["tasks"]) ? (body["tasks"] as Row[]) : [];
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

async function postTaskDependency({
  ctx,
  path,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  const tid = idAt(path);
  const depTaskId = Number(body["depends_on_task_id"]);
  if (tid === null || !Number.isInteger(depTaskId))
    return jsonResponse({ error: "depends_on_task_id required" }, 400, origin);
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

async function deleteTaskDependency({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const parts = path.split("/");
  const tid = Number(parts[3]);
  const depId = Number(parts[5]);
  ctx.db.remove_dependency(tid, depId);
  return jsonResponse({ status: "removed" }, 200, origin);
}

export const TASK_GRAPH_ROUTES: Array<Route<RouteArgs>> = [
  {
    method: "GET",
    pattern: "/api/tasks/:task_id/dependencies",
    handler: getTaskDependencies,
  },
  {
    method: "GET",
    pattern: "/api/tasks/:task_id/dependents",
    handler: getTaskDependents,
  },
  { method: "GET", pattern: "/api/dag/:dag_id+", handler: getDagTasks },
  { method: "POST", pattern: "/api/dag", handler: postDag },
  {
    method: "POST",
    pattern: "/api/tasks/:task_id/dependencies",
    handler: postTaskDependency,
  },
  {
    method: "DELETE",
    pattern: "/api/tasks/:task_id/dependencies/:dep_id",
    handler: deleteTaskDependency,
  },
];
