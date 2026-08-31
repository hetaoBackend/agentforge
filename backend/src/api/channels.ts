/**
 * Routes for IM channel status and channel restarts.
 */

import { FeishuChannel } from "../channels/feishu.ts";
import { SlackChannel } from "../channels/slack.ts";
import { create_telegram_channel } from "../channels/telegram.ts";
import { WeixinChannel } from "../channels/weixin.ts";

import {
  type ApiContext,
  asString,
  jsonResponse,
  type RouteArgs,
  type Row,
} from "./shared.ts";
import type { Route } from "./router.ts";

function weixinStatus(ctx: ApiContext): Row {
  const snapshot = ctx.weixin_channel?.get_status_snapshot?.() ?? {};
  const runtimeAccount = asString(snapshot["account_id"]);
  const configuredAccount = ctx.db.get_setting("weixin_account_id", "") ?? "";
  return {
    enabled: ctx.db.get_setting("weixin_enabled", "false") === "true",
    configured: Boolean(snapshot["configured"]),
    running: Boolean(ctx.weixin_channel?._running),
    default_working_dir: ctx.db.get_setting("weixin_default_working_dir", "~"),
    base_url: ctx.db.get_setting(
      "weixin_base_url",
      "https://ilinkai.weixin.qq.com",
    ),
    account_id: runtimeAccount || configuredAccount,
    login_status: snapshot["login_status"] ?? "idle",
    qr_code_url: snapshot["qr_code_url"] ?? "",
    last_error: snapshot["last_error"] ?? "",
    user_id: snapshot["user_id"] ?? "",
  };
}

function channelsStatus(ctx: ApiContext): Row {
  const tgToken =
    ctx.db.get_setting("telegram_bot_token", "") ||
    process.env.TELEGRAM_BOT_TOKEN ||
    "";
  const slBot =
    ctx.db.get_setting("slack_bot_token", "") ||
    process.env.SLACK_BOT_TOKEN ||
    "";
  const slApp =
    ctx.db.get_setting("slack_app_token", "") ||
    process.env.SLACK_APP_TOKEN ||
    "";
  return {
    telegram: {
      enabled: ctx.db.get_setting("telegram_enabled", "false") === "true",
      configured: Boolean(tgToken),
      running: Boolean(ctx.telegram_channel?._running),
      default_working_dir: ctx.db.get_setting(
        "telegram_default_working_dir",
        "~",
      ),
      default_chat_id: ctx.db.get_setting("telegram_default_chat_id", ""),
      allowed_users: ctx.db.get_setting("telegram_allowed_users", ""),
    },
    slack: {
      enabled: ctx.db.get_setting("slack_enabled", "false") === "true",
      configured: Boolean(slBot && slApp),
      running: Boolean(ctx.slack_channel?._running),
      default_working_dir: ctx.db.get_setting("slack_default_working_dir", "~"),
      default_channel: ctx.db.get_setting("slack_default_channel", ""),
      default_user: ctx.db.get_setting("slack_default_user", ""),
    },
    weixin: weixinStatus(ctx),
    feishu: {
      configured: ctx.db.get_setting("feishu_enabled", "false") === "true",
      running: Boolean(ctx.feishu_channel?._running),
    },
  };
}

export async function restartChannels(
  ctx: ApiContext,
  body: Row,
): Promise<void> {
  if (ctx.telegram_channel) {
    ctx.telegram_channel.stop();
    ctx.telegram_channel = null;
  }
  const tgEnabled =
    (body["telegram_enabled"] ??
      ctx.db.get_setting("telegram_enabled", "false")) === "true";
  if (tgEnabled) {
    const token =
      ctx.db.get_setting("telegram_bot_token", "") ||
      process.env.TELEGRAM_BOT_TOKEN ||
      "";
    const allowed =
      ctx.db.get_setting("telegram_allowed_users", "") ||
      process.env.TELEGRAM_ALLOWED_USERS ||
      "";
    if (token) {
      ctx.telegram_channel = create_telegram_channel(
        ctx.db,
        ctx.scheduler,
        ctx.bus,
        token,
        allowed,
      );
      ctx.telegram_channel?.start();
    }
  }

  if (ctx.slack_channel) {
    ctx.slack_channel.stop();
    ctx.slack_channel = null;
  }
  const slEnabled =
    (body["slack_enabled"] ?? ctx.db.get_setting("slack_enabled", "false")) ===
    "true";
  if (slEnabled) {
    const botToken =
      ctx.db.get_setting("slack_bot_token", "") ||
      process.env.SLACK_BOT_TOKEN ||
      "";
    const appToken =
      ctx.db.get_setting("slack_app_token", "") ||
      process.env.SLACK_APP_TOKEN ||
      "";
    if (botToken && appToken) {
      ctx.slack_channel = new SlackChannel(
        ctx.bus,
        ctx.db,
        ctx.scheduler,
        botToken,
        appToken,
      );
      await ctx.slack_channel.start();
    }
  }

  if (ctx.weixin_channel) {
    ctx.weixin_channel.stop();
    ctx.weixin_channel = null;
  }
  const wxEnabled =
    (body["weixin_enabled"] ??
      ctx.db.get_setting("weixin_enabled", "false")) === "true";
  if (wxEnabled) {
    ctx.weixin_channel = new WeixinChannel(ctx.bus, ctx.db, ctx.scheduler);
    ctx.weixin_channel.start();
  }

  if (ctx.feishu_channel) {
    ctx.feishu_channel.stop();
    ctx.feishu_channel = null;
  }
  const fsEnabled =
    (body["feishu_enabled"] ??
      ctx.db.get_setting("feishu_enabled", "false")) === "true";
  if (fsEnabled) {
    ctx.feishu_channel = new FeishuChannel(ctx.bus, ctx.db, ctx.scheduler);
    ctx.feishu_channel.start();
  }
}

async function getChannelsStatus({
  ctx,
  origin,
}: RouteArgs): Promise<Response> {
  return jsonResponse(channelsStatus(ctx), 200, origin);
}

async function postWeixinAction({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  const action = asString(body["action"]).trim().toLowerCase();
  if (!ctx.weixin_channel)
    return jsonResponse({ error: "weixin channel not running" }, 400, origin);
  if (action === "login" || action === "reconnect") {
    ctx.weixin_channel.request_login();
    return jsonResponse({ status: "ok", action }, 200, origin);
  }
  if (action === "logout") {
    ctx.weixin_channel.request_logout();
    return jsonResponse({ status: "ok", action }, 200, origin);
  }
  return jsonResponse({ error: "unsupported action" }, 400, origin);
}

export const CHANNEL_ROUTES: Array<Route<RouteArgs>> = [
  {
    method: "GET",
    pattern: "/api/channels/status",
    handler: getChannelsStatus,
  },
  {
    method: "POST",
    pattern: "/api/channels/weixin/action",
    handler: postWeixinAction,
  },
];
