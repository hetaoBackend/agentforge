// Skill Library: sweeping completed runs for recurring patterns, distilling a
// pattern into a SKILL.md draft, and the approve/dismiss/toggle lifecycle.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../log.ts";
import {
  _compose_skill_md,
  _parse_skill_frontmatter,
  _sanitize_skill_name,
  _skill_creator_dir,
  link_skill,
  remove_skill_from_disk,
  unlink_skill,
  write_skill_to_disk,
} from "../skills.ts";
import { DEFAULT_AGENT } from "../types.ts";
import { errStr, parseComparableDatetime, parseJsonObject } from "../util.ts";
import {
  type Row,
  type SchedulerCtor,
  _int,
  cron_next_iso,
  croniter_is_valid,
} from "./shared.ts";
import { SchedulerState } from "./state.ts";

function parse_sweep_output(raw_text: string): unknown[] {
  let text = (raw_text || "").trim();
  if (text.startsWith("```")) {
    text = text
      .split(/\r?\n/)
      .filter((ln) => !ln.trim().startsWith("```"))
      .join("\n")
      .trim();
  }
  if (!text.startsWith("[")) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
      text = text.slice(start, end + 1);
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  return Array.isArray(data) ? data : [];
}

export function SkillsMixin<TBase extends SchedulerCtor<SchedulerState>>(
  Base: TBase,
) {
  return class SkillsCapable extends Base {
    /**
     * Built-in "skill-distiller": cron-driven auto sweep, gated by the toggle.
     *
     * Gated by skill_library_enabled (default OFF). Agent + cadence come from
     * skill_sweep_agent / skill_sweep_cron. The manual button bypasses this
     * entirely. When disabled, returns immediately — never calls an agent.
     */
    _maybe_run_scheduled_sweep(): void {
      if (
        !["1", "true", "True"].includes(
          this.db.get_setting("skill_library_enabled", "0") ?? "",
        )
      ) {
        return;
      }
      const cron = this.db.get_setting("skill_sweep_cron", "0 3 * * *");
      if (!cron || !croniter_is_valid(cron)) {
        return;
      }
      const now = new Date();
      const next_run_raw = this.db.get_setting("skill_sweep_next_run", "");
      if (!next_run_raw) {
        // First tick after enabling: schedule forward, don't run immediately.
        this.db.set_setting("skill_sweep_next_run", cron_next_iso(cron, now));
        return;
      }
      let next_run: Date | null;
      try {
        next_run = parseComparableDatetime(next_run_raw);
      } catch {
        next_run = null;
      }
      if (next_run === null || next_run.getTime() <= now.getTime()) {
        this.trigger_skill_sweep(
          this.db.get_setting("skill_sweep_agent", null),
        );
        this.db.set_setting("skill_sweep_next_run", cron_next_iso(cron, now));
      }
    }

    // ── Skill Library: cross-run sweep ───────────────────────────────────

    /**
     * Synchronous sweep core (tested directly).
     *
     * full=false (scheduled): only runs since the watermark — incremental, cheap.
     * full=true (manual button): re-scans the most recent completed runs ignoring
     * the watermark, so the button always analyzes something. Counting is
     * idempotent per run_id, so re-scanning never inflates recurrence counts.
     */
    async run_skill_sweep(
      agent: string | null = null,
      full: boolean = false,
    ): Promise<Row> {
      agent =
        agent ||
        this.db.get_setting("skill_sweep_agent", null) ||
        this.db.get_setting("default_agent", DEFAULT_AGENT);
      const watermark = this.db.get_setting("skill_sweep_watermark", "") || "";
      let runs: Row[];
      if (full) {
        runs = this.db.get_recent_completed_runs(this.SKILL_SWEEP_RUN_LIMIT);
      } else {
        runs = this.db.get_completed_runs_since(
          watermark,
          this.SKILL_SWEEP_RUN_LIMIT,
        );
      }
      if (!runs.length) {
        const result: Row = {
          scanned: 0,
          detected: 0,
          new: 0,
          candidates: 0,
          watermark,
          agent,
          full,
        };
        this._last_skill_sweep = result;
        return result;
      }

      const existing = this.db.get_skill_patterns();
      const prompt = this._build_sweep_prompt(runs, existing);
      const [ok, raw] = await this._run_agent_prompt_once(agent!, prompt, ".");
      if (!ok) {
        throw new Error(raw || "skill sweep agent failed");
      }

      let detected = 0;
      let new_occurrences = 0;
      for (const item of parse_sweep_output(raw)) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          continue;
        }
        const it = item as Row;
        const tid = _int(it["task_id"]);
        const rid = _int(it["run_id"]);
        const before = this.db.get_skill_pattern_recurrence(
          it["pattern_key"] ?? "",
        );
        const pid = this.db.upsert_skill_pattern(
          it["pattern_key"] ?? "",
          it["kind"] ?? "recipe",
          String(it["summary"] ?? ""),
          tid,
          rid,
        );
        if (pid !== null) {
          detected += 1;
          const after = this.db.get_skill_pattern_recurrence(
            it["pattern_key"] ?? "",
          );
          if (after > before) {
            new_occurrences += 1;
          }
        }
      }

      const finished = runs
        .map((r) => r["finished_at"])
        .filter(Boolean) as string[];
      const new_watermark = finished.length
        ? finished.reduce((a, b) => (a > b ? a : b))
        : watermark;
      if (new_watermark && new_watermark > watermark) {
        this.db.set_setting("skill_sweep_watermark", new_watermark);
      }
      const candidates = this.db.refresh_skill_candidates();
      const result: Row = {
        scanned: runs.length,
        detected,
        new: new_occurrences,
        candidates,
        watermark: new_watermark,
        agent,
        full,
      };
      this._last_skill_sweep = result;
      return result;
    }

    /**
     * Start a sweep in the background. Returns false if one is already running.
     *
     * The HTTP server is single-threaded, so a sweep (which can take minutes)
     * must not block the request thread.
     */
    trigger_skill_sweep(
      agent: string | null = null,
      full: boolean = false,
    ): boolean {
      if (this._skill_sweep_running) {
        return false;
      }
      this._skill_sweep_running = true;

      void (async () => {
        try {
          await this.run_skill_sweep(agent, full);
        } catch (e) {
          // surface to status, never crash the worker
          logger.error(`Skill sweep failed: ${errStr(e)}`);
          this._last_skill_sweep = { error: errStr(e) };
        } finally {
          this._skill_sweep_running = false;
        }
      })();
      return true;
    }

    skill_sweep_status(): { running: boolean; last: Row | null } {
      return {
        running: this._skill_sweep_running,
        last: this._last_skill_sweep,
      };
    }

    // ── Skill Library: distillation / approval ─────────────────────────────
    _build_distill_context(tids: number[]): string {
      const blocks: string[] = [];
      for (const tid of tids.slice(0, 5)) {
        const task = this.db.get_task(tid);
        if (!task) {
          continue;
        }
        const runs = this.db.get_task_runs(tid, 1);
        const result: string = (runs.length ? runs[0]!["result"] : "") || "";
        blocks.push(
          `[task #${tid}] ${task["title"] || "Untitled"}\n` +
            `  prompt: ${String(task["prompt"] || "")
              .trim()
              .slice(0, 600)}\n` +
            `  result: ${result.trim().slice(0, 600)}`,
        );
      }
      return blocks.join("\n\n");
    }

    _build_distill_prompt(
      pattern: Row,
      context: string,
      skill_creator_rel: string | null = null,
    ): string {
      const kind = pattern["kind"] ?? "recipe";
      let header: string;
      if (skill_creator_rel) {
        header =
          "You are creating a reusable Claude Code skill from a recurring task pattern. " +
          "You MUST author it USING the skill-creator skill, whose full authoring guidance " +
          "is on disk in this working directory at:\n" +
          `  ${skill_creator_rel}\n` +
          "Read that file first and follow its conventions for skill structure, the " +
          "description (triggering accuracy), progressive disclosure, and body style. " +
          "Do NOT run any of skill-creator's scripts, do NOT scaffold a directory on disk, " +
          "do NOT run evals or package anything — your ONLY output is the JSON described " +
          "below.\n\n";
      } else {
        header =
          "You are creating a reusable Claude Code skill from a recurring task pattern, " +
          "following Anthropic's skill-creator conventions (concise description that states " +
          "what AND when with concrete triggers; imperative body that explains why; " +
          "progressive disclosure; well under 500 lines).\n\n";
      }
      return (
        header +
        `Pattern key: ${pattern["pattern_key"]}\n` +
        `Kind: ${kind}\n` +
        `Summary: ${pattern["summary"] ?? ""}\n` +
        `Observed ${pattern["recurrence_count"] ?? 0} times across these task runs:\n\n` +
        `${context}\n\n` +
        "STEP 1 — Decide if a skill is genuinely warranted. A skill IS warranted when the " +
        "pattern is one of:\n" +
        "  - a repeatable, multi-step workflow run many times across different inputs;\n" +
        "  - produces an objectively verifiable output (file transform, data extraction, " +
        "code generation, fixed procedure);\n" +
        "  - encodes specialized/domain knowledge or best practices worth codifying.\n" +
        "A skill is NOT warranted for one-off, trivial, or purely subjective work (taste, " +
        "writing style) with no reusable procedure. Be honest — most patterns are not " +
        "skill-worthy.\n\n" +
        "STEP 2 — If worthy, author the SKILL.md using the skill-creator guidance above. " +
        "The description is the PRIMARY trigger: state BOTH what it does AND when to use it, " +
        "third person, concrete trigger phrasing. The body_markdown must NOT include YAML " +
        "frontmatter (it is added separately).\n\n" +
        "Respond with ONLY a JSON object, no prose, no code fence:\n" +
        '{"worthy": true, "worthiness_reason": "one sentence on why it is / is not ' +
        'skill-worthy", "name": "short-kebab-name", "description": "what AND when, with ' +
        'concrete triggers", "body_markdown": "the skill body, no frontmatter"}\n' +
        "If NOT worthy, set worthy=false and give the reason, but still fill name/" +
        "description/body_markdown with your best attempt — the human makes the final call."
      );
    }

    /** Synchronous distill core (tested directly). Saves a 'ready' draft. */
    async distill_skill_draft(
      pattern_id: number,
      agent: string | null = null,
    ): Promise<Row> {
      const pattern = this.db.get_skill_pattern(pattern_id);
      if (!pattern) {
        throw new Error("pattern not found");
      }
      agent =
        agent ||
        this.db.get_setting("skill_sweep_agent", null) ||
        this.db.get_setting("default_agent", DEFAULT_AGENT);
      let tids: number[];
      try {
        tids = JSON.parse(pattern["contributing_task_ids"]) || [];
        if (!Array.isArray(tids)) tids = [];
      } catch {
        tids = [];
      }
      const context = this._build_distill_context(tids);

      // Run the distill in a throwaway working dir that has the vendored
      // skill-creator skill loaded, so the agent actually authors the SKILL.md
      // *using* skill-creator (not just "in its style").
      const creator_src = _skill_creator_dir();
      let creator_rel: string | null = null;
      const workdir = fs.mkdtempSync(
        path.join(os.tmpdir(), "agentforge-distill-"),
      );
      let ok: boolean;
      let raw: string;
      try {
        let hasCreatorMd = false;
        try {
          hasCreatorMd = fs
            .statSync(path.join(creator_src, "SKILL.md"))
            .isFile();
        } catch {
          hasCreatorMd = false;
        }
        if (hasCreatorMd) {
          const dest = path.join(workdir, ".claude", "skills", "skill-creator");
          fs.mkdirSync(dest, { recursive: true });
          fs.copyFileSync(
            path.join(creator_src, "SKILL.md"),
            path.join(dest, "SKILL.md"),
          );
          creator_rel = ".claude/skills/skill-creator/SKILL.md";
        }
        const prompt = this._build_distill_prompt(
          pattern,
          context,
          creator_rel,
        );
        [ok, raw] = await this._run_agent_prompt_once(agent!, prompt, workdir);
      } finally {
        fs.rmSync(workdir, { recursive: true, force: true });
      }
      if (!ok) {
        throw new Error(raw || "distill agent failed");
      }
      const obj = parseJsonObject(raw);
      const name = _sanitize_skill_name(
        (obj["name"] as string) || pattern["pattern_key"],
      );
      const description = String(obj["description"] ?? "").trim();
      const body_md = String(obj["body_markdown"] || obj["body"] || "").trim();
      const worthy_raw = obj["worthy"];
      const worthy = typeof worthy_raw === "boolean" ? worthy_raw : null;
      const worthiness_reason = String(obj["worthiness_reason"] ?? "").trim();
      const skill_md = _compose_skill_md(name, description, body_md);
      this.db.upsert_skill_draft(
        pattern_id,
        "ready",
        name,
        description,
        pattern["kind"],
        skill_md,
        null,
        worthy,
        worthiness_reason,
      );
      return {
        pattern_id,
        name,
        description,
        kind: pattern["kind"],
        body: skill_md,
        worthy,
        worthiness_reason,
      };
    }

    /** Start distillation in the background (single-threaded server). */
    trigger_skill_draft(
      pattern_id: number,
      agent: string | null = null,
    ): boolean {
      const pattern = this.db.get_skill_pattern(pattern_id);
      if (!pattern) {
        return false;
      }
      this.db.upsert_skill_draft(
        pattern_id,
        "drafting",
        "",
        "",
        pattern["kind"],
      );

      void (async () => {
        try {
          await this.distill_skill_draft(pattern_id, agent);
        } catch (e) {
          // surface to draft row, never crash
          logger.error(`Skill distill failed: ${errStr(e)}`);
          this.db.upsert_skill_draft(
            pattern_id,
            "error",
            "",
            "",
            pattern["kind"],
            "",
            errStr(e),
          );
        }
      })();
      return true;
    }

    /** Write the approved SKILL.md, symlink it for both agents, register it. */
    approve_skill(
      pattern_id: number,
      name: string,
      description: string,
      body: string,
    ): Row | null {
      const pattern = this.db.get_skill_pattern(pattern_id);
      if (!pattern) {
        throw new Error("pattern not found");
      }
      if (!(body || "").trim()) {
        throw new Error("skill body is empty");
      }
      // The edited SKILL.md is the single source of truth: derive the skill name
      // and registry description from its frontmatter, falling back to the args.
      const [fm_name, fm_desc] = _parse_skill_frontmatter(body);
      name = _sanitize_skill_name(fm_name || name || pattern["pattern_key"]);
      if (!name) {
        throw new Error("invalid skill name");
      }
      description = fm_desc || description || "";
      const [skill_md_path] = write_skill_to_disk(name, body);
      const skill_id = this.db.add_skill(
        name,
        description || "",
        skill_md_path,
        pattern["pattern_key"],
        pattern["contributing_task_ids"],
        pattern["kind"],
      );
      this.db.set_skill_pattern_status(pattern_id, "promoted", skill_id);
      this.db.delete_skill_draft(pattern_id);
      return skill_id !== null ? this.db.get_skill(skill_id) : null;
    }

    dismiss_skill_pattern(pattern_id: number): void {
      if (!this.db.get_skill_pattern(pattern_id)) {
        throw new Error("pattern not found");
      }
      this.db.set_skill_pattern_status(pattern_id, "dismissed");
      this.db.delete_skill_draft(pattern_id);
    }

    // ── Skill Library: registry management (#19) ─────────────────────────

    /**
     * Enable/disable a registered skill by adding/removing both symlinks.
     *
     * Canonical SKILL.md is preserved either way — disabling just stops the
     * agents from loading it.
     */
    toggle_skill(skill_id: number, enabled: boolean): Row | null {
      const skill = this.db.get_skill(skill_id);
      if (!skill) {
        throw new Error("skill not found");
      }
      if (enabled) {
        link_skill(skill["name"]);
      } else {
        unlink_skill(skill["name"]);
      }
      this.db.set_skill_enabled(skill_id, enabled);
      return this.db.get_skill(skill_id);
    }

    /** Delete a skill: remove symlinks, canonical dir, and registry row. */
    remove_skill(skill_id: number): void {
      const skill = this.db.get_skill(skill_id);
      if (!skill) {
        throw new Error("skill not found");
      }
      remove_skill_from_disk(skill["name"]);
      this.db.delete_skill(skill_id);
    }

    _build_sweep_prompt(runs: Row[], existing: Row[]): string {
      let existing_block: string;
      if (existing.length) {
        existing_block = existing
          .map(
            (p) =>
              `- ${p["pattern_key"]} (${p["kind"]}, seen ${p["recurrence_count"]}x): ${p["summary"]}`,
          )
          .join("\n");
      } else {
        existing_block = "(none yet)";
      }
      const run_lines: string[] = [];
      for (const r of runs) {
        const p = String(r["prompt"] || "")
          .trim()
          .replaceAll("\n", " ")
          .slice(0, 400);
        const res = String(r["result"] || "")
          .trim()
          .replaceAll("\n", " ")
          .slice(0, 300);
        run_lines.push(
          `[run #${r["run_id"]} · task #${r["task_id"]}] ${r["title"] || "Untitled"}\n` +
            `  prompt: ${p}\n` +
            `  result: ${res}`,
        );
      }
      const runs_block = run_lines.join("\n");
      return (
        "You analyze a developer's recently completed AI-agent task runs to detect " +
        "RECURRING patterns of work worth distilling into a reusable skill.\n\n" +
        "Existing tracked patterns — REUSE an existing pattern_key verbatim when a run " +
        "matches one semantically; otherwise mint a new short kebab-case key:\n" +
        `${existing_block}\n\n` +
        "Recently completed task runs to analyze (each line is ONE run):\n" +
        `${runs_block}\n\n` +
        "Emit ONE entry PER RUN that represents a meaningful, repeatable capability. Kinds:\n" +
        '- "recipe": a successful repeatable approach/workflow worth reusing.\n' +
        '- "pitfall": a failure that was diagnosed and fixed, worth avoiding next time.\n' +
        "CRITICAL: when several runs share the same capability, they MUST reuse the SAME " +
        "pattern_key (so occurrences aggregate), but each run still gets its OWN entry with " +
        "its own run_id and task_id. Do NOT collapse multiple matching runs into a single " +
        "entry — one entry per run is how recurrence is counted. Reuse an existing tracked " +
        "pattern_key verbatim when it matches. Skip trivial or truly one-off runs.\n\n" +
        "Respond with ONLY a JSON array, no prose, no code fence (example shows two runs of " +
        "the same pattern):\n" +
        '[{"pattern_key":"run-pytest-suite","kind":"recipe","summary":"one concise line","run_id":12,"task_id":3},' +
        '{"pattern_key":"run-pytest-suite","kind":"recipe","summary":"one concise line","run_id":15,"task_id":4}]\n' +
        "If nothing is worth tracking, respond with []."
      );
    }

    /** Instance alias so tests can call `sched._parse_sweep_output(...)` like Python. */
    _parse_sweep_output(raw_text: string): unknown[] {
      return parse_sweep_output(raw_text);
    }
  };
}
