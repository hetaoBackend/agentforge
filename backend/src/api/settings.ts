/**
 * Routes for application, Feishu and channel settings.
 */

import { parse_im_digest_recipients } from "../digests.ts";
import { DEFAULT_AGENT, DEFAULT_TIMEOUT_SECONDS } from "../types.ts";

import { restartChannels } from "./channels.ts";
import { jsonResponse, type RouteArgs } from "./shared.ts";
import type { Route } from "./router.ts";

async function getSettings({ ctx, origin }: RouteArgs): Promise<Response> {
  return jsonResponse(
    {
      default_agent: ctx.db.get_setting("default_agent", DEFAULT_AGENT),
      timeout: Number.parseInt(
        ctx.db.get_setting("timeout", String(DEFAULT_TIMEOUT_SECONDS)) ??
          String(DEFAULT_TIMEOUT_SECONDS),
        10,
      ),
      skill_library_enabled:
        ctx.db.get_setting("skill_library_enabled", "0") === "1",
      skill_sweep_agent: ctx.db.get_setting("skill_sweep_agent", DEFAULT_AGENT),
      skill_sweep_cron: ctx.db.get_setting("skill_sweep_cron", "0 3 * * *"),
      im_digest_enabled: ctx.db.get_setting("im_digest_enabled", "0") === "1",
      im_digest_cron: ctx.db.get_setting("im_digest_cron", "0 9 * * 1-5"),
      im_digest_channels: parse_im_digest_recipients(
        ctx.db.get_setting("im_digest_channels", "[]"),
      ),
      im_attention_digest_minutes: Number.parseInt(
        ctx.db.get_setting("im_attention_digest_minutes", "20") ?? "20",
        10,
      ),
      im_skill_suggestions_enabled:
        ctx.db.get_setting("im_skill_suggestions_enabled", "0") === "1",
      im_skill_suggestion_channels: parse_im_digest_recipients(
        ctx.db.get_setting("im_skill_suggestion_channels", "[]"),
      ),
    },
    200,
    origin,
  );
}

async function getFeishuSettings({
  ctx,
  origin,
}: RouteArgs): Promise<Response> {
  return jsonResponse(
    {
      feishu_app_id: ctx.db.get_setting("feishu_app_id", ""),
      feishu_app_secret: ctx.db.get_setting("feishu_app_secret", ""),
      feishu_default_chat_id: ctx.db.get_setting("feishu_default_chat_id", ""),
      feishu_default_working_dir: ctx.db.get_setting(
        "feishu_default_working_dir",
        "~",
      ),
      feishu_enabled: ctx.db.get_setting("feishu_enabled", "false"),
    },
    200,
    origin,
  );
}

async function postSettings({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  for (const [key, value] of Object.entries(body))
    ctx.db.set_setting(key, String(value));
  return jsonResponse({ status: "updated" }, 200, origin);
}

async function postFeishuSettings({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  for (const key of [
    "feishu_app_id",
    "feishu_app_secret",
    "feishu_default_chat_id",
    "feishu_default_working_dir",
    "feishu_enabled",
  ]) {
    if (key in body) ctx.db.set_setting(key, String(body[key]));
  }
  await restartChannels(ctx, body);
  return jsonResponse({ status: "updated" }, 200, origin);
}

async function postChannelsSettings({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  const allowed = new Set([
    "telegram_bot_token",
    "telegram_allowed_users",
    "telegram_default_working_dir",
    "telegram_enabled",
    "telegram_default_chat_id",
    "slack_bot_token",
    "slack_app_token",
    "slack_default_working_dir",
    "slack_default_channel",
    "slack_default_user",
    "slack_enabled",
    "weixin_default_working_dir",
    "weixin_base_url",
    "weixin_account_id",
    "weixin_enabled",
  ]);
  for (const [key, value] of Object.entries(body)) {
    if (allowed.has(key)) ctx.db.set_setting(key, String(value));
  }
  await restartChannels(ctx, body);
  return jsonResponse({ status: "updated" }, 200, origin);
}

async function putSettings({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  for (const [key, value] of Object.entries(body))
    ctx.db.set_setting(key, String(value));
  return jsonResponse({ status: "updated" }, 200, origin);
}

export const SETTINGS_ROUTES: Array<Route<RouteArgs>> = [
  { method: "GET", pattern: "/api/settings", handler: getSettings },
  {
    method: "GET",
    pattern: "/api/feishu/settings",
    handler: getFeishuSettings,
  },
  { method: "POST", pattern: "/api/settings", handler: postSettings },
  {
    method: "POST",
    pattern: "/api/feishu/settings",
    handler: postFeishuSettings,
  },
  {
    method: "POST",
    pattern: "/api/channels/settings",
    handler: postChannelsSettings,
  },
  { method: "PUT", pattern: "/api/settings", handler: putSettings },
];
