import { theme } from "../../theme/tokens.ts";

export function WeixinPanel({
  channels,
  setChannels,
  collapsedChannels,
  setCollapsedChannels,
  weixinQrSrc,
  weixinActionBusy,
  onWeixinAction,
  fieldStyle,
  labelStyle,
  hintStyle,
}) {
  const ch = channels.weixin;
  const collapsed = collapsedChannels.weixin;
  const statusLabelMap = {
    idle: "Idle",
    waiting_for_scan: "Waiting for scan",
    scanned: "Scanned on phone",
    connected: "Connected",
    error: "Error",
  };
  const statusDot = ch.running
    ? { bg: theme.green, label: statusLabelMap[ch.login_status] || "Connected" }
    : ch.login_status === "waiting_for_scan" || ch.login_status === "scanned"
      ? { bg: theme.orange || "#f59e0b", label: statusLabelMap[ch.login_status] }
      : ch.login_status === "error"
        ? { bg: theme.red, label: "Error" }
        : ch.configured
          ? { bg: theme.yellow || "#f59e0b", label: "Configured" }
          : { bg: theme.textDim, label: "Login required" };
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setCollapsedChannels((c) => ({ ...c, weixin: !c.weixin }))}
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
              color: "#07C160",
              flexShrink: 0,
            }}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
              <path d="M9.2 4.2c-4 0-7.2 2.6-7.2 5.9 0 1.9 1.1 3.6 2.9 4.7l-.9 2.5 2.9-1.5c.7.1 1.4.2 2.2.2 4 0 7.2-2.6 7.2-5.9S13.2 4.2 9.2 4.2Zm-2.7 4.8a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Zm5.4 0a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z" />
              <path
                d="M16.8 9.1c-3 0-5.5 2-5.5 4.5 0 2.5 2.4 4.5 5.5 4.5.6 0 1.2-.1 1.8-.2l2.4 1.2-.7-2c1.5-.8 2.5-2.1 2.5-3.6 0-2.5-2.4-4.4-5.5-4.4Zm-1.9 4a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4Zm3.8 0a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4Z"
                opacity="0.88"
              />
            </svg>
          </span>
          <span style={{ fontWeight: 700, fontSize: 14, color: theme.text }}>Wechat</span>
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
              weixin: { ...c.weixin, enabled: !c.weixin.enabled },
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

      {!collapsed && (
        <div style={{ padding: "0 16px 16px" }}>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Default Working Directory</label>
            <input
              value={ch.default_working_dir}
              onChange={(e) =>
                setChannels((c) => ({
                  ...c,
                  weixin: { ...c.weixin, default_working_dir: e.target.value },
                }))
              }
              placeholder="~/my-project"
              style={fieldStyle}
            />
            <div style={hintStyle}>
              Working directory for tasks created from incoming Weixin messages.
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Base URL</label>
            <input
              value={ch.base_url}
              onChange={(e) =>
                setChannels((c) => ({
                  ...c,
                  weixin: { ...c.weixin, base_url: e.target.value },
                }))
              }
              placeholder="https://ilinkai.weixin.qq.com"
              style={fieldStyle}
            />
            <div style={hintStyle}>
              Gateway API base URL used for QR login, long-polling, and sendmessage.
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Account ID</label>
            <input
              value={ch.account_id}
              onChange={(e) =>
                setChannels((c) => ({
                  ...c,
                  weixin: { ...c.weixin, account_id: e.target.value },
                }))
              }
              placeholder="Optional fixed account id"
              style={fieldStyle}
            />
            <div style={hintStyle}>
              Optional. Leave empty to let the bridge adopt the account id returned by QR login.
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button
              onClick={() => onWeixinAction("reconnect")}
              disabled={weixinActionBusy}
              style={{
                padding: "9px 14px",
                borderRadius: 8,
                border: `1px solid ${theme.border}`,
                background: theme.surface,
                color: theme.text,
                cursor: weixinActionBusy ? "not-allowed" : "pointer",
                fontSize: 12,
                fontWeight: 600,
                opacity: weixinActionBusy ? 0.6 : 1,
              }}
            >
              Reconnect
            </button>
            <button
              onClick={() => onWeixinAction("logout")}
              disabled={weixinActionBusy}
              style={{
                padding: "9px 14px",
                borderRadius: 8,
                border: `1px solid ${theme.red}`,
                background: theme.redBg,
                color: theme.red,
                cursor: weixinActionBusy ? "not-allowed" : "pointer",
                fontSize: 12,
                fontWeight: 600,
                opacity: weixinActionBusy ? 0.6 : 1,
              }}
            >
              Logout
            </button>
          </div>

          {(ch.qr_code_url ||
            ch.login_status === "waiting_for_scan" ||
            ch.login_status === "scanned" ||
            ch.last_error) && (
            <div
              style={{
                marginBottom: 12,
                borderRadius: 8,
                border: `1px solid ${theme.border}`,
                background: theme.surface,
                padding: 12,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: theme.text,
                  marginBottom: 8,
                }}
              >
                Weixin Login Status
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: theme.textMuted,
                  marginBottom: ch.qr_code_url ? 10 : 0,
                }}
              >
                {statusLabelMap[ch.login_status] || "Idle"}
                {ch.user_id ? ` · ${ch.user_id}` : ""}
              </div>
              {ch.account_id && (
                <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 10 }}>
                  Account ID: {ch.account_id}
                </div>
              )}
              {weixinQrSrc && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <img
                    src={weixinQrSrc}
                    alt="Weixin QR code"
                    style={{
                      width: 220,
                      height: 220,
                      objectFit: "contain",
                      borderRadius: 10,
                      border: `1px solid ${theme.border}`,
                      background: "#fff",
                    }}
                  />
                  <div style={hintStyle}>
                    Open Weixin on your phone and scan this QR code. The status updates
                    automatically.
                  </div>
                </div>
              )}
              {ch.last_error && (
                <div style={{ marginTop: 10, fontSize: 11, color: theme.red }}>{ch.last_error}</div>
              )}
            </div>
          )}

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
            <div style={{ color: theme.textDim, marginBottom: 4 }}>Notes:</div>
            {[
              "Enabling Weixin starts the local bridge process",
              "First launch without a saved session will trigger QR login",
              "Reply to a result message to resume the same task session",
            ].map((note) => (
              <div key={note}>
                <span style={{ color: theme.cyan }}>{note}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
