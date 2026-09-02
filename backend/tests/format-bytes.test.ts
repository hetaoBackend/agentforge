import { describe, expect, test } from "bun:test";

import { formatBytes } from "../src/util.ts";

describe("formatBytes", () => {
  test("keeps small values in whole bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  test("switches to kilobytes with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1434)).toBe("1.4 KB");
  });

  test("steps up through larger binary units", () => {
    expect(formatBytes(24_117_248)).toBe("23.0 MB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3.0 TB");
  });

  test("stays in terabytes beyond the largest unit", () => {
    expect(formatBytes(2048 * 1024 ** 4)).toBe("2048.0 TB");
  });

  test("clamps non-positive and non-finite input", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});
