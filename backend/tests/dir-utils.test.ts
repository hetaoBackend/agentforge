import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  extract_working_dir_with_claude,
  handle_dir_command,
  parse_dir_command,
  resolve_working_dir,
} from "../src/channels/dir_utils.ts";

class SettingsStub {
  values: Record<string, string> = {};

  get_setting(key: string, fallback: string | null = null): string | null {
    return this.values[key] ?? fallback;
  }

  set_setting(key: string, value: string): void {
    this.values[key] = value;
  }
}

const originalApiKey = process.env.ANTHROPIC_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
  globalThis.fetch = originalFetch;
});

describe("dir utils", () => {
  test("explicit dir commands parse and persist", () => {
    const db = new SettingsStub();

    expect(parse_dir_command("/dir ~/app")).toBe("~/app");
    expect(parse_dir_command("/cd /tmp/app")).toBe("/tmp/app");
    expect(parse_dir_command("cd ./app")).toBe("./app");
    expect(parse_dir_command("hello")).toBeNull();
    expect(handle_dir_command("/dir /work", "telegram", db)).toContain("/work");
    expect(db.values["telegram_default_working_dir"]).toBe("/work");
    expect(handle_dir_command("not a dir command", "telegram", db)).toBeNull();
  });

  test("Claude extraction covers success, empty, non-200, and error paths", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await extract_working_dir_with_claude("in ~/app")).toBeNull();

    process.env.ANTHROPIC_API_KEY = "test-key";
    globalThis.fetch = mock(async () => ({
      status: 200,
      json: async () => ({
        content: [{ text: JSON.stringify({ path: " ~/project " }) }],
      }),
    })) as any;
    expect(await extract_working_dir_with_claude("in ~/project")).toBe(
      "~/project",
    );

    globalThis.fetch = mock(async () => ({
      status: 200,
      json: async () => ({
        content: [{ text: JSON.stringify({ path: null }) }],
      }),
    })) as any;
    expect(await extract_working_dir_with_claude("no path")).toBeNull();

    globalThis.fetch = mock(async () => ({ status: 429 })) as any;
    expect(await extract_working_dir_with_claude("rate limited")).toBeNull();

    globalThis.fetch = mock(async () => ({
      status: 200,
      json: async () => ({ content: [{ text: "{bad json" }] }),
    })) as any;
    expect(await extract_working_dir_with_claude("bad json")).toBeNull();

    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as any;
    expect(await extract_working_dir_with_claude("network down")).toBeNull();
  });

  test("resolve_working_dir prefers extracted path then settings then home", async () => {
    const db = new SettingsStub();
    db.values["slack_default_working_dir"] = "/configured";

    process.env.ANTHROPIC_API_KEY = "test-key";
    globalThis.fetch = mock(async () => ({
      status: 200,
      json: async () => ({
        content: [{ text: JSON.stringify({ path: "/extracted" }) }],
      }),
    })) as any;
    expect(await resolve_working_dir("use /extracted", "slack", db)).toBe(
      "/extracted",
    );

    delete process.env.ANTHROPIC_API_KEY;
    expect(await resolve_working_dir("no extraction", "slack", db)).toBe(
      "/configured",
    );
    expect(await resolve_working_dir("no setting", "telegram", db)).toBe("~");
  });
});
