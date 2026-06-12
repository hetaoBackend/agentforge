// AgentForge Weixin bridge — TypeScript port of channels/weixin_bridge/index.mjs.
//
// Plain sidecar process (run with `bun index.ts`) that speaks the WeChat ilink
// protocol and communicates with the backend channel over stdio NDJSON.
// Runtime behavior, protocol strings, and NDJSON message shapes are kept
// byte-identical to the original Node ESM source; only types were added.
// Stdlib-only (node:crypto/fs/path/readline + global fetch) — no npm deps.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const INITIAL_BASE_URL =
  process.env.AGENTFORGE_WEIXIN_BASE_URL || DEFAULT_BASE_URL;
const BOT_TYPE = process.env.AGENTFORGE_WEIXIN_BOT_TYPE || "3";
const DATA_DIR =
  process.env.AGENTFORGE_WEIXIN_DATA_DIR ||
  path.join(process.env.HOME || ".", ".agentforge", "weixin");
const ACCOUNT_FILE = path.join(DATA_DIR, "account.json");
const AUTO_LOGIN =
  (process.env.AGENTFORGE_WEIXIN_AUTO_LOGIN || "true") !== "false";
const ACCOUNT_ID_OVERRIDE = process.env.AGENTFORGE_WEIXIN_ACCOUNT_ID || "";
const CHANNEL_VERSION = "agentforge-weixin-bridge/0.2.0";
const DEFAULT_CDN_BASE_URL = process.env.AGENTFORGE_WEIXIN_CDN_BASE_URL || "";
const MESSAGE_TYPE = {
  USER: 1,
  BOT: 2,
};
const MESSAGE_STATE = {
  FINISH: 2,
};
const MESSAGE_ITEM_TYPE = {
  TEXT: 1,
  IMAGE: 2,
};
const UPLOAD_MEDIA_TYPE = {
  IMAGE: 1,
};
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

interface BridgeState {
  accountId: string;
  baseUrl: string;
  token: string;
  userId: string;
  syncCursor: string;
}

/** Inbound NDJSON command from the channel process. */
interface BridgeCommand {
  type?: string;
  request_id?: string;
  account_id?: string;
  peer_id?: string;
  context_token?: string;
  reply_to_message_id?: string;
  text?: string;
  image_paths?: unknown;
}

interface UploadedImage {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string; // hex string
  fileSize: number;
  fileSizeCiphertext: number;
}

let shuttingDown = false;
let loginInFlight: Promise<unknown> | null = null;
let pollerStarted = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let state: BridgeState = loadState();
const pendingSentMessages = new Map<
  string,
  { requestId: string; peerId: string }
