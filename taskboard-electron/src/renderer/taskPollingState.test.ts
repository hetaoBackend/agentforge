import { describe, expect, test } from "bun:test";
import {
  DetailRequestCoordinator,
  loadLatestTaskDetail,
  mergeTaskSummaryIntoDetail,
} from "./taskPollingState.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("task polling detail state", () => {
  test("summary refresh preserves full dependency metadata and detail-only fields", () => {
    const dependencies = [
      {
        id: 17,
        task_id: 2,
        depends_on_task_id: 1,
        inject_result: 1,
        depends_on_title: "Compile assets",
        depends_on_status: "completed",
      },
    ];
    const detail = {
      id: 2,
      title: "Ship",
      status: "blocked",
      prompt: "Full prompt",
      result: "Full result",
      dependencies,
      dependents: [3, 4],
    };
    const summary = {
      id: 2,
      title: "Ship",
      status: "running",
      run_count: 1,
      dependencies: [{ depends_on_task_id: 1 }],
      dependents: [99],
    };

    const merged = mergeTaskSummaryIntoDetail(detail, summary)!;

    expect(merged.status).toBe("running");
    expect(merged.run_count).toBe(1);
    expect(merged.prompt).toBe("Full prompt");
    expect(merged.result).toBe("Full result");
    expect(merged.dependencies).toEqual(dependencies);
    expect(merged.dependencies[0]).toEqual({
      id: 17,
      task_id: 2,
      depends_on_task_id: 1,
      inject_result: 1,
      depends_on_title: "Compile assets",
      depends_on_status: "completed",
    });
    expect(merged.dependents).toEqual([3, 4]);
  });

  test("rapid A to B selection ignores A when it resolves last", async () => {
    const coordinator = new DetailRequestCoordinator();
    const requests = new Map<number, ReturnType<typeof deferred<Record<string, any>>>>();
    const signals = new Map<number, AbortSignal>();
    const loaded: number[] = [];
    const errors: unknown[] = [];
    const fetchTask = (taskId: number, signal: AbortSignal) => {
      signals.set(taskId, signal);
      const request = deferred<Record<string, any>>();
      requests.set(taskId, request);
      return request.promise;
    };

    const loadA = loadLatestTaskDetail(
      1,
      coordinator,
      fetchTask,
      (task) => loaded.push(task.id),
      (error) => errors.push(error),
    );
    const loadB = loadLatestTaskDetail(
      2,
      coordinator,
      fetchTask,
      (task) => loaded.push(task.id),
      (error) => errors.push(error),
    );

    expect(signals.get(1)?.aborted).toBe(true);
    requests.get(2)!.resolve({ id: 2 });
    await loadB;
    requests.get(1)!.resolve({ id: 1 });
    await loadA;

    expect(loaded).toEqual([2]);
    expect(errors).toEqual([]);
  });

  test("an error from a superseded request does not replace current UI state", async () => {
    const coordinator = new DetailRequestCoordinator();
    const requestA = deferred<Record<string, any>>();
    const requestB = deferred<Record<string, any>>();
    const loaded: number[] = [];
    const errors: unknown[] = [];
    const fetchTask = (taskId: number) => (taskId === 1 ? requestA.promise : requestB.promise);

    const loadA = loadLatestTaskDetail(
      1,
      coordinator,
      fetchTask,
      (task) => loaded.push(task.id),
      (error) => errors.push(error),
    );
    const loadB = loadLatestTaskDetail(
      2,
      coordinator,
      fetchTask,
      (task) => loaded.push(task.id),
      (error) => errors.push(error),
    );

    requestB.resolve({ id: 2 });
    await loadB;
    requestA.reject(new Error("stale A failure"));
    await loadA;

    expect(loaded).toEqual([2]);
    expect(errors).toEqual([]);
  });

  test("invalidation prevents a pending request from updating state", async () => {
    const coordinator = new DetailRequestCoordinator();
    const request = deferred<Record<string, any>>();
    const loaded: number[] = [];
    const errors: unknown[] = [];
    const load = loadLatestTaskDetail(
      1,
      coordinator,
      async () => request.promise,
      (task) => loaded.push(task.id),
      (error) => errors.push(error),
    );

    coordinator.invalidate();
    request.resolve({ id: 1 });
    await load;

    expect(loaded).toEqual([]);
    expect(errors).toEqual([]);
  });
});
