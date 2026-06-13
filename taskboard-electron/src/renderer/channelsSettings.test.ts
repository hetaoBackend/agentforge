import { test, expect } from "bun:test";

import {
  buildChannelsSavePayload,
  createInitialChannelsState,
  mergeChannelsStatus,
  isWeixinQrImageSource,
  type WeixinChannelState,
} from "./channelsSettings.ts";

test("createInitialChannelsState includes weixin defaults", () => {
  const state = createInitialChannelsState();

  expect(state.weixin).toEqual({
    enabled: false,
    configured: false,
    running: false,
    default_working_dir: "~",
    base_url: "https://ilinkai.weixin.qq.com",
    account_id: "",
    login_status: "idle",
    qr_code_url: "",
    last_error: "",
    user_id: "",
  });
});

test("mergeChannelsStatus overlays weixin status onto existing state", () => {
  const merged = mergeChannelsStatus(createInitialChannelsState(), {
    weixin: {
      enabled: true,
      configured: true,
      running: true,
      default_working_dir: "/tmp/repo",
      base_url: "https://example.test",
      account_id: "wx-demo",
    },
  });

  expect(merged.weixin.enabled).toBe(true);
  expect(merged.weixin.running).toBe(true);
  expect(merged.weixin.default_working_dir).toBe("/tmp/repo");
  expect(merged.weixin.base_url).toBe("https://example.test");
  expect(merged.weixin.account_id).toBe("wx-demo");
});

test("mergeChannelsStatus keeps telegram edits when preserving editable fields", () => {
  const current = createInitialChannelsState({
    telegram: {
      enabled: true,
      bot_token: "123456:edited",
      allowed_users: "42,99",
      default_working_dir: "~/workspace/edited",
      default_chat_id: "-100edited",
      running: false,
      configured: false,
    },
  });

  const merged = mergeChannelsStatus(
    current,
    {
      telegram: {
        enabled: false,
        allowed_users: "",
        default_working_dir: "~",
        default_chat_id: "",
        running: true,
        configured: true,
      },
    },
    { preserveEditableFields: true },
  );

  expect(merged.telegram).toEqual({
    enabled: true,
    bot_token: "123456:edited",
    allowed_users: "42,99",
    default_working_dir: "~/workspace/edited",
    default_chat_id: "-100edited",
    running: true,
    configured: true,
  });
});

test("buildChannelsSavePayload serializes weixin settings for the API", () => {
  const payload = buildChannelsSavePayload({
    ...createInitialChannelsState(),
    weixin: {
      enabled: true,
      configured: true,
      running: false,
      default_working_dir: "~/workspace/agentforge",
      base_url: "https://ilinkai.weixin.qq.com",
      account_id: "wx-primary",
    } as WeixinChannelState,
  });

  expect(payload.weixin_enabled).toBe("true");
  expect(payload.weixin_default_working_dir).toBe("~/workspace/agentforge");
  expect(payload.weixin_base_url).toBe("https://ilinkai.weixin.qq.com");
  expect(payload.weixin_account_id).toBe("wx-primary");
});

test("buildChannelsSavePayload omits blank channel secrets", () => {
  const payload = buildChannelsSavePayload({
    ...createInitialChannelsState(),
    telegram: {
      ...createInitialChannelsState().telegram,
      enabled: true,
      bot_token: "",
      allowed_users: "42",
      default_working_dir: "~/workspace/agentforge",
      default_chat_id: "-100123",
    },
    slack: {
      ...createInitialChannelsState().slack,
      enabled: true,
      bot_token: "",
      app_token: "",
      default_channel: "C123",
    },
  });

  expect("telegram_bot_token" in payload).toBe(false);
  expect("slack_bot_token" in payload).toBe(false);
  expect("slack_app_token" in payload).toBe(false);
  expect(payload.telegram_allowed_users).toBe("42");
  expect(payload.telegram_default_chat_id).toBe("-100123");
  expect(payload.slack_default_channel).toBe("C123");
});

test("isWeixinQrImageSource recognizes real image sources only", () => {
  expect(isWeixinQrImageSource("data:image/png;base64,abc")).toBe(true);
  expect(isWeixinQrImageSource("https://example.test/qr.png")).toBe(true);
  expect(
    isWeixinQrImageSource(
      "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=7a9bf9b71b5bc24cac576b5098adb5b4&b",
    ),
  ).toBe(false);
  expect(isWeixinQrImageSource("otpauth://totp/example")).toBe(false);
  expect(isWeixinQrImageSource("wxp://some-qr-payload")).toBe(false);
});
