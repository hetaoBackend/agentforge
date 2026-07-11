import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MessageBus } from "../src/bus.ts";
import { TaskDB } from "../src/db.ts";
import { TaskScheduler } from "../src/scheduler.ts";
import { handleApiRequest, type ApiContext } from "../src/api.ts";
import { FeishuChannel } from "../src/channels/feishu.ts";
import { makeTask } from "../src/types.ts";

describe("api handler", () => {
  let tmpDir: string;
  let db: TaskDB;
  let scheduler: TaskScheduler;
  let ctx: ApiContext;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-api-test-"));
    db = new TaskDB(path.join(tmpDir, "api-test.db"));
    const bus = new MessageBus();
    scheduler = new TaskScheduler(db, null, bus);
    ctx = {
      db,
      scheduler,
      bus,
      telegram_channel: null,
      slack_channel: null,
      weixin_channel: null,
      feishu_channel: null,
    };
  });

  afterEach(() => {
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function json(req: Request): Promise<any> {
    const res = await handleApiRequest(ctx, req);
    return (await res.json()) as Record<string, any>;
  }

  function createSkillCandidate(channel: string = "slack"): number {
    const taskId = db.add_task(
      makeTask({
        title: "Fix frontend CI",
        prompt: "Investigate the failed build.",
        tags: `runbook,fix-ci,${channel}`,
      }),
    );
    const patternId = db.upsert_skill_pattern(
      "fix-ci-investigation",
      "recipe",
      "Investigate a failed CI run and patch the minimal issue.",
      taskId,
      100,
    )!;
    db.upsert_skill_pattern(
      "fix-ci-investigation",
      "recipe",
      "Investigate a failed CI run and patch the minimal issue.",
      taskId,
      101,
    );
    db.upsert_skill_pattern(
      "fix-ci-investigation",
      "recipe",
      "Investigate a failed CI run and patch the minimal issue.",
      taskId,
      102,
    );
    db.set_skill_pattern_status(patternId, "candidate");
    return patternId;
  }

  function createReadySkillDraft(): number {
    const patternId = createSkillCandidate();
    db.upsert_skill_draft(
      patternId,
      "ready",
      "fix-ci-investigation",
      "Reusable CI investigation workflow.",
      "recipe",
      "---\nname: fix-ci-investigation\ndescription: Reusable CI investigation workflow.\n---\n# Fix CI\n",
    );
    return patternId;
  }

  test("GET /api/health returns ok and task count", async () => {
    const res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/health"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", tasks: 0 });
  });

  test("GET /api/health allows Electrobun view origins", async () => {
    const res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/health", {
        headers: { Origin: "views://main" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("views://main");
    expect(await res.json()).toEqual({ status: "ok", tasks: 0 });
  });

  test("POST /api/tasks enforces browser CSRF and creates tasks with token", async () => {
    const body = JSON.stringify({
      title: "API task",
      prompt: "ship it",
      working_dir: ".",
    });
    const rejected = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
        },
        body,
      }),
    );
    expect(rejected.status).toBe(403);

    const csrf = await json(
      new Request("http://127.0.0.1:9712/api/csrf-token", {
        headers: { Origin: "http://localhost:5173" },
      }),
    );
    const created = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf["csrf_token"],
        },
        body,
      }),
    );
    expect(created.status).toBe(201);
    const payload = (await created.json()) as Record<string, any>;
    expect(payload["status"]).toBe("created");

    const tasks = await json(new Request("http://127.0.0.1:9712/api/tasks"));
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]["title"]).toBe("API task");
    expect(tasks[0]["dependencies"]).toEqual([]);
    expect(tasks[0]["dependents"]).toEqual([]);
  });

  test("GET task output falls back to latest persisted raw output", async () => {
    const created = await json(
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Run",
          prompt: "do it",
          working_dir: ".",
        }),
      }),
    );
    const taskId = Number(created["id"]);
    const runId = db.add_run(taskId);
    db.finish_run(runId, "completed", "ok", null, "raw output");

    const output = await json(
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/output`),
    );
    expect(output).toEqual({ output: "raw output", is_running: false });
  });

  test("task brief API creates lists updates reads and discards drafts", async () => {
    const createdRes = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/task-briefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Fix auth",
          goal: "Fix login redirect",
          context_summary: "Forwarded QA report",
          acceptance_criteria: ["Identify cause", "Patch minimal code"],
          working_dir: ".",
          working_dir_confidence: "high",
          agent: "codex",
          source_channel: "telegram",
          source_ref: "chat-1:msg-2",
          source_metadata: { chat_id: "chat-1" },
        }),
      }),
    );
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as Record<string, any>;
    const id = Number(created["id"]);
    expect(created["status"]).toBe("draft");

    const listed = await json(
      new Request("http://127.0.0.1:9712/api/task-briefs"),
    );
    expect(listed["briefs"]).toHaveLength(1);
    expect(listed["briefs"][0]["source_metadata"]).toEqual({
      chat_id: "chat-1",
    });

    const loaded = await json(
      new Request(`http://127.0.0.1:9712/api/task-briefs/${id}`),
    );
    expect(loaded["title"]).toBe("Fix auth");
    expect(loaded["acceptance_criteria"]).toEqual([
      "Identify cause",
      "Patch minimal code",
    ]);

    const patched = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/task-briefs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Fix auth v2",
          acceptance_criteria: ["Patch", "Test"],
        }),
      }),
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as Record<string, any>;
    expect(patchedBody["title"]).toBe("Fix auth v2");
    expect(patchedBody["acceptance_criteria"]).toEqual(["Patch", "Test"]);

    const discarded = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/task-briefs/${id}/discard`, {
        method: "POST",
      }),
    );
    expect(discarded.status).toBe(200);
    const discardedBody = (await discarded.json()) as Record<string, any>;
    expect(discardedBody["status"]).toBe("discarded");
  });

  test("confirming a task brief creates a normal task", async () => {
    const created = await json(
      new Request("http://127.0.0.1:9712/api/task-briefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Fix auth",
          goal: "Fix login redirect",
          context_summary: "Forwarded QA report",
          acceptance_criteria: ["Identify cause", "Patch minimal code"],
          working_dir: ".",
          working_dir_confidence: "high",
          agent: "codex",
          source_channel: "telegram",
          source_ref: "chat-1:msg-2",
          source_metadata: { chat_id: "chat-1" },
        }),
      }),
    );

    const confirmedRes = await handleApiRequest(
      ctx,
      new Request(
        `http://127.0.0.1:9712/api/task-briefs/${created["id"]}/confirm`,
        { method: "POST" },
      ),
    );
    expect(confirmedRes.status).toBe(201);
    const confirmed = (await confirmedRes.json()) as Record<string, any>;
    expect(confirmed["status"]).toBe("created");

    const task = db.get_task(Number(confirmed["task_id"]))!;
    expect(task["title"]).toContain("Fix auth");
    expect(task["working_dir"]).toBe(".");
    expect(task["agent"]).toBe("codex");
    expect(task["tags"]).toContain("im-inbox");
    expect(task["tags"]).toContain("telegram");
    expect(task["prompt"]).toContain("Goal:");
    expect(task["prompt"]).toContain("Fix login redirect");
    expect(task["prompt"]).toContain("Context:");
    expect(task["prompt"]).toContain("Forwarded QA report");
    expect(task["prompt"]).toContain("Acceptance criteria:");
    expect(task["prompt"]).toContain("1. Identify cause");

    const brief = db.get_task_brief(Number(created["id"]))!;
    expect(brief["status"]).toBe("converted");
    expect(brief["created_task_id"]).toBe(Number(confirmed["task_id"]));
  });

  test("concurrent brief confirms create one task and return a conflict", async () => {
    const created = await json(
      new Request("http://127.0.0.1:9712/api/task-briefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Fix auth",
          goal: "Fix login redirect",
          working_dir: ".",
          source_channel: "telegram",
          source_ref: "chat-1:concurrent",
        }),
      }),
    );
    const request = () =>
      handleApiRequest(
        ctx,
        new Request(
          `http://127.0.0.1:9712/api/task-briefs/${created["id"]}/confirm`,
          { method: "POST" },
        ),
      );

    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(((await conflict.json()) as Record<string, any>)["error"]).toContain(
      "Cannot confirm draft task",
    );
    expect(db.get_all_tasks()).toHaveLength(1);
  });

  test("failed brief confirmation leaves the draft retryable", async () => {
    const created = await json(
      new Request("http://127.0.0.1:9712/api/task-briefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Retry confirmation",
          goal: "Create exactly one task",
          working_dir: ".",
          source_channel: "telegram",
          source_ref: "chat-1:retry",
        }),
      }),
    );
    const originalSubmitTask = scheduler.submit_task.bind(scheduler);
    scheduler.submit_task = (() => {
      throw new Error("injected confirmation failure");
    }) as typeof scheduler.submit_task;

    const failed = await handleApiRequest(
      ctx,
      new Request(
        `http://127.0.0.1:9712/api/task-briefs/${created["id"]}/confirm`,
        { method: "POST" },
      ),
    );
    expect(failed.status).toBe(500);
    expect(db.get_task_brief(Number(created["id"]))!["status"]).toBe("draft");
    expect(db.get_all_tasks()).toEqual([]);

    scheduler.submit_task = originalSubmitTask;
    const retried = await handleApiRequest(
      ctx,
      new Request(
        `http://127.0.0.1:9712/api/task-briefs/${created["id"]}/confirm`,
        { method: "POST" },
      ),
    );
    expect(retried.status).toBe(201);
    expect(db.get_all_tasks()).toHaveLength(1);
  });

  test("IM runbook API starts empty and supports user command CRUD", async () => {
    const initial = await json(
      new Request("http://127.0.0.1:9712/api/im-runbooks"),
    );
    expect(initial["runbooks"]).toEqual([]);

    const createdRes = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/im-runbooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "看报错",
          aliases: ["issue-triage"],
          description: "分析报错",
          command_schema: { args: ["内容"] },
          prompt_template: "分析这段报错：{{raw_args}}",
          default_agent: "codex",
          confirmation_policy: "required",
          enabled: true,
        }),
      }),
    );
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as Record<string, any>;
    expect(created["name"]).toBe("看报错");
    expect(created["aliases"]).toEqual(["issue-triage"]);

    const patchedRes = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/im-runbooks/${created["id"]}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: "分析线上报错",
          enabled: false,
        }),
      }),
    );
    expect(patchedRes.status).toBe(200);
    const patched = (await patchedRes.json()) as Record<string, any>;
    expect(patched["description"]).toBe("分析线上报错");
    expect(patched["enabled"]).toBe(false);

    const deleted = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/im-runbooks/${created["id"]}`, {
        method: "DELETE",
      }),
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ status: "deleted" });
    expect(db.get_im_runbook(Number(created["id"]))).toBeNull();
  });

  test("IM runbook API creates a custom command from a previous task", async () => {
    const taskId = db.add_task(
      makeTask({
        title: "整理客户反馈",
        prompt: "请把下面的客户反馈整理成产品需求、风险和下一步行动。",
        result: "done",
        status: "completed",
        working_dir: "~/agentforge",
        agent: "codex",
      }),
    );

    const createdRes = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/im-runbooks/from-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: taskId,
          name: "整理反馈",
          description: "把客户反馈整理成行动项",
          confirmation_policy: "auto",
        }),
      }),
    );

    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as Record<string, any>;
    expect(created["name"]).toBe("整理反馈");
    expect(created["source_type"]).toBe("task");
    expect(created["source_id"]).toBe(String(taskId));
    expect(created["prompt_template"]).toContain(
      "请把下面的客户反馈整理成产品需求、风险和下一步行动。",
    );
    expect(created["prompt_template"]).toContain("{{raw_args}}");
    expect(created["default_agent"]).toBe("codex");
    expect(created["confirmation_policy"]).toBe("auto");
  });

  test("IM runbook API previews a user runbook as a task brief", async () => {
    const created = await json(
      new Request("http://127.0.0.1:9712/api/im-runbooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "triage-issue",
          description: "Triage an issue",
          prompt_template: "Triage this issue: {{raw_args}}",
          confirmation_policy: "required",
        }),
      }),
    );
    expect(created["id"]).toBeTruthy();

    const previewRes = await handleApiRequest(
      ctx,
      new Request(
        "http://127.0.0.1:9712/api/im-runbooks/triage-issue/preview",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            raw_args: "https://github.com/acme/app/issues/12",
            source_channel: "api",
            source_ref: "api:test",
            working_dir: ".",
          }),
        },
      ),
    );
    expect(previewRes.status).toBe(201);
    const preview = (await previewRes.json()) as Record<string, any>;
    expect(preview).toEqual({
      brief_id: 1,
      runbook: "triage-issue",
      status: "draft",
    });
    expect(db.get_task_brief(1)!["goal"]).toContain(
      "https://github.com/acme/app/issues/12",
    );
    expect(db.get_all_tasks()).toHaveLength(0);
  });

  test("IM runbook API only runs user-created commands", async () => {
    const missing = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/im-runbooks/review-pr/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_args: "https://github.com/acme/app/pull/42",
          source_channel: "api",
          source_ref: "api:test",
          working_dir: ".",
          agent: "codex",
        }),
      }),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "Unknown command: review-pr",
    });

    await json(
      new Request("http://127.0.0.1:9712/api/im-runbooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "看-pr",
          description: "Review a pull request",
          prompt_template: "Review this pull request:\n{{raw_args}}",
          confirmation_policy: "auto",
        }),
      }),
    );

    const runRes = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/im-runbooks/%E7%9C%8B-pr/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_args: "https://github.com/acme/app/pull/42",
          source_channel: "api",
          source_ref: "api:test",
          working_dir: ".",
          agent: "codex",
        }),
      }),
    );
    expect(runRes.status).toBe(201);
    const run = (await runRes.json()) as Record<string, any>;
    expect(run).toEqual({
      runbook: "看-pr",
      status: "created",
      task_id: 1,
    });
    expect(db.get_task(1)!["prompt"]).toContain(
      "https://github.com/acme/app/pull/42",
    );
  });

  test("IM digest API previews recent activity", async () => {
    db.add_task(
      makeTask({
        title: "Ship auth fix",
        prompt: "fix auth",
        status: "completed",
      }),
    );

    const previewRes = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/im-digests/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ include_empty: false }),
      }),
    );

    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as Record<string, any>;
    expect(preview["status"]).toBe("ready");
    expect(preview["text"]).toContain("AgentForge Standup");
    expect(preview["text"]).toContain("Ship auth fix");
    expect(preview["digest"]["sections"][0]["key"]).toBe("completed");
  });

  test("IM digest API sends to explicit Slack recipients", async () => {
    db.add_task(
      makeTask({
        title: "Ship auth fix",
        prompt: "fix auth",
        status: "completed",
      }),
    );
    const reply = mock(async () => undefined);
    ctx.slack_channel = { _reply: reply } as any;

    const sendRes = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/im-digests/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipients: [{ channel: "slack", target: "C1" }],
        }),
      }),
    );

    expect(sendRes.status).toBe(200);
    const sent = (await sendRes.json()) as Record<string, any>;
    expect(sent["status"]).toBe("sent");
    expect(sent["sent"]).toBe(1);
    expect(reply).toHaveBeenCalledWith(
      "C1",
      null,
      expect.stringContaining("Ship auth fix"),
    );
  });

  test("IM digest API returns conflict when send has no recipients", async () => {
    const sendRes = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/im-digests/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ include_empty: true }),
      }),
    );

    expect(sendRes.status).toBe(409);
    expect(await sendRes.json()).toEqual({
      error: "no digest recipients configured",
    });
  });

  test("POST /api/feishu/settings restarts the Feishu channel", async () => {
    const old = {
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };
    ctx.feishu_channel = old as any;

    const enabled = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/feishu/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feishu_enabled: "true" }),
      }),
    );

    expect(enabled.status).toBe(200);
    expect(old.stopped).toBe(true);
    expect(ctx.feishu_channel).toBeInstanceOf(FeishuChannel);
    expect(db.get_setting("feishu_enabled")).toBe("true");

    const started = ctx.feishu_channel;
    const disabled = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/feishu/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feishu_enabled: "false" }),
      }),
    );

    expect(disabled.status).toBe(200);
    expect(ctx.feishu_channel).toBeNull();
    expect(started?._running).toBe(false);
    expect(db.get_setting("feishu_enabled")).toBe("false");
  });

  test("Feishu settings mask and preserve the app secret", async () => {
    db.set_setting("feishu_app_secret", "existing-secret");

    const settings = await json(
      new Request("http://127.0.0.1:9712/api/feishu/settings"),
    );
    expect(settings.feishu_app_secret).toBe("********");
    expect(settings.feishu_app_secret_set).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("existing-secret");

    for (const unchangedValue of ["", "********", "••••••••"]) {
      const unchanged = await handleApiRequest(
        ctx,
        new Request("http://127.0.0.1:9712/api/feishu/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feishu_app_secret: unchangedValue }),
        }),
      );
      expect(unchanged.status).toBe(200);
      expect(db.get_setting("feishu_app_secret")).toBe("existing-secret");
    }

    const updated = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/feishu/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feishu_app_secret: "replacement-secret" }),
      }),
    );
    expect(updated.status).toBe(200);
    expect(db.get_setting("feishu_app_secret")).toBe("replacement-secret");
  });

  test("DELETE /api/tasks enforces CSRF for browser origins", async () => {
    const created = await json(
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Delete me",
          prompt: "later",
          schedule_type: "delayed",
          delay_seconds: 999,
        }),
      }),
    );
    const taskId = Number(created["id"]);

    const rejected = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}`, {
        method: "DELETE",
        headers: {
          Origin: "http://localhost:5173",
          "X-CSRF-Token": "wrong",
        },
      }),
    );

    expect(rejected.status).toBe(403);
    expect(db.get_task(taskId)).not.toBeNull();

    const csrf = await json(
      new Request("http://127.0.0.1:9712/api/csrf-token", {
        headers: { Origin: "http://localhost:5173" },
      }),
    );
    const accepted = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}`, {
        method: "DELETE",
        headers: {
          Origin: "http://localhost:5173",
          "X-CSRF-Token": csrf["csrf_token"],
        },
      }),
    );

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ status: "deleted" });
    expect(db.get_task(taskId)).toBeNull();

    const repeated = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}`, {
        method: "DELETE",
        headers: {
          Origin: "http://localhost:5173",
          "X-CSRF-Token": csrf["csrf_token"],
        },
      }),
    );
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ status: "deleted" });
  });

  test("running task cannot be deleted or retried", async () => {
    const taskId = db.add_task(
      makeTask({ title: "Running", prompt: "busy", working_dir: "." }),
    );
    db.update_task(taskId, { status: "running" });
    scheduler._active_tasks.set(taskId, { is_alive: () => true });

    const deleted = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}`, {
        method: "DELETE",
      }),
    );
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toEqual({
      error: "cannot delete task while execution is active",
    });
    expect(db.get_task(taskId)!["status"]).toBe("running");

    const retried = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/retry`, {
        method: "POST",
      }),
    );
    expect(retried.status).toBe(409);
    expect(await retried.json()).toEqual({
      error: "cannot retry task while execution is active",
    });
    expect(db.get_task(taskId)!["status"]).toBe("running");

    db.update_task(taskId, { status: "cancelled" });
    const deleteWhileStopping = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}`, {
        method: "DELETE",
      }),
    );
    expect(deleteWhileStopping.status).toBe(409);
    expect(db.get_task(taskId)).not.toBeNull();
  });

  test("POST /api/channels/settings stops existing disabled channels", async () => {
    const stopped: string[] = [];
    ctx.telegram_channel = { stop: () => stopped.push("telegram") } as any;
    ctx.slack_channel = { stop: () => stopped.push("slack") } as any;
    ctx.weixin_channel = { stop: () => stopped.push("weixin") } as any;
    ctx.feishu_channel = { stop: () => stopped.push("feishu") } as any;

    const res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/channels/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          telegram_enabled: "false",
          slack_enabled: "false",
          weixin_enabled: "false",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(stopped).toEqual(["telegram", "slack", "weixin", "feishu"]);
    expect(ctx.telegram_channel).toBeNull();
    expect(ctx.slack_channel).toBeNull();
    expect(ctx.weixin_channel).toBeNull();
    expect(ctx.feishu_channel).toBeNull();
  });

  test("POST /api/dag accepts prompt_images as JSON string", async () => {
    const res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/dag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dag_id: "imgdag",
          tasks: [
            {
              ref: "a",
              prompt: "first",
              schedule_type: "immediate",
              prompt_images: JSON.stringify([
                { media_type: "image/png", data: "AAA" },
              ]),
            },
          ],
        }),
      }),
    );

    expect(res.status).toBe(201);
    const payload = (await res.json()) as Record<string, any>;
    const taskId = Number(payload["task_ids"]["a"]);
    expect(db.get_task(taskId)!["prompt_images"]).toEqual([
      { media_type: "image/png", data: "AAA" },
    ]);
  });

  test("POST /api/dag falls back to empty prompt_images for bad JSON", async () => {
    const res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/dag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: [
            {
              ref: "a",
              prompt: "first",
              schedule_type: "immediate",
              prompt_images: "{not json",
            },
          ],
        }),
      }),
    );

    expect(res.status).toBe(201);
    const payload = (await res.json()) as Record<string, any>;
    const taskId = Number(payload["task_ids"]["a"]);
    expect(db.get_task(taskId)!["prompt_images"]).toEqual([]);
  });

  test("POST /api/tasks/:id/resume returns 404 for missing tasks", async () => {
    const res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks/99999/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "go" }),
      }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("POST rejects declared bodies larger than the API cap", async () => {
    const res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(10 * 1024 * 1024 + 1),
        },
        body: "{}",
      }),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body too large" });
  });

  test("POST rejects streamed bodies larger than the API cap", async () => {
    const chunk = new Uint8Array(6 * 1024 * 1024);
    chunk.fill(0x20);
    const req = new Request("http://127.0.0.1:9712/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }),
    });
    expect(req.headers.get("Content-Length")).toBeNull();

    const res = await handleApiRequest(ctx, req);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body too large" });
  });

  test("CORS, method, and JSON error paths return explicit responses", async () => {
    const forbiddenOrigin = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/health", {
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(forbiddenOrigin.status).toBe(403);

    const options = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173" },
      }),
    );
    expect(options.status).toBe(200);
    expect(options.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173",
    );

    const invalidJson = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ error: "invalid JSON body" });

    const methodNotAllowed = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks", { method: "PATCH" }),
    );
    expect(methodNotAllowed.status).toBe(405);
    expect(await methodNotAllowed.json()).toEqual({
      error: "method not allowed",
    });

    const outsideApi = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/not-api"),
    );
    expect(outsideApi.status).toBe(404);
  });

  test("GET settings and channel status expose stored non-secret configuration", async () => {
    db.set_setting("timeout", "123");
    db.set_setting("default_agent", "codex");
    db.set_setting("skill_library_enabled", "1");
    db.set_setting("skill_sweep_agent", "claude");
    db.set_setting("skill_sweep_cron", "5 4 * * *");
    db.set_setting("im_digest_enabled", "1");
    db.set_setting("im_digest_cron", "0 8 * * 1-5");
    db.set_setting(
      "im_digest_channels",
      JSON.stringify([{ channel: "slack", target: "C1" }]),
    );
    db.set_setting("im_attention_digest_minutes", "15");
    db.set_setting("im_skill_suggestions_enabled", "1");
    db.set_setting(
      "im_skill_suggestion_channels",
      JSON.stringify([{ channel: "slack", target: "C2" }]),
    );
    db.set_setting("telegram_enabled", "true");
    db.set_setting("telegram_bot_token", "tg-secret");
    db.set_setting("telegram_allowed_users", "42");
    db.set_setting("telegram_default_working_dir", "~/tg");
    db.set_setting("telegram_default_chat_id", "-10042");
    db.set_setting("slack_enabled", "true");
    db.set_setting("slack_bot_token", "xoxb");
    db.set_setting("slack_app_token", "xapp");
    db.set_setting("slack_default_channel", "C42");
    db.set_setting("weixin_enabled", "true");
    db.set_setting("weixin_account_id", "configured-account");
    ctx.weixin_channel = {
      _running: true,
      get_status_snapshot: () => ({
        configured: true,
        login_status: "logged_in",
        account_id: "runtime-account",
        qr_code_url: "qr",
        user_id: "wx-user",
      }),
    } as any;

    const settings = await json(
      new Request("http://127.0.0.1:9712/api/settings"),
    );
    expect(settings).toEqual({
      default_agent: "codex",
      timeout: 123,
      skill_library_enabled: true,
      skill_sweep_agent: "claude",
      skill_sweep_cron: "5 4 * * *",
      im_digest_enabled: true,
      im_digest_cron: "0 8 * * 1-5",
      im_digest_channels: [{ channel: "slack", target: "C1" }],
      im_attention_digest_minutes: 15,
      im_skill_suggestions_enabled: true,
      im_skill_suggestion_channels: [{ channel: "slack", target: "C2" }],
    });

    const status = await json(
      new Request("http://127.0.0.1:9712/api/channels/status"),
    );
    expect(status.telegram).toEqual({
      enabled: true,
      configured: true,
      running: false,
      default_working_dir: "~/tg",
      default_chat_id: "-10042",
      allowed_users: "42",
    });
    expect(status.slack.configured).toBe(true);
    expect(status.slack.default_channel).toBe("C42");
    expect(status.weixin.account_id).toBe("runtime-account");
    expect(status.weixin.running).toBe(true);
    expect(status.weixin.login_status).toBe("logged_in");
  });

  test("POST and PUT settings reject non-editable keys without partial writes", async () => {
    const post = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeout: 90,
          skill_sweep_next_run: "2030-01-01T00:00:00",
        }),
      }),
    );
    expect(post.status).toBe(400);
    expect(await post.json()).toEqual({
      error: "unknown or non-editable setting: skill_sweep_next_run",
      field: "skill_sweep_next_run",
    });
    expect(db.get_setting("timeout")).toBeNull();
    expect(db.get_setting("skill_sweep_next_run")).toBeNull();

    const put = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegram_bot_token: "credential" }),
      }),
    );
    expect(put.status).toBe(400);
    expect(db.get_setting("telegram_bot_token")).toBeNull();

    const allowed = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeout: 90, default_agent: "claude" }),
      }),
    );
    expect(allowed.status).toBe(200);
    expect(db.get_setting("timeout")).toBe("90");
    expect(db.get_setting("default_agent")).toBe("claude");
  });

  test("task detail routes expose runs, events, messages, and dependency metadata", async () => {
    const upstream = await json(
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Upstream",
          prompt: "prepare",
          working_dir: ".",
          dag_id: "dag-api",
        }),
      }),
    );
    const upstreamId = Number(upstream["id"]);

    const downstream = await json(
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Downstream",
          prompt: "consume",
          working_dir: ".",
          dag_id: "dag-api",
          depends_on: [{ task_id: upstreamId, inject_result: true }],
        }),
      }),
    );
    const downstreamId = Number(downstream["id"]);

    const runId = db.add_run(downstreamId);
    const raw = [
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      "not-json",
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "world" }] },
      }),
    ].join("\n");
    db.finish_run(runId, "completed", "done", null, raw);
    db.add_output_event(downstreamId, runId, "assistant", "event-content");

    const task = await json(
      new Request(`http://127.0.0.1:9712/api/tasks/${downstreamId}`),
    );
    expect(task.dependencies).toEqual([
      expect.objectContaining({
        task_id: downstreamId,
        depends_on_task_id: upstreamId,
        inject_result: 1,
      }),
    ]);

    const dependents = await json(
      new Request(`http://127.0.0.1:9712/api/tasks/${upstreamId}/dependents`),
    );
    expect(dependents.map((d: any) => d.task_id)).toEqual([downstreamId]);

    const deps = await json(
      new Request(
        `http://127.0.0.1:9712/api/tasks/${downstreamId}/dependencies`,
      ),
    );
    expect(deps).toEqual([
      expect.objectContaining({
        task_id: downstreamId,
        depends_on_task_id: upstreamId,
        inject_result: 1,
      }),
    ]);

    const runs = await json(
      new Request(`http://127.0.0.1:9712/api/tasks/${downstreamId}/runs`),
    );
    expect(runs[0].id).toBe(runId);

    const events = await json(
      new Request(
        `http://127.0.0.1:9712/api/tasks/${downstreamId}/events?limit=5&offset=0`,
      ),
    );
    expect(events.total).toBe(1);
    expect(events.events[0].content).toBe("event-content");

    const messages = await json(
      new Request(`http://127.0.0.1:9712/api/tasks/${downstreamId}/messages`),
    );
    expect(messages.map((m: any) => [m.role, m.text])).toEqual([
      ["user", "hello"],
      ["assistant", "world"],
    ]);

    const dag = await json(
      new Request("http://127.0.0.1:9712/api/dag/dag-api"),
    );
    expect(
      dag.map((t: any) => t.id).sort((a: number, b: number) => a - b),
    ).toEqual([upstreamId, downstreamId]);
  });

  test("POST /api/tasks validates prompt, working dir, and cron schedules", async () => {
    const emptyPrompt = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "   " }),
      }),
    );
    expect(emptyPrompt.status).toBe(400);
    expect(await emptyPrompt.json()).toEqual({
      error: "prompt cannot be empty",
      field: "prompt",
    });

    const badDir = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "x",
          working_dir: path.join(tmpDir, "missing"),
        }),
      }),
    );
    expect(badDir.status).toBe(400);
    expect(((await badDir.json()) as Record<string, any>).field).toBe(
      "working_dir",
    );

    const missingCron = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "x", schedule_type: "cron" }),
      }),
    );
    expect(missingCron.status).toBe(400);

    const invalidCron = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "x",
          schedule_type: "cron",
          cron_expr: "not cron",
        }),
      }),
    );
    expect(invalidCron.status).toBe(400);
    expect(((await invalidCron.json()) as Record<string, any>).field).toBe(
      "cron_expr",
    );
  });

  test("dependency APIs reject self, two-node, and longer cycles", async () => {
    const createTask = (title: string) =>
      json(
        new Request("http://127.0.0.1:9712/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, prompt: title }),
        }),
      );
    const [a, b, c, independent] = await Promise.all([
      createTask("a"),
      createTask("b"),
      createTask("c"),
      createTask("independent"),
    ]);
    const addDependency = (taskId: number, dependencyId: number) =>
      handleApiRequest(
        ctx,
        new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/dependencies`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ depends_on_task_id: dependencyId }),
        }),
      );

    expect((await addDependency(Number(b.id), Number(a.id))).status).toBe(200);
    expect((await addDependency(Number(a.id), Number(b.id))).status).toBe(409);
    expect(db.get_dependencies(Number(a.id))).toEqual([]);

    expect((await addDependency(Number(c.id), Number(b.id))).status).toBe(200);
    expect(
      (await addDependency(Number(independent.id), Number(independent.id)))
        .status,
    ).toBe(409);

    const batchCycle = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${a.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          depends_on: [Number(independent.id), Number(c.id)],
        }),
      }),
    );
    expect(batchCycle.status).toBe(409);
    expect(db.get_dependencies(Number(a.id))).toEqual([]);
  });

  test("POST /api/tasks strictly validates agent and schedule fields", async () => {
    const invalidCases = [
      [{ prompt: "x", schedule_type: "never" }, "schedule_type"],
      [{ prompt: "x", agent: "other" }, "agent"],
      [{ prompt: "x", schedule_type: "delayed" }, "delay_seconds"],
      [
        { prompt: "x", schedule_type: "delayed", delay_seconds: -1 },
        "delay_seconds",
      ],
      [{ prompt: "x", schedule_type: "scheduled_at" }, "next_run_at"],
      [
        {
          prompt: "x",
          schedule_type: "scheduled_at",
          next_run_at: "not-a-date",
        },
        "next_run_at",
      ],
    ] as const;

    for (const [body, field] of invalidCases) {
      const res = await handleApiRequest(
        ctx,
        new Request("http://127.0.0.1:9712/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as Record<string, any>).field).toBe(field);
    }
    expect(db.get_all_tasks()).toHaveLength(0);
  });

  test("POST /api/dag validates every task before creating the DAG", async () => {
    const missingDir = path.join(tmpDir, "missing-dag-dir");
    const invalidDir = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/dag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: [
            { ref: "first", prompt: "valid", working_dir: "." },
            { ref: "second", prompt: "invalid", working_dir: missingDir },
          ],
        }),
      }),
    );
    expect(invalidDir.status).toBe(400);
    expect(await invalidDir.json()).toMatchObject({
      field: "working_dir",
      index: 1,
    });
    expect(db.get_all_tasks()).toHaveLength(0);

    for (const [task, field] of [
      [{ prompt: "x", agent: "other" }, "agent"],
      [{ prompt: "x", schedule_type: "unknown" }, "schedule_type"],
      [{ prompt: "x", schedule_type: "delayed" }, "delay_seconds"],
      [{ prompt: "x", schedule_type: "scheduled_at" }, "next_run_at"],
      [{ prompt: "x", schedule_type: "cron" }, "cron_expr"],
    ] as const) {
      const res = await handleApiRequest(
        ctx,
        new Request("http://127.0.0.1:9712/api/dag", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tasks: [task] }),
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ field, index: 0 });
    }
    expect(db.get_all_tasks()).toHaveLength(0);
  });

  test("task mutation routes edit, respond, resume, cancel, retry, and remove dependencies", async () => {
    const upstream = await json(
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Up", prompt: "up" }),
      }),
    );
    const task = await json(
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Editable", prompt: "first" }),
      }),
    );
    const upstreamId = Number(upstream.id);
    const taskId = Number(task.id);

    const addDep = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/dependencies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depends_on_task_id: upstreamId }),
      }),
    );
    expect(addDep.status).toBe(200);
    expect(db.get_task(taskId)!["status"]).toBe("blocked");

    const removeDep = await handleApiRequest(
      ctx,
      new Request(
        `http://127.0.0.1:9712/api/tasks/${taskId}/dependencies/${upstreamId}`,
        { method: "DELETE" },
      ),
    );
    expect(removeDep.status).toBe(200);
    expect(db.get_dependencies(taskId)).toEqual([]);

    const edited = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Edited",
          prompt: "second",
          schedule_type: "scheduled_at",
          next_run_at: "2030-01-01T00:00:00",
          prompt_images: JSON.stringify([
            { media_type: "image/png", data: "x" },
          ]),
        }),
      }),
    );
    expect(edited.status).toBe(200);
    const editedPayload = (await edited.json()) as any;
    expect(editedPayload.title).toBe("Edited");
    expect(editedPayload.status).toBe("scheduled");
    expect(editedPayload.prompt_images).toEqual([
      { media_type: "image/png", data: "x" },
    ]);

    const respond = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "answer" }),
      }),
    );
    expect(respond.status).toBe(200);
    expect(db.get_task(taskId)!["answer"]).toBe("answer");

    db.update_task(taskId, { session_id: "sess-1" });
    const resume = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "continue" }),
      }),
    );
    expect(resume.status).toBe(200);
    expect(db.get_task(taskId)!["prompt"]).toBe("continue");

    const cancel = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/cancel`, {
        method: "POST",
      }),
    );
    expect(cancel.status).toBe(200);
    expect(db.get_task(taskId)!["status"]).toBe("cancelled");

    const retry = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/retry`, {
        method: "POST",
      }),
    );
    expect(retry.status).toBe(200);
    expect(db.get_task(taskId)!["status"]).toBe("pending");
  });

  test("heartbeat API covers create, ticks, output, pause, resume, update, and delete", async () => {
    const created = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/heartbeats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Heartbeat",
          check_prompt: "check",
          schedule_type: "interval",
          interval_seconds: 60,
          cooldown_seconds: 5,
        }),
      }),
    );
    expect(created.status).toBe(201);
    const heartbeatId = Number(((await created.json()) as any).id);

    expect(
      await json(new Request("http://127.0.0.1:9712/api/heartbeats")),
    ).toHaveLength(1);
    expect(
      (
        await json(
          new Request(`http://127.0.0.1:9712/api/heartbeats/${heartbeatId}`),
        )
      ).name,
    ).toBe("Heartbeat");

    const tickId = db.add_heartbeat_tick(heartbeatId);
    db.finish_heartbeat_tick(
      tickId,
      "completed",
      "idle",
      { decision: "idle" },
      null,
      "tick raw",
    );
    const ticks = await json(
      new Request(`http://127.0.0.1:9712/api/heartbeats/${heartbeatId}/ticks`),
    );
    expect(ticks.ticks[0].id).toBe(tickId);

    let output = await json(
      new Request(
        `http://127.0.0.1:9712/api/heartbeats/${heartbeatId}/ticks/${tickId}/output`,
      ),
    );
    expect(output).toEqual({ output: "tick raw", is_running: false });

    scheduler._live_heartbeat_output.set(tickId, "live tick");
    output = await json(
      new Request(
        `http://127.0.0.1:9712/api/heartbeats/${heartbeatId}/ticks/${tickId}/output`,
      ),
    );
    expect(output).toEqual({ output: "live tick", is_running: true });

    const pause = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/heartbeats/${heartbeatId}/pause`, {
        method: "POST",
      }),
    );
    expect(pause.status).toBe(200);
    expect(db.get_heartbeat(heartbeatId)!["enabled"]).toBe(false);

    const resume = await handleApiRequest(
      ctx,
      new Request(
        `http://127.0.0.1:9712/api/heartbeats/${heartbeatId}/resume`,
        { method: "POST" },
      ),
    );
    expect(resume.status).toBe(200);
    expect(db.get_heartbeat(heartbeatId)!["enabled"]).toBe(true);

    const updated = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/heartbeats/${heartbeatId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Cron heartbeat",
          check_prompt: "check",
          schedule_type: "cron",
          cron_expr: "0 9 * * *",
          cooldown_seconds: 0,
        }),
      }),
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as any).schedule_type).toBe("cron");

    const deleted = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/heartbeats/${heartbeatId}`, {
        method: "DELETE",
      }),
    );
    expect(deleted.status).toBe(200);
    expect(db.get_heartbeat(heartbeatId)).toBeNull();
  });

  test("heartbeat validation rejects malformed payloads", async () => {
    const empty = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/heartbeats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ check_prompt: "" }),
      }),
    );
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as Record<string, any>).field).toBe(
      "check_prompt",
    );

    const badSchedule = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/heartbeats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          check_prompt: "x",
          schedule_type: "nonsense",
        }),
      }),
    );
    expect(badSchedule.status).toBe(400);
    expect(((await badSchedule.json()) as Record<string, any>).field).toBe(
      "schedule_type",
    );

    const badCron = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/heartbeats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          check_prompt: "x",
          schedule_type: "cron",
          cron_expr: "bad cron",
        }),
      }),
    );
    expect(badCron.status).toBe(400);
    expect(((await badCron.json()) as Record<string, any>).field).toBe(
      "cron_expr",
    );

    const badInterval = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/heartbeats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          check_prompt: "x",
          schedule_type: "interval",
          interval_seconds: 0,
        }),
      }),
    );
    expect(badInterval.status).toBe(400);
    expect(((await badInterval.json()) as Record<string, any>).field).toBe(
      "interval_seconds",
    );

    const badCooldown = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/heartbeats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          check_prompt: "x",
          schedule_type: "interval",
          interval_seconds: 10,
          cooldown_seconds: -1,
        }),
      }),
    );
    expect(badCooldown.status).toBe(400);
    expect(((await badCooldown.json()) as Record<string, any>).field).toBe(
      "cooldown_seconds",
    );
  });

  test("Weixin action API delegates to the running channel", async () => {
    const calls: string[] = [];

    const missing = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/channels/weixin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login" }),
      }),
    );
    expect(missing.status).toBe(400);

    ctx.weixin_channel = {
      request_login: () => calls.push("login"),
      request_logout: () => calls.push("logout"),
    } as any;

    const login = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/channels/weixin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reconnect" }),
      }),
    );
    expect(login.status).toBe(200);

    const logout = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/channels/weixin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      }),
    );
    expect(logout.status).toBe(200);

    const unsupported = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/channels/weixin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dance" }),
      }),
    );
    expect(unsupported.status).toBe(400);
    expect(calls).toEqual(["login", "logout"]);
  });

  test("skill content, toggle, and delete routes use the skill registry", async () => {
    const skillDir = path.join(tmpDir, "skill");
    fs.mkdirSync(skillDir);
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillPath, "# Skill\n", "utf8");
    const skillId = db.add_skill("demo", "desc", skillPath)!;

    const list = await json(new Request("http://127.0.0.1:9712/api/skills"));
    expect(list.skills.map((s: any) => s.id)).toContain(skillId);

    const content = await json(
      new Request(`http://127.0.0.1:9712/api/skills/${skillId}/content`),
    );
    expect(content.content).toBe("# Skill\n");
    expect(content.path).toBe(skillPath);

    const toggled = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/skills/${skillId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(toggled.status).toBe(200);
    expect(db.get_skill(skillId)!["enabled"]).toBe(0);

    const deleted = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/skills/${skillId}`, {
        method: "DELETE",
      }),
    );
    expect(deleted.status).toBe(200);
    expect(db.get_skill(skillId)).toBeNull();
  });

  test("IM skill suggestion API previews sends and gates approval", async () => {
    const patternId = createReadySkillDraft();
    const preview = await json(
      new Request("http://127.0.0.1:9712/api/im-skill-suggestions/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "slack" }),
      }),
    );
    expect(preview.suggestions).toHaveLength(1);
    expect(preview.suggestions[0].pattern_id).toBe(patternId);
    expect(preview.texts[0]).toContain("/draft-skill");

    const reply = mock(
      async (_channel: string, _thread: string | null, _text: string) => {},
    );
    ctx.slack_channel = { _reply: reply } as any;
    const sent = await json(
      new Request("http://127.0.0.1:9712/api/im-skill-suggestions/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipients: [{ channel: "slack", target: "C1" }],
        }),
      }),
    );
    expect(sent.status).toBe("sent");
    expect(sent.sent).toBe(1);
    expect(reply.mock.calls[0]![0]).toBe("C1");
    expect(db.should_send_im_skill_suggestion(patternId, "slack", "C1")).toBe(
      false,
    );

    const blocked = await handleApiRequest(
      ctx,
      new Request(
        `http://127.0.0.1:9712/api/im-skill-suggestions/${patternId}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "approve",
            source_channel: "slack",
            target: "C1",
          }),
        },
      ),
    );
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toEqual({
      error: "draft must be shown before approval",
    });

    const shown = await json(
      new Request(
        `http://127.0.0.1:9712/api/im-skill-suggestions/${patternId}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "show",
            source_channel: "slack",
            target: "C1",
          }),
        },
      ),
    );
    expect(shown.status).toBe("ready");
    expect(shown.text).toContain("# Fix CI");

    (scheduler as any).approve_skill = mock(() => ({ id: 9, name: "ok" }));
    const approved = await json(
      new Request(
        `http://127.0.0.1:9712/api/im-skill-suggestions/${patternId}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "approve",
            source_channel: "slack",
            target: "C1",
          }),
        },
      ),
    );
    expect(approved).toEqual({
      pattern_id: patternId,
      skill: { id: 9, name: "ok" },
      status: "approved",
    });
  });

  test("settings, skill workflow, and delete error routes cover edge cases", async () => {
    const nonObjectSettings = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["ignored"]),
      }),
    );
    expect(nonObjectSettings.status).toBe(200);

    const putSettings = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeout: 90 }),
      }),
    );
    expect(putSettings.status).toBe(200);
    expect(db.get_setting("timeout")).toBe("90");

    db.set_setting("feishu_app_id", "cli_x");
    const feishuSettings = await json(
      new Request("http://127.0.0.1:9712/api/feishu/settings"),
    );
    expect(feishuSettings.feishu_app_id).toBe("cli_x");

    const missingContent = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skills/999/content"),
    );
    expect(missingContent.status).toBe(404);

    const brokenSkillId = db.add_skill(
      "broken",
      "missing file",
      path.join(tmpDir, "missing", "SKILL.md"),
    )!;
    const brokenContent = await json(
      new Request(`http://127.0.0.1:9712/api/skills/${brokenSkillId}/content`),
    );
    expect(brokenContent.content).toContain("无法读取");

    (scheduler as any).trigger_skill_sweep = mock(() => true);
    let res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skills/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "codex", full: false }),
      }),
    );
    expect(res.status).toBe(200);
    expect((scheduler as any).trigger_skill_sweep.mock.calls[0]).toEqual([
      "codex",
      false,
    ]);
    (scheduler as any).trigger_skill_sweep = mock(() => false);
    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skills/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(409);

    (scheduler as any).trigger_skill_draft = mock(() => true);
    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skill-patterns/1/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      }),
    );
    expect(res.status).toBe(200);
    (scheduler as any).trigger_skill_draft = mock(() => false);
    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skill-patterns/bad/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);

    (scheduler as any).approve_skill = mock(() => ({ id: 1, name: "ok" }));
    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skill-patterns/1/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ok", description: "d", body: "# Skill" }),
      }),
    );
    expect(res.status).toBe(200);
    (scheduler as any).approve_skill = mock(() => {
      throw new Error("pattern not found");
    });
    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skill-patterns/1/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);

    (scheduler as any).dismiss_skill_pattern = mock(() => undefined);
    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skill-patterns/1/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skill-patterns/bad/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);

    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skills/bad", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
    (scheduler as any).toggle_skill = mock(() => {
      throw new Error("skill not found");
    });
    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skills/123", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);

    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skills/bad", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(400);
    (scheduler as any).remove_skill = mock(() => {
      throw new Error("skill not found");
    });
    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/skills/123", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(404);
    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/unknown", { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });

  test("heartbeat routes cover validation and scheduler error branches", async () => {
    let res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/heartbeats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          check_prompt: "check",
          working_dir: path.join(tmpDir, "missing"),
          schedule_type: "interval",
          interval_seconds: 60,
        }),
      }),
    );
    expect(res.status).toBe(400);

    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/heartbeats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          check_prompt: "check",
          schedule_type: "cron",
        }),
      }),
    );
    expect(res.status).toBe(400);

    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/heartbeats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          check_prompt: "check",
          schedule_type: "interval",
          interval_seconds: 60,
          cooldown_seconds: "not-int",
          enabled: "false",
        }),
      }),
    );
    expect(res.status).toBe(400);

    const created = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/heartbeats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          check_prompt: "check",
          schedule_type: "interval",
          interval_seconds: 60,
          cooldown_seconds: 0,
          enabled: "false",
        }),
      }),
    );
    const heartbeatId = Number(((await created.json()) as any).id);
    expect(db.get_heartbeat(heartbeatId)!["enabled"]).toBe(false);

    const tickId = db.add_heartbeat_tick(heartbeatId);
    expect(
      (
        await handleApiRequest(
          ctx,
          new Request(
            `http://127.0.0.1:9712/api/heartbeats/bad/ticks/${tickId}/output`,
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleApiRequest(
          ctx,
          new Request(
            `http://127.0.0.1:9712/api/heartbeats/${heartbeatId}/ticks/999/output`,
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleApiRequest(
          ctx,
          new Request("http://127.0.0.1:9712/api/heartbeats/bad/ticks"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleApiRequest(
          ctx,
          new Request("http://127.0.0.1:9712/api/heartbeats/bad"),
        )
      ).status,
    ).toBe(404);

    (scheduler as any).trigger_heartbeat_now = mock(() => undefined);
    res = await handleApiRequest(
      ctx,
      new Request(
        `http://127.0.0.1:9712/api/heartbeats/${heartbeatId}/run-now`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      ),
    );
    expect(res.status).toBe(200);
    (scheduler as any).trigger_heartbeat_now = mock(() => {
      throw new Error("heartbeat already running");
    });
    res = await handleApiRequest(
      ctx,
      new Request(
        `http://127.0.0.1:9712/api/heartbeats/${heartbeatId}/run-now`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      ),
    );
    expect(res.status).toBe(409);
    (scheduler as any).trigger_heartbeat_now = mock(() => {
      throw new Error("heartbeat not found");
    });
    res = await handleApiRequest(
      ctx,
      new Request(
        `http://127.0.0.1:9712/api/heartbeats/${heartbeatId}/run-now`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      ),
    );
    expect(res.status).toBe(404);

    expect(
      (
        await handleApiRequest(
          ctx,
          new Request("http://127.0.0.1:9712/api/heartbeats/bad", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleApiRequest(
          ctx,
          new Request("http://127.0.0.1:9712/api/heartbeats/999", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(404);

    (scheduler as any).pause_heartbeat = mock(() => {
      throw new Error("heartbeat not found");
    });
    expect(
      (
        await handleApiRequest(
          ctx,
          new Request(
            `http://127.0.0.1:9712/api/heartbeats/${heartbeatId}/pause`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            },
          ),
        )
      ).status,
    ).toBe(404);
    (scheduler as any).resume_heartbeat = mock(() => {
      throw new Error("heartbeat not found");
    });
    expect(
      (
        await handleApiRequest(
          ctx,
          new Request(
            `http://127.0.0.1:9712/api/heartbeats/${heartbeatId}/resume`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            },
          ),
        )
      ).status,
    ).toBe(404);
  });

  test("task routes cover live output, message parsing, validation, and DAG errors", async () => {
    const upstream = await json(
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "upstream" }),
      }),
    );
    db.update_task(Number(upstream.id), { status: "completed" });

    const created = await json(
      new Request("http://127.0.0.1:9712/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "downstream",
          schedule_type: "cron",
          cron_expr: "*/5 * * * *",
          depends_on: [Number(upstream.id), { task_id: Number(upstream.id) }],
          inject_result: true,
          prompt_images: JSON.stringify({ not: "a list" }),
          image_paths: ["a.png", 1],
        }),
      }),
    );
    const taskId = Number(created.id);
    expect(db.get_dependencies(taskId)).toHaveLength(1);

    scheduler._live_output.set(taskId, "live output");
    expect(
      await json(
        new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/output`),
      ),
    ).toEqual({ output: "live output", is_running: true });

    const runId = db.add_run(taskId);
    db.finish_run(
      runId,
      "completed",
      "ok",
      null,
      [
        JSON.stringify({
          type: "user",
          message: {
            content: [
              "hello ",
              { type: "text", text: "world" },
              { type: "image", source: "ignored" },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "answer" }, { type: "tool" }],
          },
        }),
        "{bad json",
      ].join("\n"),
    );
    const messages = await json(
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/messages`),
    );
    expect(messages.map((m: any) => m.text)).toEqual(["hello world", "answer"]);

    for (const suffix of [
      "runs",
      "output",
      "events",
      "messages",
      "dependencies",
      "dependents",
    ]) {
      const res = await handleApiRequest(
        ctx,
        new Request(`http://127.0.0.1:9712/api/tasks/bad/${suffix}`),
      );
      expect(res.status).toBe(404);
    }

    let res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks/bad/dependencies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
    res = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/dependencies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depends_on_task_id: 999 }),
      }),
    );
    expect(res.status).toBe(404);

    res = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "   " }),
      }),
    );
    expect(res.status).toBe(400);
    res = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "continue" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(
      (
        await handleApiRequest(
          ctx,
          new Request("http://127.0.0.1:9712/api/tasks/bad/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleApiRequest(
          ctx,
          new Request("http://127.0.0.1:9712/api/tasks/bad/retry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleApiRequest(
          ctx,
          new Request("http://127.0.0.1:9712/api/tasks/999/respond", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(404);

    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/dag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: [] }),
      }),
    );
    expect(res.status).toBe(400);
    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/dag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: [{ ref: "b", prompt: "b", depends_on_refs: ["missing"] }],
        }),
      }),
    );
    expect(res.status).toBe(400);

    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks/bad", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
    res = await handleApiRequest(
      ctx,
      new Request("http://127.0.0.1:9712/api/tasks/999", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);

    db.update_task(taskId, { status: "completed" });
    res = await handleApiRequest(
      ctx,
      new Request(`http://127.0.0.1:9712/api/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "edit" }),
      }),
    );
    expect(res.status).toBe(409);

    db.update_task(taskId, { status: "pending" });
    for (const body of [
      { prompt: "   " },
      { prompt: "ok", working_dir: path.join(tmpDir, "missing") },
      { prompt: "ok", schedule_type: "cron", cron_expr: "" },
      { prompt: "ok", schedule_type: "cron", cron_expr: "bad cron" },
      { prompt: "ok", schedule_type: "scheduled_at", next_run_at: "" },
    ]) {
      res = await handleApiRequest(
        ctx,
        new Request(`http://127.0.0.1:9712/api/tasks/${taskId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(400);
    }

    for (const body of [
      { prompt: "immediate", schedule_type: "immediate" },
      { prompt: "delayed", schedule_type: "delayed", delay_seconds: 30 },
      { prompt: "cron", schedule_type: "cron", cron_expr: "*/10 * * * *" },
      {
        prompt: "blocked",
        depends_on: [{ task_id: Number(upstream.id), inject_result: true }],
        prompt_images: [{ media_type: "image/png", data: "x" }],
        image_paths: ["image.png"],
      },
    ]) {
      res = await handleApiRequest(
        ctx,
        new Request(`http://127.0.0.1:9712/api/tasks/${taskId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(200);
    }

    const explodingDb = {
      ...ctx,
      db: {
        ...db,
        get_all_tasks: () => {
          throw new Error("db down");
        },
      },
    } as any;
    const failure = await handleApiRequest(
      explodingDb,
      new Request("http://127.0.0.1:9712/api/health"),
    );
    expect(failure.status).toBe(500);
  });
});
