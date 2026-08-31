// Heartbeats: the periodic check_prompt run, its JSON decision protocol, and
// the pause/resume/trigger controls.

import { logger } from "../log.ts";
import { expanduser } from "../skills.ts";
import {
  DEFAULT_AGENT,
  HeartbeatDecisionType,
  ScheduleType,
  makeHeartbeat,
} from "../types.ts";
import {
  dateToLocalIso,
  errStr,
  nowIso,
  parseComparableDatetime,
} from "../util.ts";
import {
  type ActiveHandle,
  type Row,
  type SchedulerCtor,
  makeTaskFromPartial,
} from "./shared.ts";
import { SchedulerState } from "./state.ts";

export function HeartbeatsMixin<TBase extends SchedulerCtor<SchedulerState>>(
  Base: TBase,
) {
  return class HeartbeatsCapable extends Base {
    _spawn_heartbeat(heartbeat: Row): void {
      let alive = true;
      const handle: ActiveHandle = { is_alive: () => alive, promise: null };
      this._active_heartbeats.set(heartbeat["id"], handle);
      handle.promise = (async () => {
        try {
          await this._execute_heartbeat(heartbeat);
        } catch (e) {
          logger.error(
            `Heartbeat ${heartbeat["id"]} thread error: ${errStr(e)}`,
          );
        } finally {
          alive = false;
        }
      })();
    }

    _render_heartbeat_check_prompt(heartbeat: Row): string {
      const lines = [
        "You are AgentForge heartbeat decision engine.",
        "Return JSON only. No markdown, no explanation, no code fences.",
        "JSON schema:",
        '{"decision":"idle|trigger_task|error","reason":"string","dedupe_key":"string","title":"string","prompt":"string","metadata":{}}',
        "",
        `Heartbeat name: ${heartbeat["name"]}`,
        `Working directory: ${heartbeat["working_dir"]}`,
        `Current time: ${nowIso()}`,
        `Last tick at: ${heartbeat["last_tick_at"] || ""}`,
        `Last decision: ${heartbeat["last_decision"] || ""}`,
        `Last triggered at: ${heartbeat["last_triggered_at"] || ""}`,
        `Last dedupe key: ${heartbeat["last_dedupe_key"] || ""}`,
        "",
        "User-defined check instructions:",
        heartbeat["check_prompt"],
      ];
      if (heartbeat["action_prompt_template"]) {
        lines.push(
          "",
          "When decision is trigger_task, use this action prompt template as the base prompt to expand or adapt:",
          heartbeat["action_prompt_template"],
        );
      }
      return lines.join("\n");
    }

    _parse_heartbeat_decision(raw_text: string): Row {
      let text = raw_text.trim();
      if (text.startsWith("```")) {
        text = text
          .split(/\r?\n/)
          .filter((line) => !line.trim().startsWith("```"))
          .join("\n")
          .trim();
      }
      if (!text.startsWith("{")) {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
          text = text.slice(start, end + 1);
        }
      }
      const payload = JSON.parse(text) as Row;
      const decision = payload["decision"];
      if (
        !(Object.values(HeartbeatDecisionType) as string[]).includes(decision)
      ) {
        throw new Error(`Invalid heartbeat decision: ${decision}`);
      }
      const normalized: Row = {
        decision,
        reason: String(payload["reason"] ?? ""),
        dedupe_key: String(payload["dedupe_key"] ?? ""),
        title: String(payload["title"] ?? ""),
        prompt: String(payload["prompt"] ?? ""),
        metadata: payload["metadata"] || {},
      };
      if (
        typeof normalized["metadata"] !== "object" ||
        normalized["metadata"] === null ||
        Array.isArray(normalized["metadata"])
      ) {
        throw new Error("Heartbeat decision metadata must be an object");
      }
      return normalized;
    }

    _heartbeat_trigger_suppressed(heartbeat: Row, dedupe_key: string): boolean {
      if (!dedupe_key) {
        return false;
      }
      const existing = this.db.get_heartbeat_dedup(heartbeat["id"], dedupe_key);
      if (!existing) {
        return false;
      }
      const cooldown = Math.trunc(Number(heartbeat["cooldown_seconds"] || 0));
      const triggered_at = existing["triggered_at"];
      if (triggered_at) {
        try {
          const triggered_dt = parseComparableDatetime(triggered_at);
          if (
            triggered_dt &&
            cooldown > 0 &&
            Date.now() < triggered_dt.getTime() + cooldown * 1000
          ) {
            return true;
          }
        } catch {
          // ≙ except ValueError: pass
        }
      }
      const existing_task_id = existing["task_id"];
      if (existing_task_id) {
        const task = this.db.get_task(existing_task_id);
        if (
          task &&
          ["pending", "scheduled", "blocked", "running"].includes(
            task["status"],
          )
        ) {
          return true;
        }
      }
      return false;
    }

    async _execute_heartbeat(heartbeat: Row): Promise<void> {
      const hid = heartbeat["id"];
      const tick_id = this.db.add_heartbeat_tick(hid);
      const now = new Date();
      const output_chunks: string[] = [];
      this._live_heartbeat_output.set(tick_id, "");
      const next_run_at = this.db._compute_heartbeat_next_run_at(
        makeHeartbeat({
          id: hid,
          name: heartbeat["name"],
          enabled: heartbeat["enabled"],
          working_dir: heartbeat["working_dir"],
          schedule_type: heartbeat["schedule_type"],
          cron_expr: heartbeat["cron_expr"] ?? null,
          interval_seconds: heartbeat["interval_seconds"] ?? null,
          check_prompt: heartbeat["check_prompt"],
          action_prompt_template: heartbeat["action_prompt_template"] || "",
          default_agent: heartbeat["default_agent"] || DEFAULT_AGENT,
          cooldown_seconds: Math.trunc(
            Number(heartbeat["cooldown_seconds"] || 0),
          ),
        }),
        now,
      );
      try {
        const _append_tick_output = (line: string): void => {
          output_chunks.push(line);
          this._live_heartbeat_output.set(tick_id, output_chunks.join(""));
        };

        const agent = heartbeat["default_agent"] || DEFAULT_AGENT;
        const prompt = this._render_heartbeat_check_prompt(heartbeat);
        const working_dir_expanded = expanduser(heartbeat["working_dir"]);
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
          cmd = [
            "claude",
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "bypassPermissions",
          ];
        }
        const [success, raw_output] = await this._run_agent_command(
          agent,
          cmd,
          working_dir_expanded,
          _append_tick_output,
          _append_tick_output,
        );
        if (!success) {
          throw new Error(raw_output);
        }
        const decision = this._parse_heartbeat_decision(raw_output);
        let decision_type: string = decision["decision"];
        if (decision_type === HeartbeatDecisionType.TRIGGER_TASK) {
          const dedupe_key: string = decision["dedupe_key"] ?? "";
          if (this._heartbeat_trigger_suppressed(heartbeat, dedupe_key)) {
            decision_type = HeartbeatDecisionType.IDLE;
            decision["decision"] = decision_type;
            decision["reason"] =
              "Suppressed duplicate signal during cooldown or while prior task is still active";
          } else {
            const task_prompt =
              decision["prompt"] ||
              heartbeat["action_prompt_template"] ||
              heartbeat["check_prompt"];
            const task_title =
              decision["title"] || `Heartbeat: ${heartbeat["name"]}`;
            const task = {
              title: task_title,
              prompt: task_prompt,
              working_dir: heartbeat["working_dir"],
              schedule_type: ScheduleType.IMMEDIATE,
              agent: heartbeat["default_agent"] || DEFAULT_AGENT,
              tags: "heartbeat",
            };
            const task_id = this.submit_task(makeTaskFromPartial(task));
            if (dedupe_key) {
              this.db.upsert_heartbeat_dedup(hid, dedupe_key, task_id);
            }
            this.db.update_heartbeat(hid, {
              next_run_at,
              last_tick_at: dateToLocalIso(now),
              last_decision: decision_type,
              last_error: null,
              last_triggered_at: dateToLocalIso(now),
              last_dedupe_key: dedupe_key,
            });
            this.db.finish_heartbeat_tick(
              tick_id,
              "triggered",
              decision_type,
              decision,
              task_id,
              output_chunks.length
                ? output_chunks.join("").slice(0, 500000)
                : null,
            );
            return;
          }
        }
        this.db.update_heartbeat(hid, {
          next_run_at,
          last_tick_at: dateToLocalIso(now),
          last_decision: decision_type,
          last_error: null,
          last_dedupe_key:
            (decision["dedupe_key"] || heartbeat["last_dedupe_key"]) ?? null,
        });
        this.db.finish_heartbeat_tick(
          tick_id,
          decision_type === HeartbeatDecisionType.IDLE ? "idle" : decision_type,
          decision_type,
          decision,
          null,
          output_chunks.length ? output_chunks.join("").slice(0, 500000) : null,
        );
      } catch (e) {
        logger.error(`Heartbeat ${hid} failed: ${errStr(e)}`);
        this.db.update_heartbeat(hid, {
          next_run_at,
          last_tick_at: dateToLocalIso(now),
          last_decision: HeartbeatDecisionType.ERROR,
          last_error: errStr(e),
        });
        this.db.finish_heartbeat_tick(
          tick_id,
          "error",
          HeartbeatDecisionType.ERROR,
          null,
          null,
          output_chunks.length ? output_chunks.join("").slice(0, 500000) : null,
          errStr(e),
        );
      } finally {
        this._live_heartbeat_output.delete(tick_id);
        this._active_heartbeats.delete(hid);
      }
    }

    trigger_heartbeat_now(heartbeat_id: number): void {
      const heartbeat = this.db.get_heartbeat(heartbeat_id);
      if (!heartbeat) {
        throw new Error("heartbeat not found");
      }
      const handle = this._active_heartbeats.get(heartbeat_id);
      if (handle && handle.is_alive()) {
        throw new Error("heartbeat already running");
      }
      this._spawn_heartbeat(heartbeat);
    }

    pause_heartbeat(heartbeat_id: number): void {
      const heartbeat = this.db.get_heartbeat(heartbeat_id);
      if (!heartbeat) {
        throw new Error("heartbeat not found");
      }
      this.db.update_heartbeat(heartbeat_id, { enabled: 0 });
    }

    resume_heartbeat(heartbeat_id: number): void {
      const heartbeat = this.db.get_heartbeat(heartbeat_id);
      if (!heartbeat) {
        throw new Error("heartbeat not found");
      }
      const next_run_at = this.db._compute_heartbeat_next_run_at(
        makeHeartbeat({
          id: heartbeat_id,
          name: heartbeat["name"],
          enabled: true,
          working_dir: heartbeat["working_dir"],
          schedule_type: heartbeat["schedule_type"],
          cron_expr: heartbeat["cron_expr"] ?? null,
          interval_seconds: heartbeat["interval_seconds"] ?? null,
          check_prompt: heartbeat["check_prompt"],
          action_prompt_template: heartbeat["action_prompt_template"] || "",
          default_agent: heartbeat["default_agent"] || DEFAULT_AGENT,
          cooldown_seconds: Math.trunc(
            Number(heartbeat["cooldown_seconds"] || 0),
          ),
        }),
        new Date(),
      );
      this.db.update_heartbeat(heartbeat_id, { enabled: 1, next_run_at });
    }
  };
}
