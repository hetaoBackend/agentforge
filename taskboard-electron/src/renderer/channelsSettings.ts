export interface TelegramChannelState {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  default_working_dir: string;
  default_chat_id: string;
  bot_token: string;
  allowed_users: string;
}

export interface SlackChannelState {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  default_working_dir: string;
  default_channel: string;
  default_user: string;
  bot_token: string;
  app_token: string;
}

export interface WeixinChannelState {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  default_working_dir: string;
  base_url: string;
  account_id: string;
  login_status: string;
  qr_code_url: string;
  last_error: string;
  user_id: string;
}

export interface ChannelsState {
  telegram: TelegramChannelState;
  slack: SlackChannelState;
  weixin: WeixinChannelState;
}

export interface ChannelsStatusUpdate {
  telegram?: Partial<TelegramChannelState>;
  slack?: Partial<SlackChannelState>;
  weixin?: Partial<WeixinChannelState>;
}

export interface ChannelsSavePayload {
  telegram_enabled: string;
  telegram_bot_token?: string;
  telegram_allowed_users: string;
  telegram_default_working_dir: string;
  telegram_default_chat_id: string;
  slack_enabled: string;
  slack_bot_token?: string;
  slack_app_token?: string;
  slack_default_working_dir: string;
  slack_default_channel: string;
  slack_default_user: string;
  weixin_enabled: string;
  weixin_default_working_dir: string;
  weixin_base_url: string;
  weixin_account_id: string;
}

interface MergeChannelsStatusOptions {
  preserveEditableFields?: boolean;
}

const DEFAULT_CHANNELS_STATE: ChannelsState = {
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

function cloneState(state: ChannelsState): ChannelsState {
  return {
    telegram: { ...state.telegram },
    slack: { ...state.slack },
    weixin: { ...state.weixin },
  };
}

export function createInitialChannelsState(initial: ChannelsStatusUpdate = {}): ChannelsState {
  const base = cloneState(DEFAULT_CHANNELS_STATE);
  return mergeChannelsStatus(base, initial);
}

export function mergeChannelsStatus(
  current: ChannelsState,
  status: ChannelsStatusUpdate = {},
  options: MergeChannelsStatusOptions = {},
): ChannelsState {
  const merged = {
    telegram: { ...current.telegram, ...(status.telegram || {}) },
    slack: { ...current.slack, ...(status.slack || {}) },
    weixin: { ...current.weixin, ...(status.weixin || {}) },
  };
  if (!options.preserveEditableFields) return merged;

  return {
    telegram: {
      ...merged.telegram,
      enabled: current.telegram.enabled,
      bot_token: current.telegram.bot_token,
      allowed_users: current.telegram.allowed_users,
      default_working_dir: current.telegram.default_working_dir,
      default_chat_id: current.telegram.default_chat_id,
    },
    slack: {
      ...merged.slack,
      enabled: current.slack.enabled,
      bot_token: current.slack.bot_token,
      app_token: current.slack.app_token,
      default_working_dir: current.slack.default_working_dir,
      default_channel: current.slack.default_channel,
      default_user: current.slack.default_user,
    },
    weixin: {
      ...merged.weixin,
      enabled: current.weixin.enabled,
      default_working_dir: current.weixin.default_working_dir,
      base_url: current.weixin.base_url,
      account_id: current.weixin.account_id,
    },
  };
}

export function buildChannelsSavePayload(channels: ChannelsState): ChannelsSavePayload {
  const payload: ChannelsSavePayload = {
    telegram_enabled: channels.telegram.enabled ? "true" : "false",
    telegram_allowed_users: channels.telegram.allowed_users,
    telegram_default_working_dir: channels.telegram.default_working_dir,
    telegram_default_chat_id: channels.telegram.default_chat_id,
    slack_enabled: channels.slack.enabled ? "true" : "false",
    slack_default_working_dir: channels.slack.default_working_dir,
    slack_default_channel: channels.slack.default_channel,
    slack_default_user: channels.slack.default_user,
    weixin_enabled: channels.weixin.enabled ? "true" : "false",
    weixin_default_working_dir: channels.weixin.default_working_dir,
    weixin_base_url: channels.weixin.base_url,
    weixin_account_id: channels.weixin.account_id,
  };
  if (channels.telegram.bot_token.trim()) {
    payload.telegram_bot_token = channels.telegram.bot_token;
  }
  if (channels.slack.bot_token.trim()) {
    payload.slack_bot_token = channels.slack.bot_token;
  }
  if (channels.slack.app_token.trim()) {
    payload.slack_app_token = channels.slack.app_token;
  }
  return payload;
}

export function isWeixinQrImageSource(value: string | null | undefined): boolean {
  const normalized = (value || "").trim();
  if (!normalized) return false;
  if (normalized.startsWith("data:image/")) return true;
  if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|#|$)/i.test(normalized)) return true;
  return false;
}
