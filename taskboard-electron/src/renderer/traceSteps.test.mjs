import test from "node:test";
import assert from "node:assert/strict";

import { buildExecutionSteps } from "./traceSteps.mjs";

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

  assert.equal(steps.length, 2);
  assert.equal(steps[0].type, "thinking");
  assert.equal(steps[0].title, "Reading context");
  assert.equal(steps[0].detail, "Reading context");
  assert.equal(steps[1].type, "tool_call");
  assert.equal(steps[1].title, "Call tool: Bash");
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

  assert.equal(steps.length, 1);
  assert.equal(steps[0].title, "Run command: npm test");
  assert.deepEqual(
    steps[0].rows.map(row => [row.label, row.value]),
    [
      ["Command", "npm test"],
      ["Output", "12 passed"],
      ["Exit", "0"],
      ["Status", "completed"],
    ],
  );
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

  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, "tool_result");
  assert.equal(steps[0].title, "Tool error: toolu_1");
  assert.equal(steps[0].rows[0].label, "Tool Error");
  assert.equal(steps[0].rows[1].value, "permission denied");
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

  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, "generated_image");
  assert.equal(steps[0].title, "Generated image: result.png");
  assert.deepEqual(
    steps[0].rows.map(row => [row.label, row.value]),
    [
      ["Path", "/Users/example/.codex/generated_images/thread/result.png"],
      ["Media", "image/png"],
    ],
  );
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

  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, "image_content");
  assert.equal(steps[0].title, "Image output");
  assert.equal(steps[0].imageSrc, "data:image/png;base64,aW1hZ2U=");
  assert.deepEqual(
    steps[0].rows.map(row => [row.label, row.value]),
    [["Media", "image/png"]],
  );
});
