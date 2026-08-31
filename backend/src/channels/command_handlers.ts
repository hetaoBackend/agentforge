/**
 * The three inbound slash-command flows every chat channel exposes: draft
 * briefs, custom runbooks, and skill suggestions.
 *
 * Feishu, Slack, Telegram and WeChat each carried their own copy of all three.
 * The copies agreed on the scheduler conversation — which payload to build,
 * which InboundMessageType to raise, how to read the result, which reply text
 * to format — and disagreed only on how a reply reaches the user and what
 * bookkeeping a freshly started task needs.
 *
 * That split is what `ChannelCommandContext` encodes. Everything a channel
 * genuinely owns becomes a field; everything else lives here once.
 *
 * Two details drove the shape of the context:
 *
 * - `error_prefix` exists because Slack renders `:x:` where the others emit a
 *   literal ❌. The sentence after the prefix is identical in all four.
 * - `on_task_started` owns the announcement rather than just the bookkeeping,
 *   because Feishu does not send a plain reply at all: it opens a card and
 *   streams into it. Handing the hook the finished text lets Feishu wrap it
 *   and lets the other three forward it untouched.
 *
 * `on_task_started` also collapses a second axis of duplication. Confirming a
 * brief and creating a runbook both end by binding a new task to the message
 * that spawned it, and each channel had written that block out twice —
 * independently, so the two copies were free to drift. Now every channel
 * states it once.
 */

import { InboundMessageType, type InboundMessage } from "../bus.ts";

import { resolve_agent, type SettingsDB } from "./agent_utils.ts";
import {
  build_brief_payload,
  build_runbook_payload,
  format_brief_created_reply,
  format_brief_discarded_reply,
  format_brief_help,
  format_brief_started_reply,
  format_runbook_brief_reply,
  format_runbook_created_reply,
  format_skill_suggestion_action_reply,
  format_skill_suggestion_help,
  type BriefCommand,
  type ParsedRunbookCommand,
  type SkillSuggestionCommand,
} from "./brief_utils.ts";
import { resolve_working_dir } from "./dir_utils.ts";

type Row = Record<string, unknown>;

/** The slice of a channel's scheduler these flows drive. */
export interface CommandScheduler {
  handle_inbound_message?(msg: InboundMessage): Row;
}

/** What a channel must supply to run any of the shared command flows. */
export interface ChannelCommandContext {
  /** Channel key ("feishu", "slack", …) recorded on every payload. */
  channel: string;
  db: SettingsDB;
  scheduler: CommandScheduler;
  /** Usually the channel's own `_make_inbound`, bound to the channel. */
  make_inbound(
    msg_type: InboundMessageType,
    payload: Row,
    reply_to: string,
    metadata: Row,
  ): InboundMessage;
  /** Leads every error reply: ❌ everywhere, `:x:` on Slack. */
  error_prefix: string;
  /** Channel-specific descriptor of the message that issued the command. */
  metadata: Row;
  /** Reply address handed to the scheduler. */
  target: string;
  /**
   * Send `text` back to wherever the command came from. Any result is
   * ignored — channels differ on whether they return the sent message id.
   */
  reply(text: string): void | Promise<unknown>;
}

/** Extra context for the two flows that can start a task. */
export interface TaskCommandContext extends ChannelCommandContext {
  /** Identifier of the originating message, stored on the payload. */
  source_ref: string;
  /**
   * Bind `task_id` to the originating message and announce it. Owns the
   * announcement because Feishu streams into a card instead of replying.
   */
  on_task_started(
    task_id: number,
    announcement: string,
  ): void | Promise<unknown>;
}

/**
 * Resolve the scheduler's inbound entry point with its receiver intact.
 *
 * Returns undefined on a scheduler that predates the inbound-message flow;
 * each caller reports that in its own words.
 */
function inbound_dispatch(
  scheduler: CommandScheduler,
): ((msg: InboundMessage) => Row) | undefined {
  return scheduler.handle_inbound_message?.bind(scheduler);
}

