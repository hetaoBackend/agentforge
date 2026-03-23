import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChannelsSavePayload,
  createInitialChannelsState,
  mergeChannelsStatus,
  isWeixinQrImageSource,
} from "./channelsSettings.mjs";

test("createInitialChannelsState includes weixin defaults", () => {
  const state = createInitialChannelsState();

  assert.deepEqual(state.weixin, {
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

  assert.equal(merged.weixin.enabled, true);
  assert.equal(merged.weixin.running, true);
  assert.equal(merged.weixin.default_working_dir, "/tmp/repo");
  assert.equal(merged.weixin.base_url, "https://example.test");
  assert.equal(merged.weixin.account_id, "wx-demo");
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
    },
  });

  assert.equal(payload.weixin_enabled, "true");
  assert.equal(payload.weixin_default_working_dir, "~/workspace/agentforge");
  assert.equal(payload.weixin_base_url, "https://ilinkai.weixin.qq.com");
  assert.equal(payload.weixin_account_id, "wx-primary");
});

test("isWeixinQrImageSource recognizes real image sources only", () => {
  assert.equal(
    isWeixinQrImageSource("data:image/png;base64,abc"),
    true,
  );
  assert.equal(
    isWeixinQrImageSource("https://example.test/qr.png"),
    true,
  );
  assert.equal(
    isWeixinQrImageSource("https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=7a9bf9b71b5bc24cac576b5098adb5b4&b"),
    false,
  );
  assert.equal(
    isWeixinQrImageSource("otpauth://totp/example"),
    false,
  );
  assert.equal(
    isWeixinQrImageSource("wxp://some-qr-payload"),
    false,
  );
});
