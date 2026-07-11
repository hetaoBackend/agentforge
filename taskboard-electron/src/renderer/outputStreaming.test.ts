import { expect, test } from "bun:test";

import {
  applyIncrementalOutput,
  createIncrementalOutputState,
} from "./outputStreaming.ts";

test("createIncrementalOutputState clears output and offset on task switch", () => {
  expect(createIncrementalOutputState()).toEqual({ output: "", nextOffset: 0 });
});

test("applyIncrementalOutput appends chunks without losing order", () => {
  let state = applyIncrementalOutput("", 0, {
    output: "first",
    next_offset: 5,
    reset: false,
  });
  state = applyIncrementalOutput(state.output, state.nextOffset, {
    output: " second",
    next_offset: 12,
    reset: false,
  });

  expect(state).toEqual({ output: "first second", nextOffset: 12 });
});

test("applyIncrementalOutput replaces output after a backend buffer reset", () => {
  expect(
    applyIncrementalOutput("old task output", 15, {
      output: "new",
      next_offset: 3,
      reset: true,
    }),
  ).toEqual({ output: "new", nextOffset: 3 });
});

test("applyIncrementalOutput treats a backwards offset as an implicit reset", () => {
  expect(
    applyIncrementalOutput("stale", 5, {
      output: "x",
      next_offset: 1,
      reset: false,
    }),
  ).toEqual({ output: "x", nextOffset: 1 });
});
