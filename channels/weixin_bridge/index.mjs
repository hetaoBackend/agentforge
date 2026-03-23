import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = process.env.AGENTFORGE_WEIXIN_BOT_TYPE || "3";
const DATA_DIR = process.env.AGENTFORGE_WEIXIN_DATA_DIR || path.join(process.env.HOME || ".", ".agentforge", "weixin");
const ACCOUNT_FILE = path.join(DATA_DIR, "account.json");
const AUTO_LOGIN = (process.env.AGENTFORGE_WEIXIN_AUTO_LOGIN || "true") !== "false";
const ACCOUNT_ID_OVERRIDE = process.env.AGENTFORGE_WEIXIN_ACCOUNT_ID || "";
const CHANNEL_VERSION = "agentforge-weixin-bridge/0.2.0";

let shuttingDown = false;
let loginInFlight = null;
let pollerStarted = false;
let pollTimer = null;
let state = loadState();
const pendingSentMessages = new Map();

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function log(message) {
  process.stderr.write(`[WeixinBridge] ${message}\n`);
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState() {
  try {
    if (!fs.existsSync(ACCOUNT_FILE)) {
      return {
        accountId: ACCOUNT_ID_OVERRIDE,
        baseUrl: process.env.AGENTFORGE_WEIXIN_BASE_URL || DEFAULT_BASE_URL,
        token: "",
        userId: "",
        syncCursor: "",
      };
    }
    const parsed = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8"));
    return {
      accountId: ACCOUNT_ID_OVERRIDE || parsed.accountId || "",
      baseUrl: parsed.baseUrl || process.env.AGENTFORGE_WEIXIN_BASE_URL || DEFAULT_BASE_URL,
      token: parsed.token || "",
      userId: parsed.userId || "",
      syncCursor: parsed.syncCursor || "",
    };
  } catch (error) {
    log(`failed to load state: ${String(error)}`);
    return {
      accountId: ACCOUNT_ID_OVERRIDE,
      baseUrl: process.env.AGENTFORGE_WEIXIN_BASE_URL || DEFAULT_BASE_URL,
      token: "",
      userId: "",
      syncCursor: "",
    };
  }
}

function saveState() {
  ensureDataDir();
  fs.writeFileSync(
    ACCOUNT_FILE,
    JSON.stringify(
      {
        accountId: state.accountId,
        baseUrl: state.baseUrl,
        token: state.token,
        userId: state.userId,
        syncCursor: state.syncCursor,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function clearSession() {
  state = {
    ...state,
    token: "",
    syncCursor: "",
  };
  saveState();
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function buildHeaders(body, token) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function postJson(endpoint, payload, token, timeoutMs = 15000) {
  const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(endpoint, ensureTrailingSlash(state.baseUrl)), {
      method: "POST",
      headers: buildHeaders(body, token),
      body,
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${raw}`);
    }
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchQrCode() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, ensureTrailingSlash(state.baseUrl));
    const response = await fetch(url, { signal: controller.signal });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${raw}`);
    }
    return JSON.parse(raw);
  } finally {
    clearTimeout(timeout);
  }
}

async function pollQrStatus(qrcode) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  try {
    const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, ensureTrailingSlash(state.baseUrl));
    const response = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${raw}`);
    }
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractText(itemList = []) {
  const parts = [];
  for (const item of itemList) {
    if (item?.type === 1 && item.text_item?.text) {
      parts.push(String(item.text_item.text));
    } else if (item?.type === 3 && item.voice_item?.text) {
      parts.push(String(item.voice_item.text));
    }
  }
  return parts.join("\n").trim();
}

function extractReplyToMessageId(itemList = []) {
  for (const item of itemList) {
    const refMessageId = item?.ref_msg?.message_item?.msg_id;
    if (refMessageId) {
      return String(refMessageId);
    }
  }
  return "";
}

function extractReplyReference(itemList = []) {
  for (const item of itemList) {
    const ref = item?.ref_msg;
    if (!ref) {
      continue;
    }
    return {
      messageId: ref?.message_item?.msg_id ? String(ref.message_item.msg_id) : "",
      title: ref?.title ? String(ref.title) : "",
      text: ref?.message_item ? extractText([ref.message_item]) : "",
    };
  }
  return { messageId: "", title: "", text: "" };
}

function extractQuotedMessageId(msg) {
  for (const item of msg?.item_list || []) {
    if (item?.msg_id) {
      return String(item.msg_id);
    }
  }
  if (msg?.message_id != null) {
    return String(msg.message_id);
  }
  return "";
}

function maybeEmitSentConfirmation(msg) {
  const clientId = String(msg?.client_id || "");
  if (!clientId) {
    return;
  }
  const pending = pendingSentMessages.get(clientId);
  if (!pending) {
    return;
  }
  const quotedMessageId = extractQuotedMessageId(msg);
  if (!quotedMessageId) {
    return;
  }
  pendingSentMessages.delete(clientId);
  emit({
    type: "sent",
    request_id: pending.requestId,
    message_id: clientId,
    quoted_message_id: quotedMessageId,
    peer_id: pending.peerId,
  });
}

function normalizeInboundMessage(msg) {
  if (msg?.message_type !== 1) {
    return null;
  }
  const peerId = msg.from_user_id || "";
  const text = extractText(msg.item_list || []);
  if (!peerId || !text) {
    return null;
  }
  const replyRef = extractReplyReference(msg.item_list || []);
  return {
    type: "message",
    account_id: state.accountId || ACCOUNT_ID_OVERRIDE || "",
    peer_id: peerId,
    context_token: msg.context_token || "",
    message_id: String(msg.message_id || msg.client_id || crypto.randomUUID()),
    reply_to_message_id: replyRef.messageId,
    reply_to_message_title: replyRef.title,
    reply_to_message_text: replyRef.text,
    text,
    raw_message_type: msg.message_type || 0,
  };
}

async function sendTextMessage(command) {
  if (!state.token) {
    throw new Error("weixin account is not logged in");
  }
  const messageId = crypto.randomUUID();
  await postJson(
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: command.peer_id,
        client_id: messageId,
        message_type: 2,
        message_state: 2,
        item_list: [
          {
            type: 1,
            text_item: { text: command.text || "" },
          },
        ],
        context_token: command.context_token || undefined,
      },
    },
    state.token,
    15000,
  );
  pendingSentMessages.set(messageId, {
    requestId: command.request_id || "",
    peerId: command.peer_id || "",
  });
  emit({
    type: "accepted",
    request_id: command.request_id || "",
    client_id: messageId,
    peer_id: command.peer_id,
  });
}

async function pollUpdatesOnce() {
  if (!state.token || shuttingDown) {
    return;
  }

  const response = await postJson(
    "ilink/bot/getupdates",
    {
      get_updates_buf: state.syncCursor || "",
    },
    state.token,
    40000,
  );

  if (response?.errcode === -14) {
    emit({ type: "error", message: "session_expired" });
    clearSession();
    pollerStarted = false;
    if (AUTO_LOGIN) {
      await ensureLogin();
    }
    return;
  }

  if (typeof response?.get_updates_buf === "string") {
    state.syncCursor = response.get_updates_buf;
    saveState();
  }

  for (const msg of response?.msgs || []) {
    maybeEmitSentConfirmation(msg);
    const normalized = normalizeInboundMessage(msg);
    if (normalized) {
      emit(normalized);
    }
  }
}

async function pollLoop() {
  if (pollerStarted) {
    return;
  }
  pollerStarted = true;
  emit({ type: "ready", account_id: state.accountId || "" });
  while (!shuttingDown && state.token) {
    try {
      await pollUpdatesOnce();
    } catch (error) {
      emit({ type: "error", message: String(error) });
      await new Promise((resolve) => {
        pollTimer = setTimeout(resolve, 2000);
      });
    }
  }
  pollerStarted = false;
}

async function startPollingIfReady() {
  if (state.token && !pollerStarted) {
    void pollLoop();
  }
}

async function loginFlow() {
  try {
    const qr = await fetchQrCode();
    if (!qr?.qrcode || !qr?.qrcode_img_content) {
      throw new Error("QR code response missing qrcode image content");
    }
    log(
      `qr payload received: len=${String(qr.qrcode_img_content).length} prefix=${String(qr.qrcode_img_content).slice(0, 80)}`,
    );

    emit({
      type: "qr",
      qrcode_url: qr.qrcode_img_content,
      account_id: state.accountId || ACCOUNT_ID_OVERRIDE || "",
    });

    while (!shuttingDown) {
      const status = await pollQrStatus(qr.qrcode);
      if (status?.status === "confirmed" && status?.bot_token) {
        state = {
          ...state,
          accountId: ACCOUNT_ID_OVERRIDE || status.ilink_bot_id || state.accountId,
          baseUrl: status.baseurl || state.baseUrl,
          token: status.bot_token,
          userId: status.ilink_user_id || state.userId,
          syncCursor: "",
        };
        saveState();
        emit({
          type: "login_success",
          account_id: state.accountId,
          user_id: state.userId,
        });
        await startPollingIfReady();
        return;
      }
      if (status?.status === "expired") {
        throw new Error("QR code expired, restart login");
      }
      if (status?.status === "scaned") {
        emit({ type: "scaned" });
      }
    }
  } catch (error) {
    emit({ type: "error", message: `login_failed: ${String(error)}` });
    throw error;
  } finally {
    loginInFlight = null;
  }
}

async function ensureLogin() {
  if (loginInFlight) {
    return loginInFlight;
  }
  loginInFlight = loginFlow().catch(() => undefined);
  return loginInFlight;
}

async function handleCommand(command) {
  if (!command?.type) {
    return;
  }

  if (command.type === "send_message") {
    await sendTextMessage(command);
    return;
  }

  if (command.type === "login") {
    clearSession();
    await ensureLogin();
    return;
  }

  if (command.type === "logout") {
    clearSession();
    emit({ type: "logged_out" });
  }
}

ensureDataDir();

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    emit({ type: "error", message: "invalid_json" });
    return;
  }
  void handleCommand(command).catch((error) => {
    emit({
      type: "error",
      request_id: command?.request_id || "",
      message: String(error),
    });
  });
});

process.on("SIGINT", () => {
  shuttingDown = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  process.exit(0);
});

if (state.token) {
  void startPollingIfReady();
} else if (AUTO_LOGIN) {
  void ensureLogin();
}
