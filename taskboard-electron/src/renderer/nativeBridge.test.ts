import { describe, expect, test } from "bun:test";

import {
  installDirectoryBridge,
  normalizeDirectorySelection,
  type NativeDirectoryBridgeTarget,
} from "./nativeBridge.ts";

describe("nativeBridge", () => {
  test("normalizeDirectorySelection returns the first selected directory", () => {
    expect(normalizeDirectorySelection(["/tmp/project"])).toBe("/tmp/project");
    expect(normalizeDirectorySelection(["", "/tmp/project"])).toBe("/tmp/project");
  });

  test("normalizeDirectorySelection returns null for cancelled or empty selections", () => {
    expect(normalizeDirectorySelection([])).toBeNull();
    expect(normalizeDirectorySelection([""])).toBeNull();
    expect(normalizeDirectorySelection(null)).toBeNull();
    expect(normalizeDirectorySelection(undefined)).toBeNull();
  });

  test("installDirectoryBridge exposes selectDirectory without dropping existing fields", async () => {
    const target: NativeDirectoryBridgeTarget & {
      electronAPI?: { existing?: () => string; selectDirectory?: () => Promise<string | null> };
    } = {
      electronAPI: {
        existing: () => "kept",
      },
    };

    installDirectoryBridge(target, async () => "/Users/example/project");

    expect(target.electronAPI?.existing?.()).toBe("kept");
    expect(await target.electronAPI?.selectDirectory?.()).toBe("/Users/example/project");
  });
});
