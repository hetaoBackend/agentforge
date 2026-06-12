const DEFAULT_CHANNELS_STATE = {
  telegram: {
    enabled: false,
    configured: false,
    running: false,
    default_working_dir: "~",
    default_chat_id: "",
    bot_token: "",
    allowed_users: "",
  },
  slack: {
    enabled: false,
    configured: false,
    running: false,
    default_working_dir: "~",
    default_channel: "",
    default_user: "",
    bot_token: "",
    app_token: "",
  },
  weixin: {
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
  },
};

function cloneState(state) {
  return {
    telegram: { ...state.telegram },
    slack: { ...state.slack },
    weixin: { ...state.weixin },
  };
}

export function createInitialChannelsState(initial = {}) {
  const base = cloneState(DEFAULT_CHANNELS_STATE);
  return mergeChannelsStatus(base, initial);
}

export function mergeChannelsStatus(current, status = {}) {
  return {
    telegram: { ...current.telegram, ...(status.telegram || {}) },
    slack: { ...current.slack, ...(status.slack || {}) },
    weixin: { ...current.weixin, ...(status.weixin || {}) },
  };
}

export function buildChannelsSavePayload(channels) {
  return {
    telegram_enabled: channels.telegram.enabled ? "true" : "false",
    telegram_bot_token: channels.telegram.bot_token,
    telegram_allowed_users: channels.telegram.allowed_users,
    telegram_default_working_dir: channels.telegram.default_working_dir,
    telegram_default_chat_id: channels.telegram.default_chat_id,
    slack_enabled: channels.slack.enabled ? "true" : "false",
    slack_bot_token: channels.slack.bot_token,
    slack_app_token: channels.slack.app_token,
    slack_default_working_dir: channels.slack.default_working_dir,
    slack_default_channel: channels.slack.default_channel,
    slack_default_user: channels.slack.default_user,
    weixin_enabled: channels.weixin.enabled ? "true" : "false",
    weixin_default_working_dir: channels.weixin.default_working_dir,
    weixin_base_url: channels.weixin.base_url,
    weixin_account_id: channels.weixin.account_id,
  };
}

export function isWeixinQrImageSource(value) {
  const normalized = (value || "").trim();
  if (!normalized) return false;
  if (normalized.startsWith("data:image/")) return true;
  if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|#|$)/i.test(normalized)) return true;
  return false;
}
