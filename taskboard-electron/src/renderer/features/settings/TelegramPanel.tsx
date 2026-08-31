import { theme } from "../../theme/tokens.ts";

export function TelegramPanel({
  channels,
  setChannels,
  collapsedChannels,
  setCollapsedChannels,
  fieldStyle,
  labelStyle,
  hintStyle,
}) {
  const ch = channels.telegram;
  const collapsed = collapsedChannels.telegram;
  const statusDot = ch.running
    ? { bg: theme.green, label: "Connected" }
    : ch.configured
      ? { bg: theme.yellow || "#f59e0b", label: "Configured (not running)" }
      : { bg: theme.textDim, label: "Not configured" };
  return (
    <div
      style={{
        marginBottom: 16,
        borderRadius: 10,
        border: `1px solid ${theme.border}`,
        background: theme.bg,
        overflow: "hidden",
      }}
    >
      {/* Header row - clickable to collapse */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setCollapsedChannels((c) => ({ ...c, telegram: !c.telegram }))}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: 10,
              color: theme.textMuted,
              transition: "transform 0.2s",
              transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
              display: "inline-block",
            }}
          >
            {"▼"}
          </span>
          <span
            style={{
              display: "inline-flex",
              width: 22,
              height: 22,
              alignItems: "center",
              justifyContent: "center",
              color: "#2AABEE",
              flexShrink: 0,
            }}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
              <path d="M21.4 4.6a1.2 1.2 0 0 0-1.24-.2L3.8 11.15c-.6.25-.57 1.12.05 1.33l4.6 1.62 1.62 4.6c.22.62 1.08.65 1.33.05l6.75-16.36a1.2 1.2 0 0 0-.2-1.24 1.18 1.18 0 0 0-1.22-.3Z" />
            </svg>
          </span>
          <span style={{ fontWeight: 700, fontSize: 14, color: theme.text }}>Telegram</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: statusDot.bg,
                display: "inline-block",
                boxShadow: ch.running ? `0 0 6px ${statusDot.bg}` : "none",
              }}
            />
            <span style={{ fontSize: 11, color: theme.textMuted }}>{statusDot.label}</span>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setChannels((c) => ({
              ...c,
              telegram: { ...c.telegram, enabled: !c.telegram.enabled },
            }));
          }}
          style={{
            width: 44,
            height: 24,
            borderRadius: 12,
            border: "none",
            cursor: "pointer",
            background: ch.enabled ? theme.accent : theme.border,
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
              left: ch.enabled ? 23 : 3,
            }}
          />
        </button>
      </div>

      {/* Collapsible body */}
      {!collapsed && (
        <div style={{ padding: "0 16px 16px" }}>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Bot Token</label>
            <input
              type="password"
              value={ch.bot_token}
              onChange={(e) =>
                setChannels((c) => ({
                  ...c,
                  telegram: { ...c.telegram, bot_token: e.target.value },
                }))
              }
              placeholder={
                ch.configured && !ch.bot_token
                  ? "Token saved – enter new token to replace"
                  : "123456:ABC-DEF..."
              }
              style={fieldStyle}
            />
            <div style={hintStyle}>
              {ch.configured && !ch.bot_token
                ? "Token is saved. Leave blank to keep the current token."
                : "Token from @BotFather"}
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Allowed User IDs</label>
            <input
              value={ch.allowed_users}
              onChange={(e) =>
                setChannels((c) => ({
                  ...c,
                  telegram: { ...c.telegram, allowed_users: e.target.value },
                }))
              }
              placeholder="123456789,987654321 (optional)"
              style={fieldStyle}
            />
            <div style={hintStyle}>
              Comma-separated numeric Telegram user IDs. Leave empty to allow all.
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Default Working Directory</label>
            <input
              value={ch.default_working_dir}
              onChange={(e) =>
                setChannels((c) => ({
                  ...c,
                  telegram: { ...c.telegram, default_working_dir: e.target.value },
                }))
              }
              placeholder="~/my-project"
              style={fieldStyle}
            />
            <div style={hintStyle}>Working directory for tasks created via the Telegram bot.</div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Default Notification Chat ID</label>
            <input
              value={ch.default_chat_id}
              onChange={(e) =>
                setChannels((c) => ({
                  ...c,
                  telegram: { ...c.telegram, default_chat_id: e.target.value },
                }))
              }
              placeholder="-1001234567890 or 123456789"
              style={fieldStyle}
            />
            <div style={hintStyle}>
              Fallback chat for notifications from UI-created tasks (group or user chat ID).
            </div>
          </div>

          <div
            style={{
              background: theme.surface,
              border: `1px solid ${theme.border}`,
              borderRadius: 6,
              padding: "10px 12px",
              fontSize: 11,
              fontFamily: "monospace",
              color: theme.textMuted,
              lineHeight: 1.8,
            }}
          >
            <div style={{ color: theme.textDim, marginBottom: 4 }}>Bot commands:</div>
            {["/newtask <title> | <prompt>", "/list", "/status <id>", "/cancel <id>"].map((cmd) => (
              <div key={cmd}>
                <span style={{ color: theme.cyan }}>{cmd}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
