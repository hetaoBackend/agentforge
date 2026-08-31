// Inbound chat-message handling: task briefs, runbooks, digests and skill
// suggestions arriving from the channels through the MessageBus.

import { type InboundMessage, InboundMessageType } from "../bus.ts";
import { compose_im_digest, render_im_digest_text } from "../digests.ts";
import {
  collect_im_skill_suggestions,
  render_im_skill_suggestion_text,
} from "../skill_suggestions.ts";
import {
  RunbookConfirmationPolicy,
  type RunbookExpansion,
  expand_runbook,
  runbook_from_row,
} from "../runbooks.ts";
import {
  DEFAULT_AGENT,
  ScheduleType,
  TaskBriefStatus,
  makeTaskBrief,
} from "../types.ts";
import {
  type Row,
  type SchedulerCtor,
  _int,
  _plain_object,
  _string_list,
  _task_brief_prompt,
  makeTaskFromPartial,
} from "./shared.ts";
import { SchedulerState } from "./state.ts";

export function InboundMixin<TBase extends SchedulerCtor<SchedulerState>>(
  Base: TBase,
) {
  return class InboundCapable extends Base {
    handle_inbound_message(msg: InboundMessage): Row {
      if (msg.type === InboundMessageType.CREATE_BRIEF) {
        return this._handle_create_brief(msg);
      }
      if (msg.type === InboundMessageType.CONFIRM_BRIEF) {
        return this._handle_confirm_brief(msg);
      }
      if (msg.type === InboundMessageType.DISCARD_BRIEF) {
        return this._handle_discard_brief(msg);
      }
      if (msg.type === InboundMessageType.PREVIEW_RUNBOOK) {
        return this._handle_preview_runbook(msg);
      }
      if (msg.type === InboundMessageType.RUN_RUNBOOK) {
        return this._handle_run_runbook(msg);
      }
      if (msg.type === InboundMessageType.TRIGGER_DIGEST) {
        return this._handle_trigger_digest(msg);
      }
      if (msg.type === InboundMessageType.SKILL_SUGGESTION_ACTION) {
        return this._handle_skill_suggestion_action(msg);
      }
      return { status: "ignored" };
    }

    _handle_create_brief(msg: InboundMessage): Row {
      const payload = msg.payload;
      const title = String(payload["title"] ?? "").trim();
      const goal = String(payload["goal"] ?? "").trim();
      const source_channel = String(
        payload["source_channel"] ?? msg.source ?? "",
      ).trim();
      const source_ref = String(
        payload["source_ref"] ??
          msg.metadata["source_ref"] ??
          msg.metadata["message_id"] ??
          msg.reply_to ??
          "",
      ).trim();
      if (!title || !goal || !source_channel || !source_ref) {
        throw new Error(
          "title, goal, source_channel, and source_ref are required",
        );
      }
      const id = this.db.add_task_brief(
        makeTaskBrief({
          title,
          goal,
          context_summary: String(payload["context_summary"] ?? ""),
          acceptance_criteria: _string_list(payload["acceptance_criteria"]),
          working_dir:
            payload["working_dir"] === null ||
            payload["working_dir"] === undefined
              ? null
              : String(payload["working_dir"]),
          working_dir_confidence: String(
            payload["working_dir_confidence"] ?? "unknown",
          ),
          agent:
            payload["agent"] === null || payload["agent"] === undefined
              ? null
              : String(payload["agent"]),
          risk_level: String(payload["risk_level"] ?? "normal"),
          needs_confirmation:
            payload["needs_confirmation"] === undefined
              ? true
              : Boolean(payload["needs_confirmation"]),
          source_channel,
          source_ref,
          source_metadata: _plain_object(payload["source_metadata"]),
          expires_at:
            payload["expires_at"] === null ||
            payload["expires_at"] === undefined
              ? null
              : String(payload["expires_at"]),
        }),
      );
      return { brief_id: id, status: TaskBriefStatus.DRAFT };
    }

    _handle_confirm_brief(msg: InboundMessage): Row {
      const brief_id = _int(msg.payload["brief_id"]);
      if (brief_id === null) {
        throw new Error("brief_id is required");
      }
      const brief = this.db.get_task_brief(brief_id);
      if (!brief) {
        throw new Error("draft task not found");
      }
      if (brief["status"] !== TaskBriefStatus.DRAFT) {
        throw new Error(
          `Cannot confirm draft task with status '${brief["status"]}'.`,
        );
      }
      const source_channel = String(brief["source_channel"] ?? "").trim();
      const task = {
        title: String(brief["title"] ?? "Untitled"),
        prompt: _task_brief_prompt(brief),
        working_dir: String(brief["working_dir"] || "."),
        schedule_type: ScheduleType.IMMEDIATE,
        tags: ["im-inbox", source_channel].filter(Boolean).join(","),
        agent: String(
          brief["agent"] ||
            this.db.get_setting("default_agent", DEFAULT_AGENT) ||
            DEFAULT_AGENT,
        ),
      };
      const task_id = this.submit_task(makeTaskFromPartial(task));
      this.db.confirm_task_brief(brief_id, task_id);
      return { task_id, status: "created" };
    }

    _handle_discard_brief(msg: InboundMessage): Row {
      const brief_id = _int(msg.payload["brief_id"]);
      if (brief_id === null) {
        throw new Error("brief_id is required");
      }
      const brief = this.db.get_task_brief(brief_id);
      if (!brief) {
        throw new Error("draft task not found");
      }
      if (brief["status"] !== TaskBriefStatus.DRAFT) {
        throw new Error(
          `Cannot discard draft task with status '${brief["status"]}'.`,
        );
      }
      this.db.discard_task_brief(brief_id);
      return { brief_id, status: TaskBriefStatus.DISCARDED };
    }

    private _expand_runbook_message(msg: InboundMessage): RunbookExpansion {
      const payload = msg.payload;
      const source_channel = String(
        payload["source_channel"] ?? msg.source ?? "",
      ).trim();
      const source_ref = String(
        payload["source_ref"] ??
          msg.metadata["source_ref"] ??
          msg.metadata["message_id"] ??
          msg.reply_to ??
          "",
      ).trim();
      const result = expand_runbook({
        name: String(payload["name"] ?? "").trim(),
        raw_args: String(payload["raw_args"] ?? ""),
        source_channel,
        source_ref,
        source_metadata: _plain_object(payload["source_metadata"]),
        working_dir:
          payload["working_dir"] === null ||
          payload["working_dir"] === undefined
            ? null
            : String(payload["working_dir"]),
        agent:
          payload["agent"] === null || payload["agent"] === undefined
            ? null
            : String(payload["agent"]),
        runbooks: this.db
          .get_im_runbooks(true)
          .map((row) => runbook_from_row(row)),
      });
      if (!result.ok || !result.expansion) {
        throw new Error(result.error ?? "invalid runbook");
      }
      return result.expansion;
    }

    _handle_preview_runbook(msg: InboundMessage): Row {
      const expansion = this._expand_runbook_message(msg);
      const id = this.db.add_task_brief({
        ...expansion.brief,
        needs_confirmation: true,
      });
      return {
        brief_id: id,
        runbook: expansion.runbook.name,
        status: TaskBriefStatus.DRAFT,
      };
    }

    _handle_run_runbook(msg: InboundMessage): Row {
      const expansion = this._expand_runbook_message(msg);
      if (expansion.confirmation_policy === RunbookConfirmationPolicy.AUTO) {
        const task_id = this.submit_task(expansion.task);
        return {
          runbook: expansion.runbook.name,
          status: "created",
          task_id,
        };
      }
      const brief_id = this.db.add_task_brief(expansion.brief);
      return {
        brief_id,
        runbook: expansion.runbook.name,
        status: TaskBriefStatus.DRAFT,
      };
    }

    _handle_trigger_digest(msg: InboundMessage): Row {
      const payload = msg.payload;
      const digest = compose_im_digest(this.db, {
        include_empty: Boolean(payload["include_empty"] ?? false),
        limit:
          payload["limit"] === undefined ? undefined : Number(payload["limit"]),
        since:
          payload["since"] === null || payload["since"] === undefined
            ? null
            : String(payload["since"]),
      });
      if (!digest.has_content) {
        return { status: "quiet", digest };
      }
      return {
        status: "ready",
        digest,
        text: render_im_digest_text(digest),
      };
    }

    private _skill_suggestion_target(msg: InboundMessage): {
      channel: string;
      target: string;
    } {
      const channel = String(
        msg.payload["source_channel"] ?? msg.source ?? "",
      ).trim();
      const target = String(msg.payload["target"] ?? msg.reply_to ?? "").trim();
      if (!channel) {
        throw new Error("source_channel is required");
      }
      return { channel, target };
    }

    private _ready_skill_draft(pattern_id: number): Row {
      const draft = this.db.get_skill_draft(pattern_id);
      if (
        !draft ||
        draft["status"] !== "ready" ||
        !String(draft["body"] ?? "").trim()
      ) {
        throw new Error("skill draft is not ready");
      }
      return draft;
    }

    _handle_skill_suggestion_action(msg: InboundMessage): Row {
      const action = String(msg.payload["action"] ?? "")
        .trim()
        .toLowerCase();
      const pattern_id = _int(msg.payload["pattern_id"]);
      if (pattern_id === null) {
        throw new Error("pattern_id is required");
      }
      const { channel, target } = this._skill_suggestion_target(msg);

      if (action === "draft") {
        const started = this.trigger_skill_draft(
          pattern_id,
          msg.payload["agent"] === undefined || msg.payload["agent"] === null
            ? null
            : String(msg.payload["agent"]),
        );
        if (!started) {
          throw new Error("pattern not found");
        }
        this.db.upsert_im_skill_suggestion({
          pattern_id,
          channel,
          target,
          status: "suggested",
          metadata: _plain_object(msg.payload["source_metadata"]),
        });
        return { pattern_id, status: "drafting" };
      }

      if (action === "show") {
        this._ready_skill_draft(pattern_id);
        const suggestion = collect_im_skill_suggestions(this.db, {
          limit: 200,
        }).find((item) => item.pattern_id === pattern_id);
        if (!suggestion) {
          throw new Error("pattern not found");
        }
        this.db.mark_im_skill_suggestion_draft_shown(
          pattern_id,
          channel,
          target,
        );
        return {
          pattern_id,
          status: "ready",
          suggestion,
          text: render_im_skill_suggestion_text(suggestion),
        };
      }

      if (action === "approve") {
        const state = this.db.get_im_skill_suggestion(
          pattern_id,
          channel,
          target,
        );
        if (!state?.["draft_shown_at"]) {
          throw new Error("draft must be shown before approval");
        }
        const draft = this._ready_skill_draft(pattern_id);
        const skill = this.approve_skill(
          pattern_id,
          String(draft["name"] ?? ""),
          String(draft["description"] ?? ""),
          String(draft["body"] ?? ""),
        );
        this.db.mark_im_skill_suggestion_status(
          pattern_id,
          channel,
          target,
          "approved",
        );
        return { pattern_id, skill, status: "approved" };
      }

      if (action === "dismiss") {
        this.dismiss_skill_pattern(pattern_id);
        this.db.mark_im_skill_suggestion_status(
          pattern_id,
          channel,
          target,
          "dismissed",
        );
        return { pattern_id, status: "dismissed" };
      }

      throw new Error("unsupported skill suggestion action");
    }
  };
}
