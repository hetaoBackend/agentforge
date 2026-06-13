import { test, expect } from "bun:test";

import { buildExecutionSteps } from "./traceSteps.ts";

test("buildExecutionSteps sorts events oldest first and merges adjacent thinking chunks", () => {
  const steps = buildExecutionSteps([
    {
      id: 3,
      event_type: "tool_call",
      content: JSON.stringify({ name: "Bash", input: { command: "pytest -q" } }),
      timestamp: "2026-05-26 10:00:03",
    },
    {
      id: 2,
      event_type: "assistant",
      content: "[thinking]  context",
      timestamp: "2026-05-26 10:00:02",
    },
    {
      id: 1,
      event_type: "assistant",
      content: "[thinking] Reading",
      timestamp: "2026-05-26 10:00:01",
    },
  ]);

  expect(steps.length).toBe(2);
  expect(steps[0].type).toBe("thinking");
  expect(steps[0].title).toBe("Reading context");
  expect(steps[0].detail).toBe("Reading context");
  expect(steps[1].type).toBe("tool_call");
  expect(steps[1].title).toBe("Call tool: Bash");
});

test("buildExecutionSteps formats command execution details", () => {
  const steps = buildExecutionSteps([
    {
      id: 1,
      event_type: "command_execution",
      content: JSON.stringify({
        command: "npm test",
        output: "12 passed",
        exit_code: 0,
        status: "completed",
      }),
      timestamp: "2026-05-26 10:00:01",
    },
  ]);

  expect(steps.length).toBe(1);
  expect(steps[0].title).toBe("Run command: npm test");
  expect(steps[0].rows.map((row) => [row.label, row.value])).toEqual([
    ["Command", "npm test"],
    ["Output", "12 passed"],
    ["Exit", "0"],
    ["Status", "completed"],
  ]);
});

test("buildExecutionSteps keeps tool result errors readable", () => {
  const steps = buildExecutionSteps([
    {
      id: 1,
      event_type: "tool_result",
      content: JSON.stringify({
        tool_use_id: "toolu_1",
        content: "permission denied",
        is_error: true,
      }),
      timestamp: "2026-05-26 10:00:01",
    },
  ]);

  expect(steps.length).toBe(1);
  expect(steps[0].type).toBe("tool_result");
  expect(steps[0].title).toBe("Tool error: toolu_1");
  expect(steps[0].rows[0].label).toBe("Tool Error");
  expect(steps[0].rows[1].value).toBe("permission denied");
});

test("buildExecutionSteps summarizes generated image events", () => {
  const steps = buildExecutionSteps([
    {
      id: 1,
      event_type: "generated_image",
      content: JSON.stringify({
        path: "/Users/example/.codex/generated_images/thread/result.png",
        media_type: "image/png",
      }),
      timestamp: "2026-05-26 10:00:01",
    },
  ]);

  expect(steps.length).toBe(1);
  expect(steps[0].type).toBe("generated_image");
  expect(steps[0].title).toBe("Generated image: result.png");
  expect(steps[0].rows.map((row) => [row.label, row.value])).toEqual([
    ["Path", "/Users/example/.codex/generated_images/thread/result.png"],
    ["Media", "image/png"],
  ]);
});

test("buildExecutionSteps preserves renderable image_content previews", () => {
  const steps = buildExecutionSteps([
    {
      id: 1,
      event_type: "image_content",
      content: JSON.stringify({
        media_type: "image/png",
        data: "aW1hZ2U=",
      }),
      timestamp: "2026-05-26 10:00:01",
    },
  ]);

  expect(steps.length).toBe(1);
  expect(steps[0].type).toBe("image_content");
  expect(steps[0].title).toBe("Image output");
  expect(steps[0].imageSrc).toBe("data:image/png;base64,aW1hZ2U=");
  expect(steps[0].rows.map((row) => [row.label, row.value])).toEqual([["Media", "image/png"]]);
});
