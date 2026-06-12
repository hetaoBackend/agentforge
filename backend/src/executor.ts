// AgentExecutor + subprocess seams, ported from taskboard.py (class
// AgentExecutor, lines 1597-1656).
//
// Python runs agent CLIs through the `subprocess` module and the pytest
// suites monkeypatch `taskboard.subprocess.run` / `taskboard.subprocess.Popen`
// (plus `taskboard.os.getpgid` / `taskboard.os.killpg`). The TS port keeps
// the same seams injectable so the ported tests can swap in fakes:
//
//   - `AgentExecutor.subprocess_run` (≙ subprocess.run)   — swappable static
//   - `TaskScheduler._popen`         (≙ subprocess.Popen) — swappable property
//   - `TaskScheduler._os`            (≙ os.getpgid/killpg/kill)
//
// This module also defines the exception types (FileNotFoundError /
// TimeoutExpired / OSError / ProcessLookupError) and the PIPE sentinel that
// Python code references through the subprocess/os builtins.

import { spawn, spawnSync } from "node:child_process";
import type { Readable } from "node:stream";
import { CLAUDE_STREAM_JSON_ARGS, DEFAULT_TIMEOUT_SECONDS } from "./types.ts";
import { getEnv } from "./util.ts";
import { expanduser } from "./skills.ts";

// ── exception types (≙ Python builtins / subprocess) ────────────────────────

/** ≙ builtins.OSError */
export class OSError extends Error {}

/** ≙ builtins.FileNotFoundError (subclass of OSError, like Python) */
export class FileNotFoundError extends OSError {}

/** ≙ builtins.ProcessLookupError (subclass of OSError, like Python) */
export class ProcessLookupError extends OSError {}

/** ≙ subprocess.TimeoutExpired */
export class TimeoutExpired extends Error {
  cmd: unknown;
  timeout: number | null;

  constructor(cmd: unknown = null, timeout: number | null = null) {
    super(`Command timed out after ${timeout} seconds`);
    this.cmd = cmd;
    this.timeout = timeout;
  }
}

/** ≙ subprocess.PIPE sentinel (tests assert `captured.stdin === PIPE`). */
export const PIPE: unique symbol = Symbol.for("subprocess.PIPE");

// ── subprocess.run seam (used by AgentExecutor.run) ─────────────────────────

export interface SubprocessRunResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

export interface SubprocessRunOptions {
  cwd: string;
  timeout: number; // seconds (≙ subprocess.run(timeout=...))
  env: Record<string, string>;
}

export type SubprocessRunFn = (cmd: string[], opts: SubprocessRunOptions) => SubprocessRunResult;

/** Real implementation backed by child_process.spawnSync. */
export function default_subprocess_run(
  cmd: string[],
  opts: SubprocessRunOptions,
): SubprocessRunResult {
  const res = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeout * 1000,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FileNotFoundError(res.error.message);
    if (code === "ETIMEDOUT") throw new TimeoutExpired(cmd, opts.timeout);
    throw new OSError(res.error.message);
  }
  // Killed by the timeout without spawnSync reporting ETIMEDOUT (signal exit).
  if (res.signal === "SIGTERM" && res.status === null) {
    throw new TimeoutExpired(cmd, opts.timeout);
  }
  return {
    returncode: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// ── subprocess.Popen seam (used by TaskScheduler) ───────────────────────────

export interface PopenStdin {
  write(data: string): void;
  close(): void;
}

/**
 * Minimal structural view of a Popen object as taskboard.py uses it:
 * iterate stdout/stderr line-by-line, wait(), kill(), read returncode.
 * Test fakes implement exactly this shape.
 */
export interface PopenLike {
  pid: number;
  stdout: Iterable<string> | AsyncIterable<string>;
  stderr: Iterable<string> | AsyncIterable<string>;
  stdin?: PopenStdin | null;
  returncode: number | null;
  /** ≙ proc.wait(timeout=...); throws/rejects TimeoutExpired on timeout. */
  wait(timeout?: number | null): number | Promise<number>;
  kill(): void;
}

export interface PopenOptions {
  stdin?: typeof PIPE | null;
  stdout?: typeof PIPE;
  stderr?: typeof PIPE;
  cwd?: string;
  env?: Record<string, string>;
  start_new_session?: boolean;
}

/**
 * ≙ subprocess.Popen — may throw (or reject with) FileNotFoundError / OSError.
 * Test fakes are usually synchronous; callers `await` the result either way.
 */
export type PopenFn = (cmd: string[], opts: PopenOptions) => PopenLike | Promise<PopenLike>;

/** Split a Readable into lines, keeping the trailing "\n" like Python file iteration. */
async function* lineIterable(stream: Readable): AsyncGenerator<string> {
  stream.setEncoding("utf-8");
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      yield buf.slice(0, idx + 1);
      buf = buf.slice(idx + 1);
    }
  }
  if (buf) yield buf;
}

