import { describe, expect, test } from "bun:test";

import {
  default_popen,
  default_subprocess_run,
  FileNotFoundError,
  TimeoutExpired,
} from "../src/executor.ts";
import { getEnv } from "../src/util.ts";

async function collect(iterable: Iterable<string> | AsyncIterable<string>) {
  const lines: string[] = [];
  for await (const line of iterable) {
    lines.push(line);
  }
  return lines;
}

describe("executor subprocess wrappers", () => {
  test("default_subprocess_run captures stdout, stderr, and return code", () => {
    const result = default_subprocess_run(
      [
        process.execPath,
        "-e",
        "console.log('out'); console.error('err'); process.exit(7)",
      ],
      { cwd: ".", timeout: 5, env: getEnv() },
    );

    expect(result.returncode).toBe(7);
    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
  });

  test("default_subprocess_run maps missing binaries and timeouts", () => {
    expect(() =>
      default_subprocess_run(["agentforge-definitely-missing"], {
        cwd: ".",
        timeout: 5,
        env: getEnv(),
      }),
    ).toThrow(FileNotFoundError);

    expect(() =>
      default_subprocess_run(
        [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
        { cwd: ".", timeout: 0.01, env: getEnv() },
      ),
    ).toThrow(TimeoutExpired);
  });

  test("default_popen exposes line iterables and waits for exit", async () => {
    const proc = await default_popen(
      [
        process.execPath,
        "-e",
        "console.log('line1'); console.log('line2'); console.error('errline')",
      ],
      { cwd: ".", env: getEnv() },
    );

    const [stdout, stderr, code] = await Promise.all([
      collect(proc.stdout),
      collect(proc.stderr),
      proc.wait(),
    ]);

    expect(code).toBe(0);
    expect(stdout).toEqual(["line1\n", "line2\n"]);
    expect(stderr).toEqual(["errline\n"]);
    expect(proc.returncode).toBe(0);
  });

  test("default_popen maps spawn errors and wait timeouts", async () => {
    await expect(
      default_popen(["agentforge-definitely-missing"], {
        cwd: ".",
        env: getEnv(),
      }),
    ).rejects.toBeInstanceOf(FileNotFoundError);

    const proc = await default_popen(
      [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
      { cwd: ".", env: getEnv() },
    );
    try {
      await expect(proc.wait(0.01)).rejects.toBeInstanceOf(TimeoutExpired);
    } finally {
      proc.kill();
      await Promise.resolve(proc.wait()).catch(() => null);
    }
  });
});
