import { useEffect, useRef, useState } from "react";
import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { formatTaskDateTime } from "../../dateTime.ts";
import { ActionBtn, AgentBadge, Tag } from "../../components/common.tsx";
import { DISPLAY_FONT_STACK, theme } from "../../theme/tokens.ts";
import { fetchHeartbeatTickOutput } from "../../api/client.ts";

function HeartbeatBadge({ enabled }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 10px",
        borderRadius: 20,
        fontSize: 11,
        fontWeight: 600,
        color: enabled ? theme.green : theme.textMuted,
        background: enabled ? theme.greenBg : "rgba(107,107,138,0.08)",
        letterSpacing: 0.3,
      }}
    >
      <span style={{ fontSize: 10 }}>{enabled ? "●" : "◌"}</span>
      {enabled ? "Enabled" : "Paused"}
    </span>
  );
}

export function HeartbeatCard({ heartbeat, onAction, onViewDetail }) {
  const tags = [];
  if (heartbeat.schedule_type === "interval" && heartbeat.interval_seconds)
    tags.push(`every ${heartbeat.interval_seconds}s`);
  if (heartbeat.schedule_type === "cron" && heartbeat.cron_expr)
    tags.push(`cron ${heartbeat.cron_expr}`);
  if (heartbeat.last_decision) tags.push(`Last: ${heartbeat.last_decision}`);

  return (
    <div
      onClick={() => onViewDetail(heartbeat)}
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 8,
        padding: "14px 15px",
        cursor: "pointer",
        transition: "border-color 0.16s ease, background 0.16s ease",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 680,
              color: theme.text,
              fontFamily: DISPLAY_FONT_STACK,
              marginBottom: 6,
            }}
          >
            {heartbeat.name}
          </div>
          <div
            style={{
              fontSize: 12,
              color: theme.textMuted,
              lineHeight: 1.5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {heartbeat.check_prompt}
          </div>
        </div>
        <HeartbeatBadge enabled={heartbeat.enabled} />
      </div>

      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
      >
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <AgentBadge agent={heartbeat.default_agent} />
          {tags.map((tag, idx) => (
            <Tag key={idx}>{tag}</Tag>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <ActionBtn
            icon={Play}
            title="Run now"
            onClick={() => onAction("run", heartbeat.id)}
            color={theme.orange}
          />
          <ActionBtn
            icon={Pencil}
            title="Edit"
            onClick={() => onAction("edit", heartbeat.id)}
            color={theme.blue}
          />
          {heartbeat.enabled ? (
            <ActionBtn
              icon={Pause}
              title="Pause"
              onClick={() => onAction("pause", heartbeat.id)}
              color={theme.textMuted}
            />
          ) : (
            <ActionBtn
              icon={Play}
              title="Resume"
              onClick={() => onAction("resume", heartbeat.id)}
              color={theme.green}
            />
          )}
          <ActionBtn
            icon={Trash2}
            title="Delete"
            onClick={() => onAction("delete", heartbeat.id)}
            color={theme.red}
          />
        </div>
      </div>

      <div
        style={{
          fontSize: 11,
          color: theme.textDim,
          marginTop: 10,
          fontFamily: "monospace",
          lineHeight: 1.6,
        }}
      >
        Next: {heartbeat.next_run_at ? formatTaskDateTime(heartbeat.next_run_at) : "n/a"}
        {" · "}
        Triggered:{" "}
        {heartbeat.last_triggered_at ? formatTaskDateTime(heartbeat.last_triggered_at) : "never"}
      </div>
      {heartbeat.last_error && (
        <div style={{ fontSize: 11, color: theme.red, marginTop: 6, lineHeight: 1.4 }}>
          Last error: {heartbeat.last_error}
        </div>
      )}
    </div>
  );
}

export function HeartbeatDetailPanel({ heartbeat, ticks, onClose }) {
  const [selectedTickId, setSelectedTickId] = useState<any>(null);
  const [tickOutput, setTickOutput] = useState("");
  const [tickRunning, setTickRunning] = useState(false);
  const outputRef = useRef<any>(null);

  useEffect(() => {
    setSelectedTickId(ticks[0]?.id || null);
  }, [heartbeat.id, ticks]);

  useEffect(() => {
    if (!selectedTickId) {
      setTickOutput("");
      setTickRunning(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchHeartbeatTickOutput(heartbeat.id, selectedTickId);
        if (cancelled) return;
        setTickOutput(data.output || "");
        setTickRunning(!!data.is_running);
      } catch {
        if (!cancelled) {
          setTickOutput("");
          setTickRunning(false);
        }
      }
    };
    load();
    const interval = setInterval(load, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [heartbeat.id, selectedTickId]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [tickOutput]);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        width: 520,
        height: "100vh",
        background: theme.surface,
        borderLeft: `1px solid ${theme.border}`,
        boxShadow: "-20px 0 60px rgba(0,0,0,0.4)",
        zIndex: 500,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "22px 24px",
          borderBottom: `1px solid ${theme.border}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 720,
              color: theme.text,
              fontFamily: DISPLAY_FONT_STACK,
            }}
          >
            {heartbeat.name}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>
            {heartbeat.working_dir}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: theme.textMuted,
            cursor: "pointer",
            fontSize: 22,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ padding: 24, overflow: "auto", flex: 1 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <HeartbeatBadge enabled={heartbeat.enabled} />
          <AgentBadge agent={heartbeat.default_agent} />
          {heartbeat.schedule_type === "interval" ? (
            <Tag>every {heartbeat.interval_seconds}s</Tag>
          ) : (
            <Tag>cron {heartbeat.cron_expr}</Tag>
          )}
          {heartbeat.last_decision && <Tag>{heartbeat.last_decision}</Tag>}
        </div>
        <div style={{ fontSize: 12, color: theme.textMuted, lineHeight: 1.7, marginBottom: 18 }}>
          <div>
            Next run: {heartbeat.next_run_at ? formatTaskDateTime(heartbeat.next_run_at) : "n/a"}
          </div>
          <div>
            Last tick:{" "}
            {heartbeat.last_tick_at ? formatTaskDateTime(heartbeat.last_tick_at) : "never"}
          </div>
          <div>
            Last trigger:{" "}
            {heartbeat.last_triggered_at
              ? formatTaskDateTime(heartbeat.last_triggered_at)
              : "never"}
          </div>
          <div>Cooldown: {heartbeat.cooldown_seconds || 0}s</div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: theme.textMuted,
              letterSpacing: 0.8,
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Decision Prompt
          </div>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.7,
              color: theme.text,
              background: theme.bg,
              border: `1px solid ${theme.border}`,
              borderRadius: 10,
              padding: 14,
              whiteSpace: "pre-wrap",
            }}
          >
            {heartbeat.check_prompt}
          </div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: theme.textMuted,
              letterSpacing: 0.8,
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Triggered Task Template
          </div>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.7,
              color: theme.text,
              background: theme.bg,
              border: `1px solid ${theme.border}`,
              borderRadius: 10,
              padding: 14,
              whiteSpace: "pre-wrap",
            }}
          >
            {heartbeat.action_prompt_template || "No template configured"}
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: theme.textMuted,
              letterSpacing: 0.8,
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Recent Ticks
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ticks.map((tick) => {
              let payload = null;
              try {
                payload = tick.decision_payload ? JSON.parse(tick.decision_payload) : null;
              } catch {}
              return (
                <div
                  key={tick.id}
                  style={{
                    background: theme.bg,
                    border: `1px solid ${theme.border}`,
                    borderRadius: 10,
                    padding: 12,
                    cursor: "pointer",
                    boxShadow:
                      selectedTickId === tick.id ? `0 0 0 1px ${theme.accent} inset` : "none",
                  }}
                >
                  <div
                    onClick={() => setSelectedTickId(tick.id)}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                      marginBottom: 6,
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, color: theme.text }}>
                      {tick.decision_type || tick.status}
                    </div>
                    <div style={{ fontSize: 11, color: theme.textDim, fontFamily: "monospace" }}>
                      {tick.started_at ? formatTaskDateTime(tick.started_at) : ""}
                    </div>
                  </div>
                  {payload?.reason && (
                    <div style={{ fontSize: 12, color: theme.textMuted, lineHeight: 1.5 }}>
                      {payload.reason}
                    </div>
                  )}
                  {tick.error && (
                    <div style={{ fontSize: 12, color: theme.red, lineHeight: 1.5 }}>
                      {tick.error}
                    </div>
                  )}
                  {tick.task_id && (
                    <div
                      style={{
                        fontSize: 11,
                        color: theme.accent,
                        marginTop: 6,
                        fontFamily: "monospace",
                      }}
                    >
                      Triggered task #{tick.task_id}
                    </div>
                  )}
                </div>
              );
            })}
            {ticks.length === 0 && (
              <div
                style={{
                  border: `1px dashed ${theme.border}`,
                  borderRadius: 10,
                  padding: 24,
                  textAlign: "center",
                  color: theme.textDim,
                  fontSize: 12,
                }}
              >
                No ticks yet
              </div>
            )}
          </div>
        </div>
        <div style={{ marginTop: 20 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: theme.textMuted,
                letterSpacing: 0.8,
                textTransform: "uppercase",
              }}
            >
              Tick Log
            </div>
            {selectedTickId && (
              <div
                style={{
                  fontSize: 11,
                  color: tickRunning ? theme.orange : theme.textDim,
                  fontFamily: "monospace",
                }}
              >
                {tickRunning ? "LIVE" : "Stored"} · tick #{selectedTickId}
              </div>
            )}
          </div>
          <div
            ref={outputRef}
            style={{
              background: theme.bg,
              border: `1px solid ${theme.border}`,
              borderRadius: 10,
              padding: 14,
              minHeight: 180,
              maxHeight: 320,
              overflow: "auto",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              color: theme.text,
            }}
          >
            {selectedTickId
              ? tickOutput || "No output captured for this tick."
              : "Select a tick to view its log."}
          </div>
        </div>
      </div>
    </div>
  );
}
