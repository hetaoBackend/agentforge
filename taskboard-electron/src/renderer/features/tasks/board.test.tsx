import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Column, TaskCard } from "./board.tsx";
import { COLUMNS } from "../../constants.ts";
import type { Task } from "../../types.ts";

afterEach(cleanup);

function makeTask(partial: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Ship the thing",
    prompt: "Do the work",
    working_dir: ".",
    status: "pending",
    schedule_type: "immediate",
    cron_expr: null,
    delay_seconds: null,
    next_run_at: null,
    last_run_at: null,
    result: null,
    error: null,
    run_count: 0,
    max_runs: null,
    created_at: "2026-08-31T09:00:00",
    updated_at: "2026-08-31T09:00:00",
    tags: "",
    agent: "codex",
    question: null,
    answer: null,
    ...partial,
  };
}

/** Titles of the action buttons currently rendered on the card. */
function actionTitles(): string[] {
  return screen
    .getAllByRole("button")
    .map((b) => b.getAttribute("title") ?? "")
    .filter(Boolean);
}

function renderCard(task: Task, handlers: Partial<Parameters<typeof TaskCard>[0]> = {}) {
  const onAction = handlers.onAction ?? (() => {});
  const onViewDetail = handlers.onViewDetail ?? (() => {});
  return render(<TaskCard task={task} onAction={onAction} onViewDetail={onViewDetail} />);
}

describe("TaskCard", () => {
  test("shows the id, title, prompt and status", () => {
    renderCard(makeTask({ id: 42, title: "Rebuild index", prompt: "Reindex everything" }));

    expect(screen.getByText("#42")).toBeDefined();
    expect(screen.getByText("Rebuild index")).toBeDefined();
    expect(screen.getByText("Reindex everything")).toBeDefined();
  });

  test("falls back to placeholder copy for an empty title and prompt", () => {
    renderCard(makeTask({ title: "", prompt: "" }));

    expect(screen.getByText("Untitled task")).toBeDefined();
    expect(screen.getByText("No prompt saved for this task.")).toBeDefined();
  });

  // Delete is unconditional; the rest are gated on status. These are the
  // buckets the board actually branches on.
  const actionCases: Array<[Task["status"], string[]]> = [
    ["pending", ["Edit", "Cancel", "Delete"]],
    ["scheduled", ["Edit", "Cancel", "Delete"]],
    ["blocked", ["Edit", "Delete"]],
    ["running", ["Cancel", "Delete"]],
    ["completed", ["Fork", "Delete"]],
    ["cancelled", ["Fork", "Delete"]],
    ["failed", ["Fork", "Retry", "Delete"]],
  ];

  test.each(actionCases)("offers the right actions for a %s task", (status, expected) => {
    renderCard(makeTask({ status }));

    expect(actionTitles().sort()).toEqual([...expected].sort());
  });

  test("clicking the card opens the detail view", () => {
    const seen: Task[] = [];
    const task = makeTask({ id: 7 });
    renderCard(task, { onViewDetail: (t) => seen.push(t) });

    fireEvent.click(screen.getByText("Ship the thing"));

    expect(seen).toEqual([task]);
  });

  test("an action button fires onAction without also opening the detail view", () => {
    // The action row stops propagation; without that, every action click
    // would also open the panel behind it.
    const actions: Array<[string, number]> = [];
    let detailOpened = 0;
    renderCard(makeTask({ id: 9, status: "failed" }), {
      onAction: (action, id) => actions.push([action, id]),
      onViewDetail: () => {
        detailOpened += 1;
      },
    });

    fireEvent.click(screen.getByTitle("Retry"));

    expect(actions).toEqual([["retry", 9]]);
    expect(detailOpened).toBe(0);
  });

  test("tags the schedule for delayed, cron and repeat-limited tasks", () => {
    const { unmount } = renderCard(makeTask({ schedule_type: "delayed", delay_seconds: 30 }));
    expect(screen.getByText("delay 30s")).toBeDefined();
    unmount();

    renderCard(
      makeTask({ schedule_type: "cron", cron_expr: "*/5 * * * *", run_count: 3, max_runs: 10 }),
    );
    expect(screen.getByText("cron */5 * * * *")).toBeDefined();
    expect(screen.getByText(/runs\s*3\s*\/10/)).toBeDefined();
  });

  test("splits the comma-separated tag string and caps it at four", () => {
    renderCard(makeTask({ tags: "alpha, beta,gamma,delta,epsilon" }));

    for (const tag of ["alpha", "beta", "gamma", "delta"]) {
      expect(screen.getByText(tag)).toBeDefined();
    }
    expect(screen.queryByText("epsilon")).toBeNull();
  });

  test("lists upstream blockers only while blocked", () => {
    const dependencies = [
      { task_id: 5, depends_on_task_id: 2 },
      { task_id: 5, depends_on_task_id: 3 },
    ];
    const { unmount } = renderCard(makeTask({ id: 5, status: "blocked", dependencies }));
    expect(screen.getByText(/waiting for\s+#2, #3/)).toBeDefined();
    unmount();

    renderCard(makeTask({ id: 5, status: "running", dependencies }));
    expect(screen.queryByText(/waiting for/)).toBeNull();
  });

  test("lists unlocked dependents only once completed", () => {
    const { unmount } = renderCard(makeTask({ status: "completed", dependents: [9, 11] }));
    expect(screen.getByText(/unlocks\s+#9, #11/)).toBeDefined();
    unmount();

    renderCard(makeTask({ status: "running", dependents: [9, 11] }));
    expect(screen.queryByText(/unlocks/)).toBeNull();
  });

  test("shows the dag label only when the task belongs to one", () => {
    const { unmount } = renderCard(makeTask({ dag_id: "nightly-etl" }));
    expect(screen.getByText("dag nightly-etl")).toBeDefined();
    unmount();

    renderCard(makeTask({ dag_id: null }));
    expect(screen.queryByText(/^dag /)).toBeNull();
  });
});

describe("Column", () => {
  const queued = COLUMNS[0]!;

  test("renders the heading, hint and task count", () => {
    render(
      <Column
        col={queued}
        tasks={[makeTask({ id: 1 }), makeTask({ id: 2 })]}
        onAction={() => {}}
        onViewDetail={() => {}}
      />,
    );

    expect(screen.getByText(queued.label)).toBeDefined();
    expect(screen.getByText(queued.hint)).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText("#1")).toBeDefined();
    expect(screen.getByText("#2")).toBeDefined();
  });

  test("shows the empty state instead of cards when it has no tasks", () => {
    render(<Column col={queued} tasks={[]} onAction={() => {}} onViewDetail={() => {}} />);

    expect(screen.getByText("Clear")).toBeDefined();
    expect(screen.getByText("0")).toBeDefined();
    expect(screen.queryByText(/^#\d+$/)).toBeNull();
  });
});
