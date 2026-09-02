import { describe, expect, test } from "bun:test";

import { formatDuration } from "../src/util.ts";

describe("formatDuration", () => {
  test("keeps sub-second values in milliseconds", () => {
    expect(formatDuration(820)).toBe("820ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  test("switches to seconds with one decimal", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(3420)).toBe("3.4s");
  });

  test("switches to minutes with zero-padded seconds", () => {
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  test("switches to hours with zero-padded minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h 00m");
    expect(formatDuration(4_020_000)).toBe("1h 07m");
  });

  test("clamps non-positive and non-finite input", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(-5)).toBe("0ms");
    expect(formatDuration(Number.NaN)).toBe("0ms");
  });
});
