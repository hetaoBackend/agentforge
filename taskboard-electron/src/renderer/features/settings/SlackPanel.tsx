import { theme } from "../../theme/tokens.ts";

export function SlackPanel({
  channels,
  setChannels,
  collapsedChannels,
  setCollapsedChannels,
  fieldStyle,
  labelStyle,
  hintStyle,
}) {
  const ch = channels.slack;
  const collapsed = collapsedChannels.slack;
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
        onClick={() => setCollapsedChannels((c) => ({ ...c, slack: !c.slack }))}
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
              flexShrink: 0,
            }}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path fill="#36C5F0" d="M10.1 3.2A2.2 2.2 0 0 1 12.2 1h.7v5.1h-2.8V3.2Z" />
              <path fill="#2EB67D" d="M20.8 10.1A2.2 2.2 0 0 1 23 12.2v.7h-5.1v-2.8h2.9Z" />
              <path fill="#ECB22E" d="M13.9 20.8A2.2 2.2 0 0 1 11.8 23h-.7v-5.1h2.8v2.9Z" />
              <path fill="#E01E5A" d="M3.2 13.9A2.2 2.2 0 0 1 1 11.8v-.7h5.1v2.8H3.2Z" />
              <path fill="#36C5F0" d="M13.2 4.3a2.7 2.7 0 1 1 5.4 0 2.7 2.7 0 0 1-5.4 0Z" />
              <path fill="#2EB67D" d="M16.9 13.2a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4Z" />
              <path fill="#ECB22E" d="M5.4 16.9a2.7 2.7 0 1 1 5.4 0 2.7 2.7 0 0 1-5.4 0Z" />
              <path fill="#E01E5A" d="M4.3 5.4a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4Z" />
            </svg>
          </span>
          <span style={{ fontWeight: 700, fontSize: 14, color: theme.text }}>Slack</span>
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
              slack: { ...c.slack, enabled: !c.slack.enabled },
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
                  slack: { ...c.slack, bot_token: e.target.value },
                }))
              }
              placeholder={
                ch.configured && !ch.bot_token
                  ? "Token saved – enter new token to replace"
                  : "xoxb-..."
              }
              style={fieldStyle}
            />
            <div style={hintStyle}>
              {ch.configured && !ch.bot_token
                ? "Token is saved. Leave blank to keep the current token."
                : "Bot token from OAuth & Permissions"}
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>App Token</label>
            <input
              type="password"
              value={ch.app_token}
              onChange={(e) =>
                setChannels((c) => ({
                  ...c,
                  slack: { ...c.slack, app_token: e.target.value },
                }))
              }
              placeholder={
                ch.configured && !ch.app_token
                  ? "Token saved – enter new token to replace"
                  : "xapp-..."
              }
              style={fieldStyle}
            />
            <div style={hintStyle}>
              {ch.configured && !ch.app_token
                ? "Token is saved. Leave blank to keep the current token."
                : "App-level token for Socket Mode"}
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Default Working Directory</label>
            <input
              value={ch.default_working_dir}
              onChange={(e) =>
                setChannels((c) => ({
                  ...c,
                  slack: { ...c.slack, default_working_dir: e.target.value },
                }))
              }
              placeholder="~/my-project"
              style={fieldStyle}
            />
            <div style={hintStyle}>Working directory for tasks created via the Slack bot.</div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Default DM User</label>
            <input
              value={ch.default_user}
              onChange={(e) =>
                setChannels((c) => ({
                  ...c,
                  slack: { ...c.slack, default_user: e.target.value },
                }))
              }
              placeholder="U0123456789"
              style={fieldStyle}
            />
            <div style={hintStyle}>
              Slack user ID to DM when tasks have no origin thread (e.g. subtasks created via API).
              Find your ID in Slack profile → ⋯ → Copy member ID.
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Default Notification Channel</label>
            <input
              value={ch.default_channel}
              onChange={(e) =>
                setChannels((c) => ({
                  ...c,
                  slack: { ...c.slack, default_channel: e.target.value },
                }))
              }
              placeholder="#general or C0123456789"
              style={fieldStyle}
            />
            <div style={hintStyle}>Optional. Fallback channel if Default DM User is not set.</div>
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
            {["newtask <title> | <prompt>", "list", "status <id>", "cancel <id>", "help"].map(
              (cmd) => (
                <div key={cmd}>
                  <span style={{ color: theme.cyan }}>{cmd}</span>
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
