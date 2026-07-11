import { expect, test } from "bun:test";

import {
  getTaskResponseUiState,
  prepareTaskResponse,
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
