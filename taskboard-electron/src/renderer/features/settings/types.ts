/** Prop types shared by the settings modal shell and its tab/channel panels. */

import type { CSSProperties } from "react";

/** The three style objects the modal builds once and hands to every panel. */
export interface PanelStyles {
  fieldStyle: CSSProperties;
  labelStyle: CSSProperties;
  hintStyle: CSSProperties;
}

/** Inline save feedback rendered under a tab's Save button. */
export interface SaveMessage {
  ok: boolean;
  text: string;
}

/** Feishu credentials, stored as the flat snake_case shape the REST API uses. */
export interface FeishuSettings {
  feishu_app_id: string;
  feishu_app_secret: string;
  feishu_default_chat_id: string;
  feishu_default_working_dir: string;
  feishu_enabled: string;
}

/** Which channel cards are folded shut. */
export interface CollapsedChannels {
  telegram: boolean;
  slack: boolean;
  weixin: boolean;
}
