import { expect, test } from "bun:test";

import {
  attemptTargetedTaskRefresh,
  getTaskResponseUiState,
  markTaskResponseSubmitted,
  mergeTargetedTaskDetail,
  prepareTaskResponse,
  reconcileTasksWithSubmittedAnswers,
  selectTickAfterRefresh,
  startHeartbeatTickPolling,
  taskNeedsResponse,
} from "./operatorUi.ts";

test("taskNeedsResponse requires a non-empty question without an answer", () => {
  expect(taskNeedsResponse("Which branch?", null)).toBe(true);
  expect(taskNeedsResponse("  Which branch?  ", "")).toBe(true);
  expect(taskNeedsResponse("Which branch?", "main")).toBe(false);
  expect(taskNeedsResponse("   ", null)).toBe(false);
});

test("prepareTaskResponse trims answers and rejects blank input", () => {
  expect(prepareTaskResponse("  Use main.  ")).toEqual({
    answer: "Use main.",
    error: null,
  });
  expect(prepareTaskResponse(" \n ")).toEqual({
    answer: null,
    error: "Please enter an answer before submitting.",
  });
});

test("task response UI treats submit success separately from refresh failure", () => {
  expect(getTaskResponseUiState("Proceed?", null, null)).toBe("form");
  expect(getTaskResponseUiState("Proceed?", null, { refreshed: true })).toBe("submitted");
  expect(getTaskResponseUiState("Proceed?", null, { refreshed: false })).toBe("submitted-stale");
});

test("task response UI hides once the refreshed task is answered", () => {
  expect(getTaskResponseUiState("Proceed?", "Yes", { refreshed: true })).toBe("hidden");
  expect(getTaskResponseUiState(null, null, { refreshed: false })).toBe("hidden");
});

test("successful submit remains answered after refresh failure and panel reopen", async () => {
  const original = { id: 7, question: "Proceed?", answer: null };
  const submitted = markTaskResponseSubmitted(original, 7, "Yes");
  const appState = { connected: true, warning: "" };

  const refreshed = await attemptTargetedTaskRefresh({
    load: async () => {
      throw new Error("offline");
    },
    onTask: () => {},
    onError: () => {
      appState.warning = "Answer submitted, but task details have not refreshed yet.";
    },
  });

  expect(refreshed).toBe(false);
  expect(appState.warning).toContain("Answer submitted");
  expect(appState.connected).toBe(true);
  expect(getTaskResponseUiState(submitted.question, submitted.answer, null)).toBe("hidden");
});

test("global task reconciliation cannot restore a submitted response form", () => {
  const staleTasks = [{ id: 7, question: "Proceed?", answer: null }];
  const reconciled = reconcileTasksWithSubmittedAnswers(staleTasks, { "7": "Yes" });

  expect(reconciled.tasks[0]).toEqual({ id: 7, question: null, answer: "Yes" });
  expect(reconciled.pendingSubmissionIds).toEqual(["7"]);
});

test("stale targeted refresh cannot overwrite a different open detail", () => {
  const openDetail = { id: 8, question: "Other question", answer: null };
  const staleResponse = { id: 7, question: null, answer: "Yes" };
  const updatedResponse = { ...staleResponse, answer: "Updated" };

  expect(mergeTargetedTaskDetail(openDetail, 7, staleResponse)).toBe(openDetail);
  expect(mergeTargetedTaskDetail(staleResponse, 7, updatedResponse)).toBe(updatedResponse);
});

test("selectTickAfterRefresh preserves a selected tick still in the refreshed list", () => {
  const ticks = [{ id: 12 }, { id: 11 }, { id: 10 }];

  expect(selectTickAfterRefresh(11, ticks)).toBe(11);
  expect(selectTickAfterRefresh(9, ticks)).toBe(12);
  expect(selectTickAfterRefresh(null, ticks)).toBe(12);
});

test("selectTickAfterRefresh resets selection for a different heartbeat or empty list", () => {
  expect(selectTickAfterRefresh(11, [{ id: 21 }, { id: 11 }], true)).toBe(21);
  expect(selectTickAfterRefresh(11, [])).toBeNull();
});

test("heartbeat tick polling schedules only after the active request settles", async () => {
  let resolveLoad: (ticks: number[]) => void = () => {};
  const loaded = new Promise<number[]>((resolve) => {
    resolveLoad = resolve;
  });
  const applied: number[][] = [];
  let confirmApplied: () => void = () => {};
  const application = new Promise<void>((resolve) => {
    confirmApplied = resolve;
  });
  const scheduled: Array<() => void> = [];
  const cancelled: unknown[] = [];

  const stop = startHeartbeatTickPolling({
    heartbeatId: 4,
    load: () => loaded,
    onTicks: (ticks) => {
      applied.push(ticks);
      confirmApplied();
    },
    onError: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return "tick-timer";
    },
    cancelScheduled: (timer) => cancelled.push(timer),
  });

  expect(scheduled).toHaveLength(0);
  resolveLoad([8, 7]);
  await application;
  await Promise.resolve();
  expect(applied).toEqual([[8, 7]]);
  expect(scheduled).toHaveLength(1);

  stop();
  expect(cancelled).toEqual(["tick-timer"]);
});

test("stopping heartbeat tick polling ignores an in-flight stale response", async () => {
  let resolveLoad: (ticks: number[]) => void = () => {};
  const loaded = new Promise<number[]>((resolve) => {
    resolveLoad = resolve;
  });
  const applied: number[][] = [];
  let scheduleCount = 0;

  const stop = startHeartbeatTickPolling({
    heartbeatId: 4,
    load: () => loaded,
    onTicks: (ticks) => applied.push(ticks),
    onError: () => {},
    schedule: () => {
      scheduleCount += 1;
      return scheduleCount;
    },
  });

  stop();
  resolveLoad([9]);
  await Promise.resolve();
  await Promise.resolve();

  expect(applied).toEqual([]);
  expect(scheduleCount).toBe(0);
});
