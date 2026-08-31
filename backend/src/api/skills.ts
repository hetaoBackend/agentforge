/**
 * Routes for skills, skill patterns and skill suggestions.
 */

import fs from "node:fs";

import { InboundMessageType, makeInboundMessage } from "../bus.ts";
import {
  type IMDigestRecipient,
  parse_im_digest_recipients,
} from "../digests.ts";
import {
  collect_im_skill_suggestions,
  render_im_skill_suggestion_text,
} from "../skill_suggestions.ts";

import { sendIMDigest } from "./im_digests.ts";
import {
  type ApiContext,
  asString,
  idAt,
  jsonResponse,
  type RouteArgs,
  type Row,
} from "./shared.ts";
import type { Route } from "./router.ts";

function skillSuggestionRecipients(
  ctx: ApiContext,
  body: Row,
): IMDigestRecipient[] {
  if ("recipients" in body) {
    return parse_im_digest_recipients(body["recipients"]);
  }
  return parse_im_digest_recipients(
    ctx.db.get_setting("im_skill_suggestion_channels", "[]"),
  );
}

function skillSuggestionPreview(ctx: ApiContext, body: Row): Row {
  const channel = asString(body["channel"]).trim() || null;
  const limit =
    body["limit"] === undefined || body["limit"] === null
      ? undefined
      : Number(body["limit"]);
  const suggestions = collect_im_skill_suggestions(ctx.db, {
    channel,
    limit,
  });
  return {
    suggestions,
    texts: suggestions.map((suggestion) =>
      render_im_skill_suggestion_text(suggestion),
    ),
  };
}

async function getSkillPatterns({ ctx, origin }: RouteArgs): Promise<Response> {
  return jsonResponse(
    {
      patterns: ctx.db.get_skill_patterns(),
      sweep: ctx.scheduler.skill_sweep_status(),
    },
    200,
    origin,
  );
}

async function getSkills({ ctx, origin }: RouteArgs): Promise<Response> {
  return jsonResponse({ skills: ctx.db.get_skills() }, 200, origin);
}