>();

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function log(message: string): void {
  process.stderr.write(`[WeixinBridge] ${message}\n`);
}

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureMediaDir(kind: string): string {
  const dir = path.join(DATA_DIR, "media", kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mediaFileName(prefix: string, ext: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${stamp}-${crypto.randomBytes(6).toString("hex")}${ext}`;
}

function imageExtFromBuffer(buf: Buffer, fallback = ".jpg"): string {
  if (
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return ".png";
  }
  if (buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return ".jpg";
  }
  if (
    buf.subarray(0, 6).toString("ascii") === "GIF87a" ||
    buf.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    return ".gif";
  }
  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  return fallback;
}

function getImageMimeFromFilename(filePath: string): string {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "image/jpeg";
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (
    decoded.length === 32 &&
    /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))
  ) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(
    `${label}: aes_key must decode to 16 raw bytes or a 32-char hex string`,
  );
}

function resolveCdnBaseUrl(): string {
  return (
    DEFAULT_CDN_BASE_URL ||
    state?.baseUrl ||
    process.env.AGENTFORGE_WEIXIN_BASE_URL ||
    DEFAULT_BASE_URL
  );
}

function buildCdnDownloadUrl(
  encryptedQueryParam: string,
  cdnBaseUrl: string = resolveCdnBaseUrl(),
): string {
  return `${cdnBaseUrl.replace(/\/$/, "")}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function buildCdnUploadUrl(
  uploadParam: string,
  filekey: string,
  cdnBaseUrl: string = resolveCdnBaseUrl(),
): string {
  return `${cdnBaseUrl.replace(/\/$/, "")}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function fetchCdnBytes(url: string, label: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `${label}: CDN download ${response.status} ${response.statusText}: ${body}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function downloadAndDecryptBuffer(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  label: string,
  fullUrl?: string,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64, label);
  const url = fullUrl || buildCdnDownloadUrl(encryptedQueryParam);
  const encrypted = await fetchCdnBytes(url, label);
  return decryptAesEcb(encrypted, key);
}

async function downloadPlainCdnBuffer(
  encryptedQueryParam: string,
  label: string,
  fullUrl?: string,
): Promise<Buffer> {
  const url = fullUrl || buildCdnDownloadUrl(encryptedQueryParam);
  return fetchCdnBytes(url, label);
}

function loadState(): BridgeState {
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
    const parsed = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8")) as Record<
      string,
      string | undefined
    >;
    return {
      accountId: ACCOUNT_ID_OVERRIDE || parsed.accountId || "",
      baseUrl:
        parsed.baseUrl ||
        process.env.AGENTFORGE_WEIXIN_BASE_URL ||
        DEFAULT_BASE_URL,
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

function saveState(): void {
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

function clearSession(): void {
  state = {
    ...state,
    token: "",
    syncCursor: "",
    baseUrl: INITIAL_BASE_URL,
  };
  saveState();
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function buildHeaders(body: string, token: string): Record<string, string> {
  const headers: Record<string, string> = {
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

async function postJson(
  endpoint: string,
  payload: Record<string, unknown>,
  token: string,
  timeoutMs = 15000,
): Promise<any> {
  const body = JSON.stringify({
    ...payload,
    base_info: { channel_version: CHANNEL_VERSION },
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      new URL(endpoint, ensureTrailingSlash(state.baseUrl)),
      {
        method: "POST",
        headers: buildHeaders(body, token),
        body,
        signal: controller.signal,
      },
    );
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${raw}`);
    }
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function getUploadUrl(params: {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  aeskey: string;
}): Promise<any> {
  return postJson(
    "ilink/bot/getuploadurl",
    {
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      no_need_thumb: true,
      aeskey: params.aeskey,
    },
    state.token,
    15000,
  );
}

async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  aeskey: Buffer;
  label: string;
}): Promise<{ downloadParam: string }> {
  const ciphertext = encryptAesEcb(params.buf, params.aeskey);
  const uploadUrl =
    params.uploadFullUrl?.trim() ||
    (params.uploadParam
      ? buildCdnUploadUrl(params.uploadParam, params.filekey)
      : "");
  if (!uploadUrl) {
    throw new Error(`${params.label}: CDN upload URL missing`);
  }

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (response.status >= 400 && response.status < 500) {
        const body =
          response.headers.get("x-error-message") || (await response.text());
        throw new Error(
          `${params.label}: CDN upload client error ${response.status}: ${body}`,
        );
      }
      if (response.status !== 200) {
        const body =
          response.headers.get("x-error-message") ||
          `status ${response.status}`;
        throw new Error(`${params.label}: CDN upload server error: ${body}`);
      }
      const downloadParam = response.headers.get("x-encrypted-param") || "";
      if (!downloadParam) {
        throw new Error(
          `${params.label}: CDN response missing x-encrypted-param`,
        );
      }
      return { downloadParam };
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.includes("client error")) {
        throw error;
      }
      if (attempt < 3) {
        log(
          `${params.label}: CDN upload attempt ${attempt} failed: ${String(error)}`,
        );
      }
    }
  }
  throw lastError || new Error(`${params.label}: CDN upload failed`);
}

async function uploadImageToWeixin(
  filePath: string,
  toUserId: string,
): Promise<UploadedImage> {
  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const uploadUrlResp = await getUploadUrl({
    filekey,
    media_type: UPLOAD_MEDIA_TYPE.IMAGE,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString("hex"),
  });
  const uploaded = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadUrlResp.upload_full_url,
    uploadParam: uploadUrlResp.upload_param,
    filekey,
    aeskey,
    label: `uploadImageToWeixin:${path.basename(filePath)}`,
  });
  return {
    filekey,
    downloadEncryptedQueryParam: uploaded.downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

function buildImageItem(uploaded: UploadedImage): Record<string, unknown> {
  return {
    type: MESSAGE_ITEM_TYPE.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };
}

async function fetchQrCode(): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const url = new URL(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
      ensureTrailingSlash(INITIAL_BASE_URL),
    );
    log(`fetchQrCode: GET ${url}`);
    const response = await fetch(url, { signal: controller.signal });
    log(`fetchQrCode: status=${response.status} ok=${response.ok}`);
    const raw = await response.text();
    if (!response.ok) {
      log(`fetchQrCode: error body=${raw.slice(0, 200)}`);
      throw new Error(`${response.status} ${response.statusText}: ${raw}`);
    }
    const data = JSON.parse(raw);
    log(
      `fetchQrCode: qrcode=${data?.qrcode || "MISSING"} img_len=${String(data?.qrcode_img_content || "").length}`,
    );
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function pollQrStatus(
  qrcode: string,
  baseUrl: string = INITIAL_BASE_URL,
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  try {
    const url = new URL(
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      ensureTrailingSlash(baseUrl),
    );
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

function extractText(itemList: any[] = []): string {
  const parts: string[] = [];
  for (const item of itemList) {
    if (item?.type === MESSAGE_ITEM_TYPE.TEXT && item.text_item?.text) {
      parts.push(String(item.text_item.text));
    } else if (item?.type === 3 && item.voice_item?.text) {
      parts.push(String(item.voice_item.text));
    }
  }
  return parts.join("\n").trim();
}

function extractReplyToMessageId(itemList: any[] = []): string {
  for (const item of itemList) {
    const refMessageId = item?.ref_msg?.message_item?.msg_id;
    if (refMessageId) {
      return String(refMessageId);
    }
  }
  return "";
}

function extractReplyReference(itemList: any[] = []): {
  messageId: string;
  title: string;
  text: string;
} {
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

async function downloadInboundImage(
  item: any,
): Promise<{ path: string; media_type: string; size: number } | null> {
  const imageItem = item?.image_item;
  const media = imageItem?.media;
  if (!media?.encrypt_query_param && !media?.full_url) {
    return null;
  }
  const aesKeyBase64 = imageItem.aeskey
    ? Buffer.from(imageItem.aeskey, "hex").toString("base64")
    : media.aes_key;
  const label = "inbound image";
  const buf = aesKeyBase64
    ? await downloadAndDecryptBuffer(
        media.encrypt_query_param || "",
        aesKeyBase64,
        label,
        media.full_url,
      )
    : await downloadPlainCdnBuffer(
        media.encrypt_query_param || "",
        label,
        media.full_url,
      );
  const ext = imageExtFromBuffer(buf);
  const filePath = path.join(
    ensureMediaDir("inbound"),
    mediaFileName("weixin-inbound", ext),
  );
  fs.writeFileSync(filePath, buf);
  return {
    path: filePath,
    media_type: IMAGE_MIME_BY_EXT[ext] || getImageMimeFromFilename(filePath),
    size: buf.length,
  };
}

async function extractInboundImages(itemList: any[] = []): Promise<{
  images: Array<{ path: string; media_type: string; size: number }>;
  errors: string[];
}> {
  const images: Array<{ path: string; media_type: string; size: number }> = [];
  const errors: string[] = [];
  for (const item of itemList) {
    if (item?.type !== MESSAGE_ITEM_TYPE.IMAGE) {
      continue;
    }
    try {
      const image = await downloadInboundImage(item);
      if (image) {
        images.push(image);
      }
    } catch (error) {
      const message = String(error);
      errors.push(message);
      log(`inbound image download failed: ${message}`);
    }
  }
  return { images, errors };
}

function extractQuotedMessageId(msg: any): string {
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

function maybeEmitSentConfirmation(msg: any): void {
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

async function normalizeInboundMessage(
  msg: any,
): Promise<Record<string, unknown> | null> {
  if (msg?.message_type !== MESSAGE_TYPE.USER) {
    return null;
  }
  const peerId = msg.from_user_id || "";
  const text = extractText(msg.item_list || []);
  const { images, errors } = await extractInboundImages(msg.item_list || []);
  if (!peerId || (!text && !images.length)) {
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
    image_paths: images.map((image) => image.path),
    images,
    image_errors: errors,
    raw_message_type: msg.message_type || 0,
  };
}

async function sendMessageItem(
  command: BridgeCommand,
  item: Record<string, unknown>,
): Promise<string> {
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
        message_type: MESSAGE_TYPE.BOT,
        message_state: MESSAGE_STATE.FINISH,
        item_list: [item],
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
  return messageId;
}

async function sendTextMessage(command: BridgeCommand): Promise<string> {
  return sendMessageItem(command, {
    type: MESSAGE_ITEM_TYPE.TEXT,
    text_item: { text: command.text || "" },
  });
}

async function sendMessageWithImages(command: BridgeCommand): Promise<void> {
  const imagePaths = Array.isArray(command.image_paths)
    ? command.image_paths.filter(
        (imagePath): imagePath is string =>
          typeof imagePath === "string" && Boolean(imagePath),
      )
    : [];
  if (!imagePaths.length) {
    await sendTextMessage(command);
    return;
  }

  if ((command.text || "").trim()) {
    await sendTextMessage(command);
  }
  for (const imagePath of imagePaths) {
    const uploaded = await uploadImageToWeixin(imagePath, command.peer_id || "");
    await sendMessageItem(command, buildImageItem(uploaded));
  }
}

async function pollUpdatesOnce(): Promise<void> {
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
    const normalized = await normalizeInboundMessage(msg);
    if (normalized) {
      emit(normalized);
    }
  }
}

async function pollLoop(): Promise<void> {
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
      await new Promise<void>((resolve) => {
        pollTimer = setTimeout(resolve, 2000);
      });
    }
  }
  pollerStarted = false;
}

async function startPollingIfReady(): Promise<void> {
  if (state.token && !pollerStarted) {
    void pollLoop();
  }
}

async function loginFlow(): Promise<void> {
  const MAX_QR_RETRIES = 3;
  log(
    `loginFlow: start INITIAL_BASE_URL=${INITIAL_BASE_URL} state.baseUrl=${state.baseUrl}`,
  );
  try {
    for (let attempt = 0; attempt < MAX_QR_RETRIES; attempt++) {
      log(`loginFlow: fetchQrCode attempt ${attempt + 1}/${MAX_QR_RETRIES}`);
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

      let currentPollBaseUrl = INITIAL_BASE_URL;
      let expired = false;

      while (!shuttingDown) {
        const status = await pollQrStatus(qr.qrcode, currentPollBaseUrl);
        if (status?.status === "confirmed" && status?.bot_token) {
          state = {
            ...state,
            accountId:
              ACCOUNT_ID_OVERRIDE || status.ilink_bot_id || state.accountId,
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
        if (status?.status === "scaned_but_redirect") {
          const redirect = String(status.redirect_host || "").trim();
          if (redirect) {
            currentPollBaseUrl = redirect.startsWith("http")
              ? redirect
              : `https://${redirect}`;
          }
          continue;
        }
        if (status?.status === "expired") {
          expired = true;
          break;
        }
        if (status?.status === "scaned") {
          emit({ type: "scaned" });
        }
      }

      if (!expired) return;
      if (attempt + 1 < MAX_QR_RETRIES) {
        log(
          `QR code expired, retrying (attempt ${attempt + 2}/${MAX_QR_RETRIES})`,
        );
      }
    }
    throw new Error("QR code expired");
  } catch (error) {
    emit({ type: "error", message: `login_failed: ${String(error)}` });
    throw error;
  } finally {
    loginInFlight = null;
  }
}

async function ensureLogin(): Promise<unknown> {
  if (loginInFlight) {
    log("ensureLogin: login already in flight, reusing");
    return loginInFlight;
  }
  log("ensureLogin: starting new loginFlow");
  loginInFlight = loginFlow().catch(() => undefined);
  return loginInFlight;
}

async function handleCommand(command: BridgeCommand): Promise<void> {
  if (!command?.type) {
    return;
  }

  if (command.type === "send_message") {
    await sendMessageWithImages(command);
    return;
  }

  if (command.type === "login") {
    log(
      `handleCommand: login — token=${state.token ? "present" : "absent"} baseUrl=${state.baseUrl} loginInFlight=${loginInFlight != null}`,
    );
    clearSession();
    log(
      `handleCommand: login — session cleared, INITIAL_BASE_URL=${INITIAL_BASE_URL}`,
    );
    await ensureLogin();
    return;
  }

  if (command.type === "logout") {
    log(
      `handleCommand: logout — token=${state.token ? "present" : "absent"} baseUrl=${state.baseUrl} loginInFlight=${loginInFlight != null}`,
    );
    loginInFlight = null;
    clearSession();
    log(
      `handleCommand: logout — session cleared, INITIAL_BASE_URL=${INITIAL_BASE_URL}`,
    );
    emit({ type: "logged_out" });
    await ensureLogin();
  }
}

ensureDataDir();

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line: string) => {
  if (!line.trim()) {
    return;
  }
  let command: BridgeCommand;
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

// `extractReplyToMessageId` was unused in the original index.mjs as well;
// kept (and referenced here) so the port stays 1:1 without tripping
// noUnusedLocals-style lint rules.
void extractReplyToMessageId;
