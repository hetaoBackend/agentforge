// Task execution: spawning the agent CLI, streaming its stdout/stderr into
// output events, and turning the exit into a task result.

import fs from "node:fs";
import path from "node:path";
import { OutboundMessageType } from "../bus.ts";
import {
  FileNotFoundError,
  OSError,
  PIPE,
  type PopenLike,
  ProcessLookupError,
  TimeoutExpired,
} from "../executor.ts";
import { logger } from "../log.ts";
import { expanduser } from "../skills.ts";
import {
  CLAUDE_STREAM_JSON_ARGS,
  DEFAULT_AGENT,
  DEFAULT_TIMEOUT_SECONDS,
  type Task,
} from "../types.ts";
import { errStr, getEnv, nowIso } from "../util.ts";
import {
  type Row,
  type SchedulerCtor,
  cron_next_iso,
  joinWithTimeout,
  realpathNonStrict,
} from "./shared.ts";
import { SchedulerState } from "./state.ts";

export function ExecutionMixin<TBase extends SchedulerCtor<SchedulerState>>(
  Base: TBase,
) {
  return class ExecutionCapable extends Base {
    async _execute_task(task: Row): Promise<void> {
      const tid: number = task["id"];
      this._live_output.set(tid, "");
      // Status already set to "running" by _spawn_task() before thread start.
      this._notify(tid);

      const run_id = this.db.add_run(tid);

      // Build command — inject upstream results if configured
      const prompt = this._build_injected_prompt(task);
      const prompt_images: Row[] = task["prompt_images"] || [];
      const image_paths: string[] = task["image_paths"] || []; // List of local image file paths

      // Convert image_paths to prompt_images format (base64 encoded)
      if (image_paths.length && !prompt_images.length) {
        // Only if not already using prompt_images
        const _ALLOWED_IMAGE_ROOTS = [expanduser("~"), "/tmp"];

        /** Return true only if path resolves inside an allowed directory. */
        const _is_safe_image_path = (p: string): boolean => {
          let resolved: string;
          try {
            resolved = realpathNonStrict(path.resolve(p));
          } catch {
            return false;
          }
          for (const root of _ALLOWED_IMAGE_ROOTS) {
            try {
              const resolved_root = realpathNonStrict(root);
              if (
                resolved.startsWith(resolved_root + path.sep) ||
                resolved === resolved_root
              ) {
                return true;
              }
            } catch {
              continue;
            }
          }
          return false;
        };

        for (const img_path of image_paths) {
          if (!_is_safe_image_path(img_path)) {
            logger.warning(
              `Task ${tid}: Rejected image path outside allowed directories: ${img_path}`,
            );
            continue;
          }
          try {
            const buf = fs.readFileSync(img_path);
            const img_data = buf.toString("base64");

            // Detect media type from file extension
            const img_path_lower = img_path.toLowerCase();
            let media_type: string;
            if (img_path_lower.endsWith(".png")) {
              media_type = "image/png";
            } else if (
              img_path_lower.endsWith(".jpg") ||
              img_path_lower.endsWith(".jpeg")
            ) {
              media_type = "image/jpeg";
            } else if (img_path_lower.endsWith(".gif")) {
              media_type = "image/gif";
            } else if (img_path_lower.endsWith(".webp")) {
              media_type = "image/webp";
            } else {
              // Try to detect from magic bytes
              const header = buf.subarray(0, 12);
              if (
                header.length >= 3 &&
                header[0] === 0xff &&
                header[1] === 0xd8 &&
                header[2] === 0xff
              ) {
                media_type = "image/jpeg";
              } else if (
                header.length >= 8 &&
                header
                  .subarray(0, 8)
                  .equals(
                    Buffer.from([
                      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                    ]),
                  )
              ) {
                media_type = "image/png";
              } else if (
                header.subarray(0, 6).toString("latin1") === "GIF87a" ||
                header.subarray(0, 6).toString("latin1") === "GIF89a"
              ) {
                media_type = "image/gif";
              } else if (
                header.subarray(0, 4).toString("latin1") === "RIFF" &&
                header.toString("latin1").includes("WEBP")
              ) {
                media_type = "image/webp";
              } else {
                media_type = "image/jpeg"; // default fallback
              }
            }

            prompt_images.push({
              media_type,
              data: img_data,
              name: path.basename(img_path),
            });
            logger.debug(
              `Task ${tid}: Loaded image ${img_path} as ${media_type} (${img_data.length} bytes base64)`,
            );
          } catch (e) {
            logger.error(
              `Task ${tid}: Failed to load image ${img_path}: ${errStr(e)}`,
            );
          }
        }
      }

      const agent: string = task["agent"] || DEFAULT_AGENT;
      const use_stdin = prompt_images.length > 0 && agent === "claude";

      let cmd: string[];
      if (agent === "codex") {
        const working_dir_expanded = expanduser(task["working_dir"]);
        if (task["session_id"]) {
          cmd = [
            "codex",
            "exec",
            "resume",
            "--json",
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            task["session_id"],
            prompt,
          ];
        } else {
          cmd = [
            "codex",
            "exec",
            "--json",
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            "--cd",
            working_dir_expanded,
            prompt,
          ];
        }
        for (const img_path of image_paths) {
          cmd.push("--image", img_path);
        }
      } else if (use_stdin) {
        // Claude multimodal input: pass via stdin with --input-format stream-json
        cmd = [
          "claude",
          "-p",
          "--input-format",
          "stream-json",
          ...CLAUDE_STREAM_JSON_ARGS,
        ];
      } else {
        cmd = ["claude", "-p", prompt, ...CLAUDE_STREAM_JSON_ARGS];
      }
      if (agent === "claude" && task["session_id"]) {
        cmd.push("--resume", task["session_id"]);
      }
      let raw_stdout = "";
      let raw_stderr = "";
      // Initialized before the try so the failure branch can read it even when
      // Popen itself raises (e.g. CLI not found) before the timer is armed.
      const timed_out = { value: false };
      let success = false;
      let output = "";
      try {
        const timeout_secs = parseInt(
          this.db.get_setting("timeout", String(DEFAULT_TIMEOUT_SECONDS)) ??
            String(DEFAULT_TIMEOUT_SECONDS),
          10,
        );
        const start_time = Date.now() / 1000;
        const proc = await this._popen(cmd, {
          stdin: use_stdin ? PIPE : null,
          stdout: PIPE,
          stderr: PIPE,
          cwd: expanduser(task["working_dir"]),
          env: getEnv(),
          start_new_session: true, // Create a new process group so all sub-agents are tracked
        });
        if (use_stdin) {
          // Build multimodal message content
          const content: Row[] = [{ type: "text", text: prompt }];
          for (const img of prompt_images) {
            content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: img["media_type"] ?? "image/jpeg",
                data: img["data"] ?? "",
              },
            });
          }
          const stdin_msg = JSON.stringify({
            type: "user",
            message: { role: "user", content },
          });
          proc.stdin!.write(stdin_msg + "\n");
          proc.stdin!.close();
        }
        const pgid = this._os.getpgid(proc.pid);
        this._active_pgids.set(tid, pgid);

        // Read stderr concurrently so it never blocks stdout reading
        const stderr_chunks: string[] = [];
        const stderr_promise = (async () => {
          for await (const line of proc.stderr) {
            stderr_chunks.push(line);
          }
        })().catch(() => {});

        // Timer that kills the entire process group if it exceeds the configured timeout
        const _kill = (): void => {
          timed_out.value = true;
          try {
            this._os.killpg(pgid, "SIGKILL");
          } catch (e) {
            logger.error(
              `Task ${tid}: killpg(${pgid}) failed: ${errStr(e)}, falling back to kill(${proc.pid})`,
            );
            try {
              this._os.kill(proc.pid, "SIGKILL");
            } catch (e2) {
              logger.error(
                `Task ${tid}: kill(${proc.pid}) also failed: ${errStr(e2)}`,
              );
            }
          }
        };

        const timer = setTimeout(_kill, timeout_secs * 1000);

        const chunks: string[] = [];
        try {
          for await (const line of proc.stdout) {
            chunks.push(line);
            this._live_output.set(tid, chunks.join(""));
            // Parse and store each line as an event
            this._parse_and_store_event(tid, run_id, line, agent);
          }
          await proc.wait();
        } finally {
          clearTimeout(timer);
        }
        await joinWithTimeout(stderr_promise, 2);

        // Wait for any Claude sub-agents still running in the process group.
        // Codex may spawn notify hooks that outlive `codex exec`; treating those
        // as task work leaves completed Codex runs stuck in "running".
        if (!timed_out.value && proc.returncode === 0 && agent === "claude") {
          const elapsed = Date.now() / 1000 - start_time;
          const remaining = Math.max(0, timeout_secs - elapsed);
          const subagent_deadline = Date.now() / 1000 + remaining;
          let waiting_logged = false;
          let broke = false;
          while (Date.now() / 1000 < subagent_deadline) {
            try {
              this._os.killpg(pgid, 0); // raises ProcessLookupError when group is gone
            } catch (e) {
              if (e instanceof ProcessLookupError) {
                broke = true;
                break;
              }
              throw e;
            }
            if (!waiting_logged) {
              waiting_logged = true;
              logger.info(
                `Task ${tid}: main process exited, waiting for sub-agents...`,
              );
            }
            this._live_output.set(
              tid,
              chunks.join("") + "\n[⏳ Waiting for sub-agents to complete...]",
            );
            await this._sleep(1);
          }
          if (!broke) {
            // Sub-agents exceeded remaining timeout — kill the group
            timed_out.value = true;
            try {
              this._os.killpg(pgid, "SIGKILL");
            } catch (e) {
              logger.error(
                `Task ${tid}: killpg(${pgid}) on sub-agent timeout failed: ${errStr(e)}`,
              );
            }
          }
        }

        this._active_pgids.delete(tid);

        raw_stdout = chunks.join("");
        raw_stderr = stderr_chunks.join("");

        if (timed_out.value) {
          success = false;
          output = `Task timed out after ${timeout_secs}s`;
        } else if (proc.returncode === 0) {
          if (agent === "codex") {
            const thread_id = this._extract_codex_thread_id(raw_stdout);
            const generated_images = this._find_codex_generated_images(
              thread_id,
              start_time,
            );
            if (generated_images.length) {
              this._store_generated_image_events(tid, run_id, generated_images);
            }
            success = true;
            output = this._extract_codex_success_output(
              raw_stdout,
              generated_images,
            );
          } else {
            // Claude stream-json: find the last result event and last assistant text
            let out = "";
            let last_assistant_text = "";
            for (let line of raw_stdout.split("\n")) {
              line = line.trim();
              if (!line) continue;
              try {
                const event = JSON.parse(line);
                if (event?.type === "assistant") {
                  const msg = event.message ?? {};
                  const content = msg.content ?? [];
                  const text_parts: string[] = [];
                  for (const c of content) {
                    if (typeof c === "string") {
                      text_parts.push(c);
                    } else if (
                      c &&
                      typeof c === "object" &&
                      c.type === "text"
                    ) {
                      text_parts.push(c.text ?? "");
                    }
                  }
                  if (text_parts.length) {
                    last_assistant_text = text_parts.join("");
                  }
                } else if (event?.type === "result") {
                  const result_text = event.result;
                  if (result_text) {
                    out = result_text;
                  }
                }
              } catch {
                // not JSON — keep scanning
              }
            }
            // If result event had no result field (e.g. error_during_execution
            // with 0 output tokens), fall back to last assistant message text
            if (!out) {
              out = last_assistant_text;
            }
            success = true;
            output = out;
          }
        } else {
          success = false;
          output = raw_stderr || raw_stdout;
        }
      } catch (e) {
        if (e instanceof FileNotFoundError) {
          const cli_name = task["agent"] === "codex" ? "codex" : "claude";
          const install_hint =
            cli_name === "codex"
              ? "Install with: npm install -g @openai/codex"
              : "Is it installed?";
          success = false;
          output = `${cli_name} CLI not found. ${install_hint}`;
          this._active_pgids.delete(tid);
        } else {
          logger.error(`Task ${tid} subprocess error: ${errStr(e)}`);
          success = false;
          output = errStr(e);
          this._active_pgids.delete(tid);
        }
      }

      this._live_output.delete(tid);
      if (agent === "codex") {
        this._clear_codex_run_state(run_id);
      } else if (agent === "claude") {
        this._clear_claude_run_state(run_id);
      }

      // Extract session_id from output (format differs by agent)
      let extracted_session_id: string | null = null;
      if (agent === "codex") {
        // Codex emits session_id in the thread.started event at the beginning
        extracted_session_id = this._extract_codex_thread_id(raw_stdout);
      } else {
        // Claude emits session_id in the result event at the end
        for (let line of raw_stdout.split("\n").reverse()) {
          line = line.trim();
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event?.type === "result" && event?.session_id) {
              extracted_session_id = event.session_id;
              break;
            }
          } catch {
            // not JSON — keep scanning
          }
        }
      }

      // Truncate raw_output for storage (max 500KB)
      const raw_output_stored = raw_stdout ? raw_stdout.slice(0, 500000) : null;

      const new_count = (task["run_count"] || 0) + 1;
      if (success) {
        const updates: Row = {
          result: output.slice(0, 50000), // truncate for storage
          last_run_at: nowIso(),
          run_count: new_count,
        };
        if (extracted_session_id) {
          updates["session_id"] = extracted_session_id;
        }
        // Handle cron rescheduling
        let cron_will_reschedule = false;
        if (task["schedule_type"] === "cron" && task["cron_expr"]) {
          const max_runs = task["max_runs"];
          if (max_runs && new_count >= max_runs) {
            updates["status"] = "completed";
          } else {
            updates["status"] = "scheduled";
            updates["next_run_at"] = cron_next_iso(
              task["cron_expr"],
              new Date(),
            );
            cron_will_reschedule = true;
          }
        } else {
          updates["status"] = "completed";
        }
        this.db.finish_run_and_update_task(
          run_id,
          "completed",
          tid,
          updates,
          output,
          null,
          raw_output_stored,
        );
        // For cron tasks that get rescheduled, notify channels with TASK_COMPLETED
        // before the status flips to "scheduled", so channels actually fire.
        if (cron_will_reschedule) {
          this._bus_notify(tid, OutboundMessageType.TASK_COMPLETED);
        }
      } else {
        // Extract a clean, human-readable error summary for task.error and
        // notification channels. The full raw output is preserved in run_error.
        let error_summary: string;
        if (timed_out.value) {
          // The timeout IS the reason — don't let an unrelated stderr line
          // (e.g. codex's "Reading additional input from stdin…") mask it.
          error_summary = output;
        } else {
          error_summary =
            raw_stderr || raw_stdout
              ? this._extract_error_summary(raw_stderr, raw_stdout)
              : output || "Unknown error";
        }
        const updates: Row = {
          status: "failed",
          error: error_summary,
          last_run_at: nowIso(),
          run_count: new_count,
        };
        // Persist the conversation id even on failure so the task stays
        // resumable (e.g. replying in a Feishu/Slack/Telegram thread to
        // retry). Codex emits thread_id in the opening thread.started event,
        // so even a started-then-failed run has one to recover.
        if (extracted_session_id) {
          updates["session_id"] = extracted_session_id;
        }
        this.db.finish_run_and_update_task(
          run_id,
          "failed",
          tid,
          updates,
          null,
          output,
          raw_output_stored,
        );
      }

      this._notify(tid);
      this._active_tasks.delete(tid);

      // DAG: trigger downstream cascade after task finishes
      if (success) {
        this._on_task_completed(tid);
      } else {
        this._on_task_failed(tid);
      }
    }

    async _run_agent_command(
      agent: string,
      cmd: string[],
      working_dir_expanded: string,
      on_stdout_line: ((line: string) => void) | null = null,
      on_stderr_line: ((line: string) => void) | null = null,
    ): Promise<[boolean, string]> {
      let proc: PopenLike;
      try {
        proc = await this._popen(cmd, {
          stdout: PIPE,
          stderr: PIPE,
          cwd: working_dir_expanded,
          env: getEnv(),
        });
      } catch (e) {
        if (e instanceof FileNotFoundError) {
          return [false, `${agent} CLI not found`];
        }
        if (e instanceof OSError) {
          return [false, e.message];
        }
        throw e;
      }
      const timeout_secs = parseInt(
        this.db.get_setting("timeout", String(DEFAULT_TIMEOUT_SECONDS)) ??
          String(DEFAULT_TIMEOUT_SECONDS),
        10,
      );
      const stdout_chunks: string[] = [];
      const stderr_chunks: string[] = [];

      const _read_stream = async (
        stream: Iterable<string> | AsyncIterable<string>,
        chunks: string[],
        callback: ((line: string) => void) | null,
      ): Promise<void> => {
        for await (const line of stream) {
          chunks.push(line);
          if (callback) {
            callback(line);
          }
        }
      };

      const stdout_promise = _read_stream(
        proc.stdout,
        stdout_chunks,
        on_stdout_line,
      ).catch(() => {});
      const stderr_promise = _read_stream(
        proc.stderr,
        stderr_chunks,
        on_stderr_line,
      ).catch(() => {});
      try {
        await proc.wait(timeout_secs);
      } catch (e) {
        if (e instanceof TimeoutExpired) {
          try {
            proc.kill();
          } catch {
            // ≙ except OSError: pass
          }
          await joinWithTimeout(stdout_promise, 1);
          await joinWithTimeout(stderr_promise, 1);
          return [false, `${agent} heartbeat decision timed out`];
        }
        throw e;
      }

      await joinWithTimeout(stdout_promise, 1);
      await joinWithTimeout(stderr_promise, 1);
      const raw_stdout = stdout_chunks.join("");
      const raw_stderr = stderr_chunks.join("");
      if (proc.returncode !== 0) {
        return [
          false,
          raw_stderr || raw_stdout || `${agent} heartbeat decision failed`,
        ];
      }

      if (agent === "codex") {
        let out = "";
        for (let line of raw_stdout.split("\n")) {
          line = line.trim();
          if (!line) continue;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            event?.type === "item.completed" &&
            event?.item?.type === "agent_message"
          ) {
            out = event.item.text ?? "";
          }
        }
        return [true, out || raw_stdout];
      }

      let out = "";
      let last_assistant_text = "";
      for (let line of raw_stdout.split("\n")) {
        line = line.trim();
        if (!line) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event?.type === "assistant") {
          const msg = event.message ?? {};
          const content = msg.content ?? [];
          const text_parts: string[] = [];
          for (const c of content) {
            if (typeof c === "string") {
              text_parts.push(c);
            } else if (c && typeof c === "object" && c.type === "text") {
              text_parts.push(c.text ?? "");
            }
          }
          if (text_parts.length) {
            last_assistant_text = text_parts.join("");
          }
        } else if (event?.type === "result") {
          const result_text = event.result;
          if (result_text) {
            out = result_text;
          }
        }
      }
      return [true, out || last_assistant_text || raw_stdout];
    }

    async _run_agent_prompt_once(
      agent: string,
      prompt: string,
      working_dir: string,
    ): Promise<[boolean, string]> {
      const working_dir_expanded = expanduser(working_dir);
      let cmd: string[];
      if (agent === "codex") {
        cmd = [
          "codex",
          "exec",
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
          "--cd",
          working_dir_expanded,
          prompt,
        ];
      } else {
        cmd = ["claude", "-p", prompt, ...CLAUDE_STREAM_JSON_ARGS];
      }
      return this._run_agent_command(agent, cmd, working_dir_expanded);
    }
  };
}
