import { describe, expect, test } from "bun:test";

import { truncateMiddle } from "../src/util.ts";

describe("truncateMiddle", () => {
  test("returns short input unchanged", () => {
    expect(truncateMiddle("hello", 10)).toBe("hello");
    expect(truncateMiddle("hello", 5)).toBe("hello");
  });

  test("elides the middle and keeps both ends", () => {
    const out = truncateMiddle(
      "/Users/minimax/workspace/agentforge/backend/src/util.ts",
      20,
    );
    expect(out.length).toBe(20);
    expect(out.startsWith("/Users/min")).toBe(true);
    expect(out.endsWith("util.ts")).toBe(true);
    expect(out).toContain("…");
  });

  test("honours a custom ellipsis", () => {
    expect(truncateMiddle("abcdefghij", 7, "...")).toBe("ab...ij");
  });

  test("degrades to a head slice when the limit is tiny", () => {
    expect(truncateMiddle("abcdef", 1)).toBe("a");
    expect(truncateMiddle("abcdef", 0)).toBe("");
  });

  test("treats empty input as empty", () => {
    expect(truncateMiddle("", 5)).toBe("");
  });
});
