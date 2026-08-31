import { TelegramPanel } from "./TelegramPanel.tsx";
import { SlackPanel } from "./SlackPanel.tsx";
import { WeixinPanel } from "./WeixinPanel.tsx";
import { theme } from "../../theme/tokens.ts";

export function ChannelsTab({
  onClose,
  channels,
  setChannels,
  channelsSaving,
  channelsMsg,
  weixinQrSrc,
  weixinActionBusy,
  collapsedChannels,
  setCollapsedChannels,
  onWeixinAction,
  onSave,
  fieldStyle,
  labelStyle,
  hintStyle,
}) {
  return (
    <>
      {/* ── Telegram ── */}
      <TelegramPanel
        channels={channels}
        setChannels={setChannels}
        collapsedChannels={collapsedChannels}
        setCollapsedChannels={setCollapsedChannels}
        fieldStyle={fieldStyle}
        labelStyle={labelStyle}
        hintStyle={hintStyle}
      />

      {/* ── Slack ── */}
      <SlackPanel
        channels={channels}
        setChannels={setChannels}
        collapsedChannels={collapsedChannels}
        setCollapsedChannels={setCollapsedChannels}
        fieldStyle={fieldStyle}
        labelStyle={labelStyle}
        hintStyle={hintStyle}
      />

      {/* ── Weixin ── */}
      <WeixinPanel
        channels={channels}
        setChannels={setChannels}
        collapsedChannels={collapsedChannels}
        setCollapsedChannels={setCollapsedChannels}
        weixinQrSrc={weixinQrSrc}
        weixinActionBusy={weixinActionBusy}
        onWeixinAction={onWeixinAction}
        fieldStyle={fieldStyle}
        labelStyle={labelStyle}
        hintStyle={hintStyle}
      />

      {channelsMsg && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 12,
            background: channelsMsg.ok ? theme.greenBg : theme.redBg,
            color: channelsMsg.ok ? theme.green : theme.red,
            border: `1px solid ${channelsMsg.ok ? theme.green : theme.red}`,
          }}
        >
          {channelsMsg.text}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button
          onClick={onClose}
          style={{
            padding: "10px 20px",
            borderRadius: 8,
            border: `1px solid ${theme.border}`,
            background: "transparent",
            color: theme.textMuted,
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Close
        </button>
        <button
          onClick={onSave}
          disabled={channelsSaving}
          style={{
            padding: "10px 24px",
            borderRadius: 8,
            border: "none",
            background: channelsSaving ? theme.border : theme.accent,
            color: channelsSaving ? theme.textMuted : "#fff",
            cursor: channelsSaving ? "not-allowed" : "pointer",
            fontSize: 13,
            fontWeight: 600,
            boxShadow: channelsSaving ? "none" : `0 0 20px ${theme.accentGlow}`,
          }}
        >
          {channelsSaving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}
