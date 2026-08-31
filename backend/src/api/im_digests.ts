/**
 * Routes for IM digest preview and delivery.
 */

import { InboundMessageType, makeInboundMessage } from "../bus.ts";
import {
  type IMDigestRecipient,
  parse_im_digest_recipients,
} from "../digests.ts";

import {
  type ApiContext,
  asBool,
  asString,
  jsonResponse,
  type RouteArgs,
  type Row,
} from "./shared.ts";
import type { Route } from "./router.ts";

function digestPayload(body: Row): Row {
  return {
    include_empty: asBool(body["include_empty"] ?? false),
    limit:
      body["limit"] === undefined || body["limit"] === null
        ? undefined
        : Number(body["limit"]),
    since:
      body["since"] === undefined || body["since"] === null
        ? null
        : asString(body["since"]),
  };
}

function triggerDigest(ctx: ApiContext, body: Row): Row {
  return ctx.scheduler.handle_inbound_message(
    makeInboundMessage({
      type: InboundMessageType.TRIGGER_DIGEST,
      source: "api",
      payload: digestPayload(body),
    }),
  );
}

function digestRecipients(ctx: ApiContext, body: Row): IMDigestRecipient[] {
  if ("recipients" in body) {
    return parse_im_digest_recipients(body["recipients"]);
  }
  return parse_im_digest_recipients(
    ctx.db.get_setting("im_digest_channels", "[]"),
  );
}

export async function sendIMDigest(
  ctx: ApiContext,
  recipient: IMDigestRecipient,
  text: string,
): Promise<void> {
  if (recipient.channel === "slack") {
    const channel = ctx.slack_channel as any;
    if (!channel?._reply) throw new Error("slack channel is not running");
    await channel._reply(recipient.target, null, text);
    return;
  }
  if (recipient.channel === "feishu") {
    const channel = ctx.feishu_channel as any;
    if (!channel?._send_message)
      throw new Error("feishu channel is not running");
    await channel._send_message(recipient.target, text);
    return;
  }
  if (recipient.channel === "telegram") {
    const channel = ctx.telegram_channel as any;
    if (!channel?._api) throw new Error("telegram channel is not running");
    await channel._api("sendMessage", {
      chat_id: recipient.target,
      text,
    });
    return;
  }
  if (recipient.channel === "weixin") {
    const channel = ctx.weixin_channel as any;
    if (!channel?._reply_to_event)
      throw new Error("weixin channel is not running");
    channel._reply_to_event({ peer_id: recipient.target }, text);
    return;
  }
  throw new Error(`unsupported digest channel: ${recipient.channel}`);
}

async function postIMDigestPreview({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  return jsonResponse(triggerDigest(ctx, body), 200, origin);
}

async function postIMDigestSend({
  ctx,
  origin,
  body,
}: RouteArgs): Promise<Response> {
  const recipients = digestRecipients(ctx, body);
  if (!recipients.length) {
    return jsonResponse(
      { error: "no digest recipients configured" },
      409,
      origin,
    );
  }
  const result = triggerDigest(ctx, body);
  if (result["status"] === "quiet") {
    return jsonResponse(result, 200, origin);
  }
  const text = asString(result["text"]);
  try {
    for (const recipient of recipients) {
      await sendIMDigest(ctx, recipient, text);
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
      sent: recipients.length,
      digest: result["digest"],
    },
    200,
    origin,
  );
}

export const IM_DIGEST_ROUTES: Array<Route<RouteArgs>> = [
  {
    method: "POST",
    pattern: "/api/im-digests/preview",
    handler: postIMDigestPreview,
  },
  {
    method: "POST",
    pattern: "/api/im-digests/send",
    handler: postIMDigestSend,
  },
];
