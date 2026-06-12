#!/usr/bin/env bun
/**
 * AgentForge CLI - Command-line interface for AgentForge API
 *
 * Usage:
 *   agentforge_api.ts --method create --prompt "..." [options]
 *   agentforge_api.ts --method list [--status STATUS]
 *   agentforge_api.ts --method get --task-id ID
 *   agentforge_api.ts --method runs --task-id ID
 *   agentforge_api.ts --method output --task-id ID
 *   agentforge_api.ts --method events --task-id ID [--limit N]
 *   agentforge_api.ts --method cancel --task-id ID
 *   agentforge_api.ts --method retry --task-id ID
 *   agentforge_api.ts --method delete --task-id ID
 *   agentforge_api.ts --method dag --dag-id ID
 *   agentforge_api.ts --method health
 *
 * Examples:
 *   agentforge_api.ts --method create --prompt "Run tests" --title "Test run" --dir /path/to/project
 *   agentforge_api.ts --method create --prompt "Backup" --schedule delayed --delay 300
 *   agentforge_api.ts --method create --prompt "Deploy" --schedule scheduled_at --at "2026-02-15 14:30:00"
 *   agentforge_api.ts --method create --prompt "Daily report" --schedule cron --cron "0 2 * * *"
 *   agentforge_api.ts --method create --prompt "Step 2" --depends-on 10,11 --inject-result --dag-id my-pipeline
 *   agentforge_api.ts --method list --status running
 *   agentforge_api.ts --method dag --dag-id my-pipeline
 */

import { parseArgs } from "node:util";

