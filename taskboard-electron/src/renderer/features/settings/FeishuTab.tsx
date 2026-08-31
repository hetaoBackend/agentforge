import { theme } from "../../theme/tokens.ts";

export function FeishuTab({
  onClose,
  feishu,
  setFeishu,
  feishuSaving,
  feishuMsg,
  onSave,
  fieldStyle,
  labelStyle,
  hintStyle,
}) {
  return (
    <>
      {/* Enable toggle */}
      <div
        style={{
          marginBottom: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>Enable Feishu Bot</div>
          <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>
            WebSocket long-connection, no public IP required
          </div>
        </div>
        <button
          onClick={() =>
            setFeishu((f) => ({
              ...f,
              feishu_enabled: f.feishu_enabled === "true" ? "false" : "true",
            }))
          }
          style={{
            width: 44,
            height: 24,
            borderRadius: 12,
            border: "none",
            cursor: "pointer",
            background: feishu.feishu_enabled === "true" ? theme.accent : theme.border,
            position: "relative",
            transition: "background 0.2s",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 3,
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: "#fff",
              transition: "left 0.2s",
              left: feishu.feishu_enabled === "true" ? 23 : 3,
            }}
          />
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 20 }}>
        <div>
          <label style={labelStyle}>App ID</label>
          <input
            value={feishu.feishu_app_id}
            onChange={(e) => setFeishu((f) => ({ ...f, feishu_app_id: e.target.value }))}
            placeholder="cli_xxxxxxxxxxxxxxxx"
            style={fieldStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>App Secret</label>
          <input
            type="password"
            value={feishu.feishu_app_secret}
            onChange={(e) => setFeishu((f) => ({ ...f, feishu_app_secret: e.target.value }))}
            placeholder="••••••••••••••••"
            style={fieldStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>Default Chat ID</label>
          <input
            value={feishu.feishu_default_chat_id}
            onChange={(e) => setFeishu((f) => ({ ...f, feishu_default_chat_id: e.target.value }))}
            placeholder="oc_xxxxxxxx (group) or ou_xxxxxxxx (DM)"
            style={fieldStyle}
          />
          <div style={hintStyle}>Task completion notifications will be sent here.</div>
        </div>
        <div>
          <label style={labelStyle}>Default Working Directory</label>
          <input
            value={feishu.feishu_default_working_dir}
            onChange={(e) =>
              setFeishu((f) => ({ ...f, feishu_default_working_dir: e.target.value }))
            }
            placeholder="~/my-project"
            style={fieldStyle}
          />
          <div style={hintStyle}>Working directory for tasks created via the bot.</div>
        </div>
      </div>

      {/* Bot commands cheatsheet */}
      <div
        style={{
          background: theme.bg,
          border: `1px solid ${theme.border}`,
          borderRadius: 8,
          padding: "12px 14px",
          marginBottom: 20,
          fontSize: 11,
          fontFamily: "monospace",
          color: theme.textMuted,
          lineHeight: 1.8,
        }}
      >
        <div style={{ color: theme.textDim, marginBottom: 6, fontFamily: "inherit" }}>
          Bot commands:
        </div>
        <div>
          <span style={{ color: theme.cyan }}>&lt;any text&gt;</span> — create a new task
        </div>
        <div>
          <span style={{ color: theme.cyan }}>/resume &lt;id&gt; &lt;msg&gt;</span> — resume a task
          session
        </div>
        <div>
          <span style={{ color: theme.cyan }}>/status &lt;id&gt;</span> — query task status
        </div>
      </div>

      {feishuMsg && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 12,
            background: feishuMsg.ok ? theme.greenBg : theme.redBg,
            color: feishuMsg.ok ? theme.green : theme.red,
            border: `1px solid ${feishuMsg.ok ? theme.green : theme.red}`,
          }}
        >
          {feishuMsg.text}
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
          disabled={feishuSaving}
          style={{
            padding: "10px 24px",
            borderRadius: 8,
            border: "none",
            background: feishuSaving ? theme.border : theme.accent,
            color: feishuSaving ? theme.textMuted : "#fff",
            cursor: feishuSaving ? "not-allowed" : "pointer",
            fontSize: 13,
            fontWeight: 600,
            boxShadow: feishuSaving ? "none" : `0 0 20px ${theme.accentGlow}`,
          }}
        >
          {feishuSaving ? "Saving…" : "Save & Apply"}
        </button>
      </div>
    </>
  );
}