/** Run `/draft`, `/run-draft` and `/cancel-draft`. */
export async function handle_brief_command(
  ctx: TaskCommandContext,
  command: BriefCommand,
): Promise<void> {
  if (command.action === "help") {
    await ctx.reply(format_brief_help(command.reason));
    return;
  }
  const dispatch = inbound_dispatch(ctx.scheduler);
  if (!dispatch) {
    await ctx.reply(
      `${ctx.error_prefix} Draft task flow is not available in this scheduler.`,
    );
    return;
  }

  try {
    if (command.action === "create") {
      const payload = build_brief_payload({
        channel: ctx.channel,
        goal: command.goal,
        source_ref: ctx.source_ref,
        source_metadata: ctx.metadata,
        working_dir: await resolve_working_dir(
          command.goal,
          ctx.channel,
          ctx.db,
        ),
        agent: resolve_agent(ctx.channel, ctx.db),
      });
      const result = dispatch(
        ctx.make_inbound(
          InboundMessageType.CREATE_BRIEF,
          payload,
          ctx.target,
          ctx.metadata,
        ),
      );
      const brief_id = Number(result["brief_id"]);
      await ctx.reply(
        format_brief_created_reply(brief_id, String(payload["title"])),
      );
      return;
    }

    if (command.action === "confirm") {
      const result = dispatch(
        ctx.make_inbound(
          InboundMessageType.CONFIRM_BRIEF,
          { brief_id: command.brief_id },
          ctx.target,
          ctx.metadata,
        ),
      );
      const task_id = Number(result["task_id"]);
      if (!Number.isInteger(task_id) || task_id <= 0) {
        await ctx.reply(`${ctx.error_prefix} Draft task confirmation failed.`);
        return;
      }

      await ctx.on_task_started(
        task_id,
        format_brief_started_reply(command.brief_id, task_id),
      );
      return;
    }

    const result = dispatch(
      ctx.make_inbound(
        InboundMessageType.DISCARD_BRIEF,
        { brief_id: command.brief_id },
        ctx.target,
        ctx.metadata,
      ),
    );
    await ctx.reply(format_brief_discarded_reply(Number(result["brief_id"])));
  } catch (e) {
    await ctx.reply(
      `${ctx.error_prefix} ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Run a user-defined runbook command. */
export async function handle_runbook_command(
  ctx: TaskCommandContext,
  command: ParsedRunbookCommand,
): Promise<void> {
  const dispatch = inbound_dispatch(ctx.scheduler);
  if (!dispatch) {
    await ctx.reply(
      `${ctx.error_prefix} Custom command flow is not available in this scheduler.`,
    );
    return;
  }

  try {
    const payload = build_runbook_payload({
      channel: ctx.channel,
      command,
      source_ref: ctx.source_ref,
      source_metadata: ctx.metadata,
      working_dir: await resolve_working_dir(
        command.raw_args || command.name,
        ctx.channel,
        ctx.db,
      ),
      agent: resolve_agent(ctx.channel, ctx.db),
    });
    const result = dispatch(
      ctx.make_inbound(
        InboundMessageType.RUN_RUNBOOK,
        payload,
        ctx.target,
        ctx.metadata,
      ),
    );
    if (result["status"] === "created") {
      const task_id = Number(result["task_id"]);
      await ctx.on_task_started(
        task_id,
        format_runbook_created_reply(task_id, command.name),
      );
      return;
    }
    if (result["status"] === "draft") {
      await ctx.reply(
        format_runbook_brief_reply(Number(result["brief_id"]), command.name),
      );
      return;
    }
    await ctx.reply(`${ctx.error_prefix} Custom command failed.`);
  } catch (e) {
    await ctx.reply(
      `${ctx.error_prefix} ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Accept or dismiss a suggested skill. */
export async function handle_skill_suggestion_command(
  ctx: ChannelCommandContext,
  command: SkillSuggestionCommand,
): Promise<void> {
  if (command.action === "help") {
    await ctx.reply(format_skill_suggestion_help(command.reason));
    return;
  }
  const dispatch = inbound_dispatch(ctx.scheduler);
  if (!dispatch) {
    await ctx.reply(
      `${ctx.error_prefix} Skill suggestion flow is not available in this scheduler.`,
    );
    return;
  }

  try {
    const result = dispatch(
      ctx.make_inbound(
        InboundMessageType.SKILL_SUGGESTION_ACTION,
        {
          action: command.action,
          pattern_id: command.pattern_id,
          source_channel: ctx.channel,
          target: ctx.target,
          source_metadata: ctx.metadata,
        },
        ctx.target,
        ctx.metadata,
      ),
    );
    await ctx.reply(format_skill_suggestion_action_reply(result));
  } catch (e) {
    await ctx.reply(
      `${ctx.error_prefix} ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