/** Real Popen implementation backed by child_process.spawn. */
export const default_popen: PopenFn = (cmd, opts) => {
  return new Promise<PopenLike>((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      detached: opts.start_new_session === true,
      stdio: [opts.stdin === PIPE ? "pipe" : "ignore", "pipe", "pipe"],
    });
    child.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      reject(
        code === "ENOENT"
          ? new FileNotFoundError(`No such file or directory: '${cmd[0]}'`)
          : new OSError(err.message),
      );
    });
    child.once("spawn", () => {
      const wrapper: PopenLike = {
        pid: child.pid!,
        stdout: lineIterable(child.stdout!),
        stderr: lineIterable(child.stderr!),
        stdin: child.stdin
          ? {
              write: (data: string) => child.stdin!.write(data),
              close: () => child.stdin!.end(),
            }
          : null,
        returncode: null,
        wait: () => 0, // replaced below
        kill: () => {
          child.kill("SIGKILL");
        },
      };
      const exited = new Promise<number>((res) => {
        child.once("close", (code) => {
          wrapper.returncode = code ?? -1;
          res(wrapper.returncode);
        });
      });
      wrapper.wait = (timeout: number | null = null): Promise<number> => {
        if (timeout === null || timeout === undefined) return exited;
        return new Promise<number>((res, rej) => {
          const timer = setTimeout(() => rej(new TimeoutExpired(cmd, timeout)), timeout * 1000);
          exited.then((code) => {
            clearTimeout(timer);
            res(code);
          });
        });
      };
      resolve(wrapper);
    });
  });
};

// ── AgentExecutor ────────────────────────────────────────────────────────────

/** Executes prompts via configurable AI agent CLIs. */
export class AgentExecutor {
  /** Injectable seam ≙ pytest monkeypatching `taskboard.subprocess.run`. */
  static subprocess_run: SubprocessRunFn = default_subprocess_run;

  /**
   * Run a prompt through Claude Code CLI.
   * Returns (success: bool, output: str)
   *
   * Args:
   *     prompt: The text prompt to send
   *     working_dir: Working directory for the command
   *     timeout: Command timeout in seconds
   *     image_paths: Optional list of image file paths to include
   */
  static run(
    prompt: string,
    working_dir: string = ".",
    timeout: number = DEFAULT_TIMEOUT_SECONDS,
    image_paths: string[] | null = null,
  ): [boolean, string] {
    try {
      const cmd = ["claude", "-p", prompt];

      // Add image paths if provided
      if (image_paths) {
        for (const img_path of image_paths) {
          cmd.push("-i", img_path);
        }
      }

      cmd.push(...CLAUDE_STREAM_JSON_ARGS);

      const result = AgentExecutor.subprocess_run(cmd, {
        cwd: expanduser(working_dir),
        timeout,
        env: getEnv(),
      });
      if (result.returncode === 0) {
        let output = result.stdout;
        for (let line of result.stdout.split("\n").reverse()) {
          line = line.trim();
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event && typeof event === "object" && event.type === "result") {
              output = event.result ?? result.stdout;
              break;
            }
          } catch {
            // not JSON — keep scanning
          }
        }
        return [true, output];
      } else {
        return [false, result.stderr || result.stdout];
      }
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        return [false, "claude CLI not found. Is it installed?"];
      }
      if (e instanceof TimeoutExpired) {
        return [false, `claude CLI timed out after ${timeout}s`];
      }
      if (e instanceof OSError) {
        return [false, e.message];
      }
      throw e;
    }
  }
}