const API_BASE = "http://127.0.0.1:9712/api";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function apiRequest(
  method: string,
  path: string,
  jsonData?: unknown,
  params?: Record<string, string | number>,
): Promise<any> {
  let url = `${API_BASE}${path}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    url += `?${qs.toString()}`;
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      ...(jsonData !== undefined
        ? { body: JSON.stringify(jsonData), headers: { "Content-Type": "application/json" } }
        : {}),
    });
  } catch (err: any) {
    const reason = String(err?.cause ?? err?.message ?? err);
    if (reason.includes("ECONNREFUSED") || reason.includes("Unable to connect")) {
      fail(
        "Connection failed: AgentForge is not running.\n" +
          "Start it with: cd <project-root>/backend && bun taskboard.ts",
      );
    }
    fail(`Network error: ${reason}`);
  }

  if (!resp.ok) {
    let detail: string = resp.statusText;
    try {
      const errBody: any = await resp.json();
      detail = errBody.error ?? resp.statusText;
    } catch {
      /* non-JSON error body */
    }
    fail(`API error (HTTP ${resp.status}): ${detail}`);
  }
  return resp.json();
}

const STATUS_ICONS: Record<string, string> = {
  pending: "🕐",
  scheduled: "⏰",
  running: "⏳",
  completed: "✅",
  failed: "❌",
  cancelled: "🚫",
  blocked: "⊘",
};

const METHODS = [
  "create",
  "list",
  "get",
  "runs",
  "output",
  "events",
  "cancel",
  "retry",
  "delete",
  "dag",
  "health",
] as const;

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    args: process.argv.slice(2),
    options: {
      method: { type: "string" },
      prompt: { type: "string" },
      title: { type: "string" },
      dir: { type: "string", default: "." },
      schedule: { type: "string", default: "immediate" },
      cron: { type: "string" },
      delay: { type: "string" },
      at: { type: "string" },
      "max-runs": { type: "string" },
      tags: { type: "string", default: "" },
      "image-paths": { type: "string" },
      "depends-on": { type: "string" },
      "inject-result": { type: "boolean", default: false },
      "dag-id": { type: "string" },
      "task-id": { type: "string" },
      status: { type: "string" },
      limit: { type: "string", default: "1000" },
      offset: { type: "string", default: "0" },
      json: { type: "boolean", default: false },
    },
  });

  const method = args.method;
  if (!method || !(METHODS as readonly string[]).includes(method)) {
    fail(`--method is required and must be one of: ${METHODS.join(", ")}`);
  }
  if (!["immediate", "delayed", "scheduled_at", "cron"].includes(args.schedule!)) {
    fail("--schedule must be one of: immediate, delayed, scheduled_at, cron");
  }

  const taskId = args["task-id"] ? Number(args["task-id"]) : undefined;
  const requireTaskId = (m: string): number => {
    if (!taskId) fail(`--task-id is required for ${m} method`);
    return taskId;
  };

  if (method === "create") {
    if (!args.prompt) fail("--prompt is required for create method");

    const data: Record<string, unknown> = {
      prompt: args.prompt,
      title: args.title || args.prompt.slice(0, 60),
      working_dir: args.dir,
      schedule_type: args.schedule,
      tags: args.tags,
    };

    if (args.cron) data.cron_expr = args.cron;
    if (args.delay) data.delay_seconds = Number(args.delay);
    if (args.at) {
      const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(args.at);
      if (!m) fail("Error: --at must be in format 'YYYY-MM-DD HH:MM:SS'");
      data.next_run_at = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    }
    if (args["max-runs"]) data.max_runs = Number(args["max-runs"]);
    if (args["dag-id"]) data.dag_id = args["dag-id"];
    if (args["image-paths"]) {
      data.image_paths = args["image-paths"]
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    }
    if (args["depends-on"]) {
      const ids = args["depends-on"]
        .split(",")
        .map((x) => x.trim())
        .filter((x) => /^\d+$/.test(x))
        .map(Number);
      data.depends_on = ids.map((tid) => ({
        task_id: tid,
        inject_result: args["inject-result"],
      }));
    }

    const result = await apiRequest("POST", "/tasks", data);
    console.log(JSON.stringify(result, null, 2));
  } else if (method === "list") {
    let tasks: any[] = await apiRequest("GET", "/tasks");

    if (args.status) tasks = tasks.filter((t) => t.status === args.status);

    if (args.json) {
      console.log(JSON.stringify(tasks, null, 2));
    } else {
      if (!tasks.length) console.log("No tasks found.");
      for (const task of tasks) {
        const icon = STATUS_ICONS[task.status] ?? "❓";
        const dagLabel = task.dag_id ? ` [dag:${task.dag_id}]` : "";
        console.log(`${icon} #${task.id}: ${task.title} (${task.status})${dagLabel}`);
      }
    }
  } else if (method === "get") {
    const id = requireTaskId("get");
    const task = await apiRequest("GET", `/tasks/${id}`);
    console.log(JSON.stringify(task, null, 2));
  } else if (method === "runs") {
    const id = requireTaskId("runs");
    const runs = await apiRequest("GET", `/tasks/${id}/runs`);
    console.log(JSON.stringify(runs, null, 2));
  } else if (method === "output") {
    const id = requireTaskId("output");
    const result = await apiRequest("GET", `/tasks/${id}/output`);

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.is_running) {
        console.log("Status: Running");
        console.log("\nOutput:");
      } else {
        console.log("Status: Not running");
      }
      console.log(result.output);
    }
  } else if (method === "events") {
    const id = requireTaskId("events");
    const result = await apiRequest("GET", `/tasks/${id}/events`, undefined, {
      limit: Number(args.limit),
      offset: Number(args.offset),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (method === "cancel") {
    const id = requireTaskId("cancel");
    const result = await apiRequest("POST", `/tasks/${id}/cancel`);
    console.log(JSON.stringify(result, null, 2));
  } else if (method === "retry") {
    const id = requireTaskId("retry");
    const result = await apiRequest("POST", `/tasks/${id}/retry`);
    console.log(JSON.stringify(result, null, 2));
  } else if (method === "delete") {
    const id = requireTaskId("delete");
    const result = await apiRequest("DELETE", `/tasks/${id}`);
    console.log(JSON.stringify(result, null, 2));
  } else if (method === "dag") {
    if (!args["dag-id"]) fail("--dag-id is required for dag method");
    const tasks: any[] = await apiRequest("GET", `/dag/${args["dag-id"]}`);
    if (args.json) {
      console.log(JSON.stringify(tasks, null, 2));
    } else {
      console.log(`DAG: ${args["dag-id"]} (${tasks.length} tasks)`);
      for (const task of tasks) {
        const icon = STATUS_ICONS[task.status] ?? "❓";
        const deps: any[] = task.dependencies ?? [];
        const depIds = deps.map((d) => `#${d.depends_on_task_id}`).join(", ");
        const depLabel = deps.length ? ` <- ${depIds}` : "";
        console.log(`  ${icon} #${task.id}: ${task.title} (${task.status})${depLabel}`);
      }
    }
  } else if (method === "health") {
    const result = await apiRequest("GET", "/health");
    console.log(JSON.stringify(result, null, 2));
  }
}

await main();