async function getSkillContent({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const sid = idAt(path);
  const skill = sid === null ? null : ctx.db.get_skill(sid);
  if (!skill) return jsonResponse({ error: "not found" }, 404, origin);
  let content: string;
  try {
    content = fs.readFileSync(String(skill["path"]), "utf8");
  } catch (e) {
    content = `(无法读取 SKILL.md：${e})`;
  }
  return jsonResponse({ content, path: skill["path"], skill }, 200, origin);
}

async function postSkillSuggestionPreview({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  return jsonResponse(skillSuggestionPreview(ctx, body), 200, origin);
}

async function postSkillSuggestionSend({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  const recipients = skillSuggestionRecipients(ctx, body);
  if (!recipients.length) {
    return jsonResponse(
      { error: "no skill suggestion recipients configured" },
      409,
      origin,
    );
  }
  const includeSent = Boolean(body["include_sent"] ?? false);
  const sentSuggestions: Row[] = [];
  try {
    for (const recipient of recipients) {
      const suggestions = collect_im_skill_suggestions(ctx.db, {
        channel: recipient.channel,
        limit:
          body["limit"] === undefined || body["limit"] === null
            ? undefined
            : Number(body["limit"]),
      });
      for (const suggestion of suggestions) {
        if (
          !includeSent &&
          !ctx.db.should_send_im_skill_suggestion(
            suggestion.pattern_id,
            recipient.channel,
            recipient.target,
          )
        ) {
          continue;
        }
        await sendIMDigest(
          ctx,
          recipient,
          render_im_skill_suggestion_text(suggestion),
        );
        ctx.db.upsert_im_skill_suggestion({
          pattern_id: suggestion.pattern_id,
          channel: recipient.channel,
          target: recipient.target,
          status: "suggested",
        });
        sentSuggestions.push({
          pattern_id: suggestion.pattern_id,
          channel: recipient.channel,
          target: recipient.target,
        });
      }
    }
  } catch (e) {
    return jsonResponse(
      { error: e instanceof Error ? e.message : String(e) },
      409,
      origin,
    );
  }
  return jsonResponse(
    {
      status: "sent",
      sent: sentSuggestions.length,
      suggestions: sentSuggestions,
    },
    200,
    origin,
  );
}

async function postSkillSuggestionAction({
  ctx,
  path,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  const patternId = idAt(path);
  if (patternId === null) {
    return jsonResponse({ error: "pattern not found" }, 404, origin);
  }
  try {
    const result = ctx.scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.SKILL_SUGGESTION_ACTION,
        source: "api",
        reply_to:
          body["target"] === undefined || body["target"] === null
            ? null
            : String(body["target"]),
        payload: {
          ...body,
          pattern_id: patternId,
          source_channel:
            asString(
              body["source_channel"] ?? body["channel"] ?? "api",
            ).trim() || "api",
          target: asString(body["target"] ?? ""),
        },
      }),
    );
    return jsonResponse(result, 200, origin);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse(
      { error: msg },
      msg.includes("not found") ? 404 : 400,
      origin,
    );
  }
}

async function postSkillsSweep({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  const started = ctx.scheduler.trigger_skill_sweep(
    body["agent"] ?? null,
    Boolean(body["full"] ?? true),
  );
  return started
    ? jsonResponse({ status: "started" }, 200, origin)
    : jsonResponse({ error: "sweep already running" }, 409, origin);
}

async function postSkillPatternDraft({
  ctx,
  path,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  const pid = idAt(path);
  if (
    pid === null ||
    !ctx.scheduler.trigger_skill_draft(pid, body["agent"] ?? null)
  ) {
    return jsonResponse({ error: "pattern not found" }, 404, origin);
  }
  return jsonResponse({ status: "drafting" }, 200, origin);
}

async function postSkillPatternApprove({
  ctx,
  path,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  const pid = idAt(path);
  if (pid === null)
    return jsonResponse({ error: "pattern not found" }, 404, origin);
  const draft = ctx.db.get_skill_draft(pid);
  try {
    const skill = ctx.scheduler.approve_skill(
      pid,
      String(body["name"] ?? draft?.["name"] ?? ""),
      String(body["description"] ?? draft?.["description"] ?? ""),
      String(body["body"] ?? draft?.["body"] ?? ""),
    );
    return jsonResponse({ status: "approved", skill }, 200, origin);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse(
      { error: msg },
      msg.includes("not found") ? 404 : 400,
      origin,
    );
  }
}

async function postSkillPatternDismiss({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const pid = idAt(path);
  try {
    if (pid === null) throw new Error("pattern not found");
    ctx.scheduler.dismiss_skill_pattern(pid);
  } catch (e) {
    return jsonResponse(
      { error: e instanceof Error ? e.message : String(e) },
      404,
      origin,
    );
  }
  return jsonResponse({ status: "dismissed" }, 200, origin);
}

async function putSkill({
  ctx,
  path,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  const sid = idAt(path);
  if (sid === null)
    return jsonResponse({ error: "invalid skill id" }, 400, origin);
  try {
    const skill = ctx.scheduler.toggle_skill(
      sid,
      Boolean(body["enabled"] ?? true),
    );
    return jsonResponse({ status: "updated", skill }, 200, origin);
  } catch (e) {
    return jsonResponse(
      { error: e instanceof Error ? e.message : String(e) },
      404,
      origin,
    );
  }
}

async function deleteSkill({
  ctx,
  path,
  origin,
}: RouteArgs): Promise<Response> {
  const sid = idAt(path);
  if (sid === null)
    return jsonResponse({ error: "invalid skill id" }, 400, origin);
  try {
    ctx.scheduler.remove_skill(sid);
    return jsonResponse({ status: "deleted" }, 200, origin);
  } catch (e) {
    return jsonResponse(
      { error: e instanceof Error ? e.message : String(e) },
      404,
      origin,
    );
  }
}

export const SKILL_ROUTES: Array<Route<RouteArgs>> = [
  { method: "GET", pattern: "/api/skill-patterns", handler: getSkillPatterns },
  { method: "GET", pattern: "/api/skills", handler: getSkills },
  {
    method: "GET",
    pattern: "/api/skills/:skill_id/content",
    handler: getSkillContent,
  },
  {
    method: "POST",
    pattern: "/api/im-skill-suggestions/preview",
    handler: postSkillSuggestionPreview,
  },
  {
    method: "POST",
    pattern: "/api/im-skill-suggestions/send",
    handler: postSkillSuggestionSend,
  },
  {
    method: "POST",
    pattern: "/api/im-skill-suggestions/:suggestion_id/action",
    handler: postSkillSuggestionAction,
  },
  { method: "POST", pattern: "/api/skills/sweep", handler: postSkillsSweep },
  {
    method: "POST",
    pattern: "/api/skill-patterns/:pattern_id/draft",
    handler: postSkillPatternDraft,
  },
  {
    method: "POST",
    pattern: "/api/skill-patterns/:pattern_id/approve",
    handler: postSkillPatternApprove,
  },
  {
    method: "POST",
    pattern: "/api/skill-patterns/:pattern_id/dismiss",
    handler: postSkillPatternDismiss,
  },
  { method: "PUT", pattern: "/api/skills/:skill_id+", handler: putSkill },
  { method: "DELETE", pattern: "/api/skills/:skill_id+", handler: deleteSkill },
];
