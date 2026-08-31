/**
 * HTTP plumbing shared by every route module: CORS, CSRF, body reading
 and the payload coercions the handlers validate arguments with.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";

import { CronExpressionParser } from "cron-parser";

import { MessageBus } from "../bus.ts";
import { FeishuChannel } from "../channels/feishu.ts";
import { SlackChannel } from "../channels/slack.ts";
import type { TelegramChannel } from "../channels/telegram.ts";
import { WeixinChannel } from "../channels/weixin.ts";
import type { TaskDB } from "../db.ts";
import type { TaskScheduler } from "../scheduler.ts";
import { dateToLocalIso } from "../util.ts";

export type Row = Record<string, any>;

export interface ApiContext {
  db: TaskDB;
  scheduler: TaskScheduler;
  bus: MessageBus;
  telegram_channel: TelegramChannel | null;
  slack_channel: SlackChannel | null;
  weixin_channel: WeixinChannel | null;
  feishu_channel: FeishuChannel | null;
}

export const CSRF_TOKEN = crypto.randomBytes(32).toString("hex");

const MAX_BODY_SIZE = 10 * 1024 * 1024;

export function isAllowedOrigin(origin: string): boolean {
  if (origin === "null") return true;
  if (!origin) return true;
  if (origin.startsWith("views://")) return true;
  return (
    origin === "http://localhost" || origin.startsWith("http://localhost:")
  );
}

export function corsHeaders(origin: string): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token",
  });
  if (isAllowedOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

export function jsonResponse(
  data: unknown,
  status = 200,
  origin = "",
): Response {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { status, headers });
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function checkCsrf(req: Request): boolean {
  const origin = req.headers.get("Origin") ?? "";
  if (!origin) return true;
  return timingSafeEqual(req.headers.get("X-CSRF-Token") ?? "", CSRF_TOKEN);
}

export async function readJsonBody(
  req: Request,
  origin: string,
): Promise<Row | Response> {
  const rawLength = req.headers.get("Content-Length") ?? "0";
  const length = Number.parseInt(rawLength, 10) || 0;
  if (length > MAX_BODY_SIZE) {
    void req.body?.cancel();
    return jsonResponse({ error: "request body too large" }, 413, origin);
  }
  const raw = await req.text();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Row;
    }
    return {};
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, origin);
  }
}

export function idAt(path: string, index = 3): number | null {
  const raw = path.split("/")[index];
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

export function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return Boolean(value);
}

export function asString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function parseJsonList(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function asStringList(value: unknown): string[] {
  return parseJsonList(value)
    .map((item) => String(item).trim())
    .filter(Boolean);
}

export function parseJsonObject(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Row;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Row;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export function cronValid(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

export function cronNextIso(expr: string): string {
  return dateToLocalIso(CronExpressionParser.parse(expr).next().toDate());
}

export function ensureWorkingDir(
  workingDir: string,
  missingMessage: string,
): Row | null {
  if (workingDir && workingDir !== ".") {
    const expanded =
      workingDir === "~"
        ? os.homedir()
        : workingDir.replace(/^~\//, `${os.homedir()}/`);
    if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) {
      return { error: missingMessage, field: "working_dir" };
    }
  }
  return null;
}

export type ResponseData = [unknown, number?];

/** Everything a route handler may read; the router fills it in per request. */
export interface RouteArgs {
  ctx: ApiContext;
  url: URL;
  path: string;
  origin: string;
  /** Parsed JSON body for POST/PUT/PATCH; always `{}` for GET and DELETE. */
  body: Row;
}
