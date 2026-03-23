import { useState, useEffect, useCallback, useRef } from "react";
import QRCode from "qrcode";
import {
  formatDateTimeLocalInput,
  formatTaskDateTime,
  formatTaskTime,
  parseTaskDateTime,
  serializeDateTimeLocalInput,
} from "./dateTime.mjs";
import {
  buildChannelsSavePayload,
  createInitialChannelsState,
  isWeixinQrImageSource,
  mergeChannelsStatus,
} from "./channelsSettings.mjs";

const API = "http://127.0.0.1:9712/api";

// ─── Theme ───
const THEMES = {
  dark: {
    bg: "#0a0a0f",
    surface: "#12121a",
    surfaceHover: "#1a1a26",
    border: "#1e1e2e",
    borderActive: "#2d2d44",
    text: "#e2e2ef",
    textMuted: "#6b6b8a",
    textDim: "#44445e",
    accent: "#7c6aff",
    accentGlow: "rgba(124, 106, 255, 0.15)",
    green: "#34d399",
    greenBg: "rgba(52, 211, 153, 0.08)",
    orange: "#fbbf24",
    orangeBg: "rgba(251, 191, 36, 0.08)",
    red: "#f87171",
    redBg: "rgba(248, 113, 113, 0.08)",
    blue: "#60a5fa",
    blueBg: "rgba(96, 165, 250, 0.08)",
    cyan: "#22d3ee",
    cyanBg: "rgba(34, 211, 238, 0.08)",
  },
  light: {
    bg: "#f5f5fa",
    surface: "#ffffff",
    surfaceHover: "#eeeef7",
    border: "#dcdce8",
    borderActive: "#b8b8d0",
    text: "#1a1a2e",
    textMuted: "#6b6b8a",
    textDim: "#a0a0bc",
    accent: "#5b4ecc",
    accentGlow: "rgba(91, 78, 204, 0.12)",
    green: "#059669",
    greenBg: "rgba(5, 150, 105, 0.08)",
    orange: "#d97706",
    orangeBg: "rgba(217, 119, 6, 0.08)",
    red: "#dc2626",
    redBg: "rgba(220, 38, 38, 0.08)",
    blue: "#2563eb",
    blueBg: "rgba(37, 99, 235, 0.08)",
    cyan: "#0891b2",
    cyanBg: "rgba(8, 145, 178, 0.08)",
  },
};

// Mutable module-level theme reference — updated before each App render
let theme = THEMES.dark;

function getStatusConfig() {
  return {
    pending: { label: "Pending", color: theme.orange, bg: theme.orangeBg, icon: "◌" },
    scheduled: { label: "Scheduled", color: theme.cyan, bg: theme.cyanBg, icon: "⏱" },
    running: { label: "Running", color: theme.blue, bg: theme.blueBg, icon: "⟳" },
    completed: { label: "Completed", color: theme.green, bg: theme.greenBg, icon: "✓" },
    failed: { label: "Failed", color: theme.red, bg: theme.redBg, icon: "✕" },
    cancelled: { label: "Cancelled", color: theme.textMuted, bg: "rgba(107,107,138,0.08)", icon: "◻" },
    blocked: { label: "Blocked", color: theme.textMuted, bg: "rgba(107,107,138,0.1)", icon: "⊘" },
  };
}

const COLUMNS = [
  { key: "queued", label: "Queue", statuses: ["pending", "scheduled", "blocked"], icon: "⧖" },
  { key: "running", label: "Running", statuses: ["running"], icon: "▸" },
  { key: "done", label: "Done", statuses: ["completed", "failed", "cancelled"], icon: "◆" },
];

const AGENTS = {
  claude: { label: "Claude Code", icon: "⌘", color: "#7c6aff" },
  codex: { label: "Codex CLI", icon: "◈", color: "#10a37f" },
};

// ─── Formatted Output Component ───
function FormattedOutput({ content, theme }) {
  if (!content) return null;

  // 解析JSON流数据，只显示关键信息
  const parseStreamJSON = (text) => {
    const lines = text.split('\n');
    const parsedLines = [];

    lines.forEach((line, index) => {
      if (!line.trim()) return;

      try {
        const event = JSON.parse(line);
        const eventType = event.type;

        switch (eventType) {
          case 'user':
          case 'assistant': {
            const isUser = eventType === 'user';
            const msg = event.message || {};
            const msgContent = msg.content || [];
            const prefix = isUser ? '👤 User: ' : '🤖 Assistant: ';
            const color = isUser ? theme.accent : theme.green;
            let textBuf = '';
            const flushText = () => {
              if (textBuf.trim()) {
                parsedLines.push({ type: eventType, text: prefix + textBuf, style: { color, fontWeight: isUser ? 'bold' : 'normal' } });
                textBuf = '';
              }
            };
            for (const c of msgContent) {
              if (typeof c === 'string') {
                textBuf += c;
              } else if (c && typeof c === 'object') {
                if (c.type === 'text') {
                  textBuf += c.text || '';
                } else if (c.type === 'image') {
                  flushText();
                  const src = c.source && c.source.type === 'base64'
                    ? `data:${c.source.media_type || 'image/jpeg'};base64,${c.source.data}`
                    : null;
                  if (src) parsedLines.push({ type: 'image', src });
                }
              }
            }
            flushText();
            break;
          }

          case 'result':
            // 最终结果
            if (event.result) {
              parsedLines.push({
                type: 'result',
                text: `✅ Result: ${event.result}`,
                style: { color: theme.green, fontWeight: 'bold' }
              });
            }
            break;

          case 'error':
            // 错误信息
            parsedLines.push({
              type: 'error',
              text: `❌ Error: ${event.error || 'Unknown error'}`,
              style: { color: theme.red, fontWeight: 'bold' }
            });
            break;

          default:
            // 其他事件类型 - 显示更多信息
            if (eventType) {
              let displayText = `[${eventType}]`;
              // 尝试显示事件中的关键信息
              if (event.message) {
                const msg = event.message;
                if (msg.content && Array.isArray(msg.content)) {
                  const textContent = msg.content.filter(c =>
                    (typeof c === 'string') ||
                    (c && typeof c === 'object' && c.type === 'text')
                  ).map(c => typeof c === 'string' ? c : (c.text || '')).join('');
                  if (textContent.trim()) {
                    displayText = textContent.slice(0, 200);
                  }
                }
              } else if (event.result) {
                displayText = `Result: ${event.result.slice(0, 200)}`;
              } else if (event.error) {
                displayText = `Error: ${event.error.slice(0, 200)}`;
              }

              parsedLines.push({
                type: 'event',
                text: displayText,
                style: { color: theme.textDim, fontSize: '11px', fontFamily: 'monospace' }
              });
            }
        }
      } catch (error) {
        // 如果不是有效的JSON，可能是普通文本输出
        if (line.trim() && !line.startsWith('{')) {
          // 只显示有意义的非JSON行
          if (line.includes('error') || line.includes('Error')) {
            parsedLines.push({
              type: 'error',
              text: line,
              style: { color: theme.red }
            });
          } else if (line.includes('success') || line.includes('Success')) {
            parsedLines.push({
              type: 'success',
              text: line,
              style: { color: theme.green }
            });
          } else if (line.length > 10) { // 只显示较长的非JSON行
            parsedLines.push({
              type: 'text',
              text: line,
              style: { color: theme.textDim }
            });
          }
        }
      }
    });

    return parsedLines;
  };

  const parsedContent = parseStreamJSON(content);

  if (parsedContent.length === 0) {
    return (
      <div style={{ color: theme.textDim, fontStyle: 'italic', fontSize: '12px' }}>
        Waiting for agent output...
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', lineHeight: '1.6' }}>
      {parsedContent.map((item, index) => (
        item.type === 'image' ? (
          <div key={index} style={{ margin: '6px 0' }}>
            <img src={item.src} alt="output image" style={{ maxWidth: '100%', borderRadius: '4px', display: 'block' }} />
          </div>
        ) : (
          <div key={index} style={{
            ...item.style,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: '2px',
            padding: '2px 0'
          }}>
            {item.text}
          </div>
        )
      ))}
    </div>
  );
}

// Renders event content. For image_content events renders an <img> directly;
// for text events renders plain text with backward-compat for legacy __image__ markers.
function EventContent({ content, eventType }) {
  if (!content) return null;

  // New format: image_content events store {"media_type": ..., "data": ...}
  if (eventType === 'image_content') {
    try {
      const obj = JSON.parse(content);
      const src = obj.data ? `data:${obj.media_type || 'image/jpeg'};base64,${obj.data}` : null;
      if (src) return <img src={src} alt="image" style={{ maxWidth: '100%', borderRadius: 4, display: 'block', margin: '4px 0' }} />;
    } catch {
      // fall through to text rendering
    }
    return <span>[image]</span>;
  }

  // Backward compat: legacy text events may contain embedded __image__ JSON markers
  const imgRe = /\{"__image__":true[^}]*,"source":\{[^}]*\}[^}]*\}/g;
  if (!imgRe.test(content)) {
    return <span>{content}</span>;
  }
  const parts = [];
  let lastIdx = 0;
  let match;
  imgRe.lastIndex = 0;
  while ((match = imgRe.exec(content)) !== null) {
    if (match.index > lastIdx) {
      parts.push({ type: 'text', text: content.slice(lastIdx, match.index) });
    }
    try {
      const obj = JSON.parse(match[0]);
      const src = obj.source && obj.source.type === 'base64'
        ? `data:${obj.source.media_type || 'image/jpeg'};base64,${obj.source.data}`
        : null;
      if (src) parts.push({ type: 'image', src });
      else parts.push({ type: 'text', text: '[image]' });
    } catch {
      parts.push({ type: 'text', text: match[0] });
    }
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < content.length) {
    parts.push({ type: 'text', text: content.slice(lastIdx) });
  }
  return (
    <>
      {parts.map((p, i) =>
        p.type === 'image'
          ? <img key={i} src={p.src} alt="image" style={{ maxWidth: '100%', borderRadius: 4, display: 'block', margin: '4px 0' }} />
          : <span key={i}>{p.text}</span>
      )}
    </>
  );
}

// ─── CSRF token ───
// Fetched once at startup; reused for all state-changing requests.
let _csrfTokenPromise = null;
function getCsrfToken() {
  if (!_csrfTokenPromise) {
    _csrfTokenPromise = fetch(`${API}/csrf-token`)
      .then(r => r.json())
      .then(d => d.csrf_token || "")
      .catch(() => "");
  }
  return _csrfTokenPromise;
}

async function csrfHeaders(extra = {}) {
  const token = await getCsrfToken();
  return { "Content-Type": "application/json", "X-CSRF-Token": token, ...extra };
}

// ─── API helpers ───
async function fetchTasks() {
  const res = await fetch(`${API}/tasks`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchHeartbeats() {
  const res = await fetch(`${API}/heartbeats`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function createTask(data) {
  const res = await fetch(`${API}/tasks`, {
    method: "POST", headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
  return res.json();
}

async function createHeartbeat(data) {
  const res = await fetch(`${API}/heartbeats`, {
    method: "POST", headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

async function updateHeartbeat(id, data) {
  const res = await fetch(`${API}/heartbeats/${id}`, {
    method: "PUT", headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

async function deleteHeartbeat(id) {
  const res = await fetch(`${API}/heartbeats/${id}`, {
    method: "DELETE", headers: await csrfHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function runHeartbeatNow(id) {
  const res = await fetch(`${API}/heartbeats/${id}/run-now`, {
    method: "POST", headers: await csrfHeaders(),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

async function pauseHeartbeat(id) {
  const res = await fetch(`${API}/heartbeats/${id}/pause`, {
    method: "POST", headers: await csrfHeaders(),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

async function resumeHeartbeatApi(id) {
  const res = await fetch(`${API}/heartbeats/${id}/resume`, {
    method: "POST", headers: await csrfHeaders(),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

async function fetchHeartbeatTicks(id) {
  const res = await fetch(`${API}/heartbeats/${id}/ticks?limit=20`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  return payload.ticks || [];
}

async function fetchHeartbeatTickOutput(heartbeatId, tickId) {
  const res = await fetch(`${API}/heartbeats/${heartbeatId}/ticks/${tickId}/output`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function cancelTask(id) {
  await fetch(`${API}/tasks/${id}/cancel`, { method: "POST", headers: await csrfHeaders() });
}

async function retryTask(id) {
  await fetch(`${API}/tasks/${id}/retry`, { method: "POST", headers: await csrfHeaders() });
}

async function deleteTask(id) {
  await fetch(`${API}/tasks/${id}`, { method: "DELETE", headers: await csrfHeaders() });
}

async function updateTask(id, data) {
  const res = await fetch(`${API}/tasks/${id}`, {
    method: "PUT", headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function respondToTask(id, answer) {
  await fetch(`${API}/tasks/${id}/respond`, {
    method: "POST", headers: await csrfHeaders(),
    body: JSON.stringify({ answer }),
  });
}

async function resumeTask(id, message) {
  const res = await fetch(`${API}/tasks/${id}/resume`, {
    method: "POST", headers: await csrfHeaders(),
    body: JSON.stringify({ message }),
  });
  return res.json();
}

async function fetchTaskMessages(id) {
  try {
    const res = await fetch(`${API}/tasks/${id}/messages`);
    return res.ok ? await res.json() : [];
  } catch { return []; }
}

async function fetchTaskEvents(id) {
  try {
    const res = await fetch(`${API}/tasks/${id}/events?limit=1000`);
    if (res.ok) {
      const data = await res.json();
      return data.events || [];
    }
    return [];
  } catch { return []; }
}

async function fetchSettings() {
  try {
    const res = await fetch(`${API}/settings`);
    return res.ok ? await res.json() : {};
  } catch { return {}; }
}

async function updateSettings(data) {
  await fetch(`${API}/settings`, {
    method: "PUT", headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

async function fetchFeishuSettings() {
  try {
    const res = await fetch(`${API}/feishu/settings`);
    return res.ok ? await res.json() : {};
  } catch { return {}; }
}

async function updateFeishuSettings(data) {
  await fetch(`${API}/feishu/settings`, {
    method: "POST", headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

async function fetchChannelsStatus() {
  try {
    const res = await fetch(`${API}/channels/status`);
    return res.ok ? await res.json() : {};
  } catch { return {}; }
}

async function updateChannelsSettings(data) {
  await fetch(`${API}/channels/settings`, {
    method: "POST", headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

async function runWeixinAction(action) {
  await fetch(`${API}/channels/weixin/action`, {
    method: "POST", headers: await csrfHeaders(),
    body: JSON.stringify({ action }),
  });
}

// ─── Components ───

function Tooltip({ text, children }) {
  const [visible, setVisible] = useState(false);
  return (
    <div
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%",
          transform: "translateX(-50%)",
          background: theme.surface, border: `1px solid ${theme.border}`,
          color: theme.textMuted, fontSize: 11, padding: "4px 8px",
          borderRadius: 6, whiteSpace: "nowrap", pointerEvents: "none",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)", zIndex: 9999,
        }}>
          {text}
        </div>
      )}
    </div>
  );
}

function Badge({ status }) {
  const cfg = getStatusConfig()[status] || getStatusConfig().pending;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
      color: cfg.color, background: cfg.bg, letterSpacing: 0.3,
    }}>
      <span style={{ fontSize: 10 }}>{cfg.icon}</span>
      {cfg.label}
    </span>
  );
}

function Tag({ children }) {
  return (
    <span style={{
      padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 500,
      background: theme.accentGlow, color: theme.accent, letterSpacing: 0.4,
    }}>
      {children}
    </span>
  );
}

function AgentBadge({ agent }) {
  const cfg = AGENTS[agent] || AGENTS.claude;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
      color: cfg.color, background: `${cfg.color}18`, letterSpacing: 0.3,
    }}>
      <span style={{ fontSize: 9 }}>{cfg.icon}</span>
      {cfg.label}
    </span>
  );
}

function TaskCard({ task, onAction, onViewDetail }) {
  const [hovered, setHovered] = useState(false);
  const cfg = getStatusConfig()[task.status] || getStatusConfig().pending;
  const tags = task.tags ? task.tags.split(",").filter(Boolean) : [];

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onViewDetail(task)}
      style={{
        background: hovered ? theme.surfaceHover : theme.surface,
        border: `1px solid ${hovered ? theme.borderActive : theme.border}`,
        borderLeft: `3px solid ${cfg.color}`,
        borderRadius: 10, padding: "14px 16px", cursor: "pointer",
        transition: "all 0.2s ease",
        transform: hovered ? "translateY(-1px)" : "none",
        boxShadow: hovered ? `0 4px 20px rgba(0,0,0,0.3)` : "none",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <span style={{
          fontSize: 13, fontWeight: 600, color: theme.text,
          lineHeight: 1.4, flex: 1, marginRight: 8,
          fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
        }}>
          {task.title}
        </span>
        <Badge status={task.status} />
      </div>

      <div style={{
        fontSize: 12, color: theme.textMuted, marginBottom: 10,
        lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis",
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
      }}>
        {task.prompt}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <AgentBadge agent={task.agent} />
          {task.schedule_type === "delayed" && (
            <Tag>⏳ {task.delay_seconds}s</Tag>
          )}
          {task.schedule_type === "scheduled_at" && task.next_run_at && (
            <Tag>📅 {formatTaskDateTime(task.next_run_at)}</Tag>
          )}
          {task.schedule_type === "cron" && (
            <Tag>⏲ {task.cron_expr}</Tag>
          )}
          {tags.map((t, i) => <Tag key={i}>{t.trim()}</Tag>)}
        </div>

        <div style={{ display: "flex", gap: 4 }} onClick={e => e.stopPropagation()}>
          {["pending", "scheduled", "blocked"].includes(task.status) && (
            <ActionBtn label="✎" title="Edit" onClick={() => onAction("edit", task.id)} color={theme.blue || theme.accent} />
          )}
          {["completed", "cancelled", "failed"].includes(task.status) && (
            <ActionBtn label="⑂" title="Fork" onClick={() => onAction("fork", task.id)} color={theme.cyan || theme.accent} />
          )}
          {task.status === "failed" && (
            <ActionBtn label="↻" title="Retry" onClick={() => onAction("retry", task.id)} color={theme.orange} />
          )}
          {["pending", "scheduled", "running"].includes(task.status) && (
            <ActionBtn label="■" title="Cancel" onClick={() => onAction("cancel", task.id)} color={theme.red} />
          )}
          <ActionBtn label="×" title="Delete" onClick={() => onAction("delete", task.id)} color={theme.textMuted} />
        </div>
      </div>

      {task.run_count > 0 && (
        <div style={{ fontSize: 10, color: theme.textDim, marginTop: 8, fontFamily: "monospace" }}>
          Runs: {task.run_count}{task.max_runs ? ` / ${task.max_runs}` : ""}
          {task.last_run_at && ` · Last: ${formatTaskTime(task.last_run_at)}`}
        </div>
      )}

      {/* DAG info */}
      {task.status === "blocked" && task.dependencies && task.dependencies.length > 0 && (
        <div style={{ fontSize: 10, color: theme.textDim, marginTop: 6, fontFamily: "monospace" }}>
          ⊘ Waiting for: {task.dependencies.map(d => `#${d.depends_on_task_id}`).join(", ")}
        </div>
      )}
      {task.dependents && task.dependents.length > 0 && task.status === "completed" && (
        <div style={{ fontSize: 10, color: theme.textDim, marginTop: 6, fontFamily: "monospace" }}>
          → Unlocks: {task.dependents.map(id => `#${id}`).join(", ")}
        </div>
      )}
      {task.dag_id && (
        <div style={{ fontSize: 10, color: theme.accent, marginTop: 4, opacity: 0.6, fontFamily: "monospace" }}>
          dag: {task.dag_id}
        </div>
      )}
    </div>
  );
}

function ActionBtn({ label, title, onClick, color }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      title={title} onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? `${color}22` : "transparent",
        border: "none", color: color, cursor: "pointer",
        width: 24, height: 24, borderRadius: 6, fontSize: 14,
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "background 0.15s",
      }}
    >
      {label}
    </button>
  );
}

function Column({ col, tasks, onAction, onViewDetail }) {
  return (
    <div style={{ flex: 1, minWidth: 300 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        marginBottom: 16, padding: "0 4px",
      }}>
        <span style={{ fontSize: 16, opacity: 0.4 }}>{col.icon}</span>
        <span style={{
          fontSize: 12, fontWeight: 700, color: theme.textMuted,
          letterSpacing: 1.5, textTransform: "uppercase",
        }}>
          {col.label}
        </span>
        <span style={{
          background: theme.border, borderRadius: 10, padding: "2px 8px",
          fontSize: 11, color: theme.textDim, fontWeight: 600,
        }}>
          {tasks.length}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {tasks.map(t => (
          <TaskCard key={t.id} task={t} onAction={onAction} onViewDetail={onViewDetail} />
        ))}
        {tasks.length === 0 && (
          <div style={{
            border: `1px dashed ${theme.border}`, borderRadius: 10,
            padding: 32, textAlign: "center", color: theme.textDim, fontSize: 12,
          }}>
            No tasks
          </div>
        )}
      </div>
    </div>
  );
}

function HeartbeatBadge({ enabled }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
      color: enabled ? theme.green : theme.textMuted,
      background: enabled ? theme.greenBg : "rgba(107,107,138,0.08)",
      letterSpacing: 0.3,
    }}>
      <span style={{ fontSize: 10 }}>{enabled ? "●" : "◌"}</span>
      {enabled ? "Enabled" : "Paused"}
    </span>
  );
}

function HeartbeatModal({ onClose, onSubmit, initialData, defaultAgent, mode = "create" }) {
  const savedDir = localStorage.getItem("agentforge_working_dir") || "~/papers";
  const [form, setForm] = useState(() => ({
    name: initialData?.name || "",
    working_dir: initialData?.working_dir || savedDir,
    schedule_type: initialData?.schedule_type || "interval",
    interval_seconds: initialData?.interval_seconds || 600,
    cron_expr: initialData?.cron_expr || "",
    check_prompt: initialData?.check_prompt || "",
    action_prompt_template: initialData?.action_prompt_template || "",
    default_agent: initialData?.default_agent || defaultAgent || "claude",
    cooldown_seconds: initialData?.cooldown_seconds || 1800,
    enabled: initialData?.enabled ?? true,
  }));

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const inputStyle = {
    width: "100%", padding: "10px 14px", borderRadius: 8,
    border: `1px solid ${theme.border}`, background: theme.bg,
    color: theme.text, fontSize: 13, outline: "none", boxSizing: "border-box",
    fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
  };
  const labelStyle = {
    fontSize: 11, fontWeight: 600, color: theme.textMuted,
    letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6, display: "block",
  };

  const handleSubmit = () => {
    localStorage.setItem("agentforge_working_dir", form.working_dir);
    onSubmit({
      ...form,
      name: form.name || "Untitled heartbeat",
      interval_seconds: form.schedule_type === "interval" ? parseInt(form.interval_seconds) || 600 : null,
      cooldown_seconds: parseInt(form.cooldown_seconds) || 0,
      cron_expr: form.schedule_type === "cron" ? form.cron_expr : null,
    });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, backdropFilter: "blur(8px)",
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: theme.surface, border: `1px solid ${theme.border}`,
        borderRadius: 16, padding: 32, width: 640, maxHeight: "84vh",
        overflow: "auto", boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
      }}>
        <h2 style={{
          margin: "0 0 24px", fontSize: 18, fontWeight: 700, color: theme.text,
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {mode === "edit" ? "Edit Heartbeat" : "New Heartbeat"}
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={labelStyle}>Name</label>
            <input style={inputStyle} value={form.name} onChange={e => set("name", e.target.value)} placeholder="Repo review watcher" />
          </div>
          <div>
            <label style={labelStyle}>Working Directory</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input style={{ ...inputStyle, flex: 1 }} value={form.working_dir} onChange={e => set("working_dir", e.target.value)} />
              {window.electronAPI?.selectDirectory && (
                <button onClick={async () => {
                  const dir = await window.electronAPI.selectDirectory();
                  if (dir) set("working_dir", dir);
                }} style={{
                  padding: "8px 14px", borderRadius: 8, cursor: "pointer",
                  border: `1px solid ${theme.border}`, background: theme.bg,
                  color: theme.textMuted, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
                }}>
                  Browse
                </button>
              )}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Schedule Type</label>
            <div style={{ display: "flex", gap: 8 }}>
              {["interval", "cron"].map(t => (
                <button key={t} onClick={() => set("schedule_type", t)} style={{
                  flex: 1, padding: "8px 12px", borderRadius: 8, cursor: "pointer",
                  border: `1px solid ${form.schedule_type === t ? theme.accent : theme.border}`,
                  background: form.schedule_type === t ? theme.accentGlow : "transparent",
                  color: form.schedule_type === t ? theme.accent : theme.textMuted,
                  fontSize: 12, fontWeight: 600, textTransform: "capitalize",
                }}>
                  {t === "interval" ? "⟳ Interval" : "⏲ Cron"}
                </button>
              ))}
            </div>
          </div>
          {form.schedule_type === "interval" ? (
            <div>
              <label style={labelStyle}>Interval (seconds)</label>
              <input type="number" style={inputStyle} value={form.interval_seconds} onChange={e => set("interval_seconds", e.target.value)} />
            </div>
          ) : (
            <div>
              <label style={labelStyle}>Cron Expression</label>
              <input style={inputStyle} value={form.cron_expr} onChange={e => set("cron_expr", e.target.value)} placeholder="*/10 * * * *" />
            </div>
          )}
          <div>
            <label style={labelStyle}>Decision Prompt *</label>
            <textarea
              style={{ ...inputStyle, height: 110, resize: "vertical" }}
              value={form.check_prompt}
              onChange={e => set("check_prompt", e.target.value)}
              placeholder="Check whether there are new meaningful code changes that deserve a review task. Return JSON only."
            />
          </div>
          <div>
            <label style={labelStyle}>Triggered Task Prompt Template</label>
            <textarea
              style={{ ...inputStyle, height: 90, resize: "vertical" }}
              value={form.action_prompt_template}
              onChange={e => set("action_prompt_template", e.target.value)}
              placeholder="Review the latest code changes and summarize bugs, regressions, and missing tests."
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>Default Agent</label>
              <select style={inputStyle} value={form.default_agent} onChange={e => set("default_agent", e.target.value)}>
                {Object.entries(AGENTS).map(([key, cfg]) => <option key={key} value={key}>{cfg.label}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Cooldown (seconds)</label>
              <input type="number" style={inputStyle} value={form.cooldown_seconds} onChange={e => set("cooldown_seconds", e.target.value)} />
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: theme.textMuted }}>
            <input type="checkbox" checked={!!form.enabled} onChange={e => set("enabled", e.target.checked)} />
            Enabled
          </label>
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 24 }}>
          <button onClick={onClose} style={{
            padding: "10px 20px", borderRadius: 8, border: `1px solid ${theme.border}`,
            background: "transparent", color: theme.textMuted, cursor: "pointer",
            fontSize: 13, fontWeight: 600,
          }}>Cancel</button>
          <button onClick={handleSubmit} style={{
            padding: "10px 24px", borderRadius: 8, border: "none",
            background: theme.accent, color: "#fff", cursor: "pointer",
            fontSize: 13, fontWeight: 600, boxShadow: `0 0 20px ${theme.accentGlow}`,
          }}>
            {mode === "edit" ? "Save" : "Create Heartbeat"}
          </button>
        </div>
      </div>
    </div>
  );
}

function HeartbeatCard({ heartbeat, onAction, onViewDetail }) {
  const tags = [];
  if (heartbeat.schedule_type === "interval" && heartbeat.interval_seconds) tags.push(`⟳ ${heartbeat.interval_seconds}s`);
  if (heartbeat.schedule_type === "cron" && heartbeat.cron_expr) tags.push(`⏲ ${heartbeat.cron_expr}`);
  if (heartbeat.last_decision) tags.push(`Last: ${heartbeat.last_decision}`);

  return (
    <div
      onClick={() => onViewDetail(heartbeat)}
      style={{
        background: theme.surface, border: `1px solid ${theme.border}`,
        borderRadius: 12, padding: "16px 18px", cursor: "pointer",
        transition: "all 0.2s ease",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{
            fontSize: 14, fontWeight: 700, color: theme.text,
            fontFamily: "'JetBrains Mono', monospace", marginBottom: 6,
          }}>
            {heartbeat.name}
          </div>
          <div style={{
            fontSize: 12, color: theme.textMuted, lineHeight: 1.5,
            overflow: "hidden", textOverflow: "ellipsis",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          }}>
            {heartbeat.check_prompt}
          </div>
        </div>
        <HeartbeatBadge enabled={heartbeat.enabled} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <AgentBadge agent={heartbeat.default_agent} />
          {tags.map((tag, idx) => <Tag key={idx}>{tag}</Tag>)}
        </div>
        <div style={{ display: "flex", gap: 4 }} onClick={e => e.stopPropagation()}>
          <ActionBtn label="⚡" title="Run now" onClick={() => onAction("run", heartbeat.id)} color={theme.orange} />
          <ActionBtn label="✎" title="Edit" onClick={() => onAction("edit", heartbeat.id)} color={theme.blue} />
          {heartbeat.enabled ? (
            <ActionBtn label="❚❚" title="Pause" onClick={() => onAction("pause", heartbeat.id)} color={theme.textMuted} />
          ) : (
            <ActionBtn label="▶" title="Resume" onClick={() => onAction("resume", heartbeat.id)} color={theme.green} />
          )}
          <ActionBtn label="×" title="Delete" onClick={() => onAction("delete", heartbeat.id)} color={theme.red} />
        </div>
      </div>

      <div style={{ fontSize: 11, color: theme.textDim, marginTop: 10, fontFamily: "monospace", lineHeight: 1.6 }}>
        Next: {heartbeat.next_run_at ? formatTaskDateTime(heartbeat.next_run_at) : "n/a"}
        {" · "}
        Triggered: {heartbeat.last_triggered_at ? formatTaskDateTime(heartbeat.last_triggered_at) : "never"}
      </div>
      {heartbeat.last_error && (
        <div style={{ fontSize: 11, color: theme.red, marginTop: 6, lineHeight: 1.4 }}>
          Last error: {heartbeat.last_error}
        </div>
      )}
    </div>
  );
}

function HeartbeatDetailPanel({ heartbeat, ticks, onClose }) {
  const [selectedTickId, setSelectedTickId] = useState(null);
  const [tickOutput, setTickOutput] = useState("");
  const [tickRunning, setTickRunning] = useState(false);
  const outputRef = useRef(null);

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
    <div style={{
      position: "fixed", top: 0, right: 0, width: 520, height: "100vh",
      background: theme.surface, borderLeft: `1px solid ${theme.border}`,
      boxShadow: "-20px 0 60px rgba(0,0,0,0.4)", zIndex: 500,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        padding: "22px 24px", borderBottom: `1px solid ${theme.border}`,
        display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: theme.text, fontFamily: "'JetBrains Mono', monospace" }}>
            {heartbeat.name}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>
            {heartbeat.working_dir}
          </div>
        </div>
        <button onClick={onClose} style={{
          background: "transparent", border: "none", color: theme.textMuted,
          cursor: "pointer", fontSize: 22, lineHeight: 1,
        }}>×</button>
      </div>
      <div style={{ padding: 24, overflow: "auto", flex: 1 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <HeartbeatBadge enabled={heartbeat.enabled} />
          <AgentBadge agent={heartbeat.default_agent} />
          {heartbeat.schedule_type === "interval" ? <Tag>⟳ {heartbeat.interval_seconds}s</Tag> : <Tag>⏲ {heartbeat.cron_expr}</Tag>}
          {heartbeat.last_decision && <Tag>{heartbeat.last_decision}</Tag>}
        </div>
        <div style={{ fontSize: 12, color: theme.textMuted, lineHeight: 1.7, marginBottom: 18 }}>
          <div>Next run: {heartbeat.next_run_at ? formatTaskDateTime(heartbeat.next_run_at) : "n/a"}</div>
          <div>Last tick: {heartbeat.last_tick_at ? formatTaskDateTime(heartbeat.last_tick_at) : "never"}</div>
          <div>Last trigger: {heartbeat.last_triggered_at ? formatTaskDateTime(heartbeat.last_triggered_at) : "never"}</div>
          <div>Cooldown: {heartbeat.cooldown_seconds || 0}s</div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 8 }}>
            Decision Prompt
          </div>
          <div style={{
            fontSize: 12, lineHeight: 1.7, color: theme.text,
            background: theme.bg, border: `1px solid ${theme.border}`,
            borderRadius: 10, padding: 14, whiteSpace: "pre-wrap",
          }}>
            {heartbeat.check_prompt}
          </div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 8 }}>
            Triggered Task Template
          </div>
          <div style={{
            fontSize: 12, lineHeight: 1.7, color: theme.text,
            background: theme.bg, border: `1px solid ${theme.border}`,
            borderRadius: 10, padding: 14, whiteSpace: "pre-wrap",
          }}>
            {heartbeat.action_prompt_template || "No template configured"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 8 }}>
            Recent Ticks
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ticks.map((tick) => {
              let payload = null;
              try { payload = tick.decision_payload ? JSON.parse(tick.decision_payload) : null; } catch {}
              return (
                <div key={tick.id} style={{
                  background: theme.bg, border: `1px solid ${theme.border}`,
                  borderRadius: 10, padding: 12, cursor: "pointer",
                  boxShadow: selectedTickId === tick.id ? `0 0 0 1px ${theme.accent} inset` : "none",
                }}>
                  <div onClick={() => setSelectedTickId(tick.id)} style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: theme.text }}>{tick.decision_type || tick.status}</div>
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
                    <div style={{ fontSize: 11, color: theme.accent, marginTop: 6, fontFamily: "monospace" }}>
                      Triggered task #{tick.task_id}
                    </div>
                  )}
                </div>
              );
            })}
            {ticks.length === 0 && (
              <div style={{
                border: `1px dashed ${theme.border}`, borderRadius: 10,
                padding: 24, textAlign: "center", color: theme.textDim, fontSize: 12,
              }}>
                No ticks yet
              </div>
            )}
          </div>
        </div>
        <div style={{ marginTop: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, letterSpacing: 0.8, textTransform: "uppercase" }}>
              Tick Log
            </div>
            {selectedTickId && (
              <div style={{ fontSize: 11, color: tickRunning ? theme.orange : theme.textDim, fontFamily: "monospace" }}>
                {tickRunning ? "LIVE" : "Stored"} · tick #{selectedTickId}
              </div>
            )}
          </div>
          <div
            ref={outputRef}
            style={{
              background: theme.bg, border: `1px solid ${theme.border}`,
              borderRadius: 10, padding: 14, minHeight: 180, maxHeight: 320,
              overflow: "auto", fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap",
              color: theme.text,
            }}
          >
            {selectedTickId ? (tickOutput || "No output captured for this tick.") : "Select a tick to view its log."}
          </div>
        </div>
      </div>
    </div>
  );
}

function NewTaskModal({ onClose, onSubmit, initialData, mode = "create" }) {
  const savedDir = localStorage.getItem("agentforge_working_dir") || "~/papers";
  const [form, setForm] = useState(() => {
    if (initialData) {
      return {
        title: initialData.title || "",
        prompt: initialData.prompt || "",
        working_dir: initialData.working_dir || savedDir,
        schedule_type: initialData.schedule_type || "immediate",
        cron_expr: initialData.cron_expr || "",
        delay_seconds: initialData.delay_seconds || 60,
        scheduled_at: initialData.next_run_at
          ? formatDateTimeLocalInput(initialData.next_run_at)
          : "",
        max_runs: initialData.max_runs || "",
        tags: initialData.tags || "",
        agent: initialData.agent || "claude",
        dag_id: initialData.dag_id || "",
      };
    }
    return {
      title: "", prompt: "", working_dir: savedDir,
      schedule_type: "immediate", cron_expr: "", delay_seconds: 60,
      scheduled_at: "",
      max_runs: "", tags: "", agent: "claude",
      dag_id: "",
    };
  });
  const [promptImages, setPromptImages] = useState(() => {
    if (initialData?.prompt_images && Array.isArray(initialData.prompt_images)) {
      return initialData.prompt_images.map(img => ({
        name: img.name || "image",
        media_type: img.media_type || "image/jpeg",
        data: img.data || "",
        preview: img.data ? `data:${img.media_type || "image/jpeg"};base64,${img.data}` : "",
      }));
    }
    return [];
  });
  // DAG dependencies: [{task_id, inject_result, _input}] — _input is the text box value
  const [depRows, setDepRows] = useState(() => {
    if (initialData?.dependencies && Array.isArray(initialData.dependencies)) {
      return initialData.dependencies.map(dep => ({
        task_id: dep.depends_on_task_id,
        inject_result: !!dep.inject_result,
        _input: String(dep.depends_on_task_id),
      }));
    }
    return [];
  });
  const [scheduledAtError, setScheduledAtError] = useState("");

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const handleImageSelect = (e) => {
    const files = Array.from(e.target.files || []);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result; // "data:image/jpeg;base64,..."
        const [meta, data] = dataUrl.split(',');
        const media_type = meta.match(/:(.*?);/)?.[1] || 'image/jpeg';
        setPromptImages(prev => [...prev, { name: file.name, media_type, data, preview: dataUrl }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const removeImage = (idx) => setPromptImages(prev => prev.filter((_, i) => i !== idx));

  const handleSubmit = () => {
    if (!form.prompt.trim()) return;
    localStorage.setItem("agentforge_working_dir", form.working_dir);

    // Build depends_on list (only valid numeric IDs)
    const depends_on = depRows
      .filter(r => r.task_id)
      .map(r => ({ task_id: r.task_id, inject_result: r.inject_result }));

    const data = {
      ...form,
      title: form.title || form.prompt.slice(0, 60),
      delay_seconds: form.schedule_type === "delayed" ? parseInt(form.delay_seconds) || 60 : null,
      cron_expr: form.schedule_type === "cron" ? form.cron_expr : null,
      max_runs: form.max_runs ? parseInt(form.max_runs) : null,
      prompt_images: promptImages.map(({ name, media_type, data }) => ({ name, media_type, data })),
      depends_on: mode === "edit" ? depends_on : (depends_on.length > 0 ? depends_on : undefined),
      dag_id: form.dag_id || undefined,
    };

    // Handle scheduled_at: convert datetime-local to ISO timestamp
    if (form.schedule_type === "scheduled_at") {
      const localDate = parseTaskDateTime(form.scheduled_at);
      const serialized = serializeDateTimeLocalInput(form.scheduled_at);
      if (!form.scheduled_at || !serialized || !localDate || isNaN(localDate.getTime())) {
        setScheduledAtError("Please enter a valid date and time.");
        return;
      }
      setScheduledAtError("");
      data.next_run_at = serialized;
    }

    onSubmit(data);
  };

  const inputStyle = {
    width: "100%", padding: "10px 14px", borderRadius: 8,
    border: `1px solid ${theme.border}`, background: theme.bg,
    color: theme.text, fontSize: 13, outline: "none", boxSizing: "border-box",
    fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
    transition: "border-color 0.2s",
  };

  const labelStyle = {
    fontSize: 11, fontWeight: 600, color: theme.textMuted,
    letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6, display: "block",
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, backdropFilter: "blur(8px)",
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: theme.surface, border: `1px solid ${theme.border}`,
        borderRadius: 16, padding: 32, width: 520, maxHeight: "80vh",
        overflow: "auto", boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
      }}>
        <h2 style={{
          margin: "0 0 24px", fontSize: 18, fontWeight: 700, color: theme.text,
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {mode === "edit" ? "Edit Task" : mode === "fork" ? "Fork Task" : "New Task"}
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={labelStyle}>Title</label>
            <input style={inputStyle} placeholder="Task title..." value={form.title}
              onChange={e => set("title", e.target.value)} />
          </div>

          <div>
            <label style={labelStyle}>Prompt *</label>
            <textarea style={{ ...inputStyle, height: 100, resize: "vertical" }}
              placeholder="The prompt to send to Claude Code..."
              value={form.prompt} onChange={e => set("prompt", e.target.value)} />
          </div>

          <div>
            <label style={labelStyle}>Images (optional)</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: promptImages.length ? 8 : 0 }}>
              {promptImages.map((img, idx) => (
                <div key={idx} style={{ position: "relative", width: 72, height: 72 }}>
                  <img src={img.preview} alt={img.name} style={{
                    width: 72, height: 72, objectFit: "cover", borderRadius: 6,
                    border: `1px solid ${theme.border}`,
                  }} />
                  <button onClick={() => removeImage(idx)} style={{
                    position: "absolute", top: -6, right: -6, width: 18, height: 18,
                    borderRadius: "50%", border: "none", background: theme.red || "#e74c3c",
                    color: "#fff", fontSize: 11, cursor: "pointer", lineHeight: "18px",
                    padding: 0, display: "flex", alignItems: "center", justifyContent: "center",
                  }}>×</button>
                </div>
              ))}
              <label style={{
                width: 72, height: 72, borderRadius: 6, border: `1px dashed ${theme.border}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", color: theme.textDim, fontSize: 22, flexShrink: 0,
              }}>
                +
                <input type="file" accept="image/*" multiple style={{ display: "none" }}
                  onChange={handleImageSelect} />
              </label>
            </div>
            {promptImages.length > 0 && (
              <div style={{ fontSize: 10, color: theme.textDim }}>
                {promptImages.length} image{promptImages.length > 1 ? "s" : ""} attached
              </div>
            )}
          </div>

          <div>
            <label style={labelStyle}>Working Directory</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input style={{ ...inputStyle, flex: 1 }} placeholder="~/papers" value={form.working_dir}
                onChange={e => set("working_dir", e.target.value)} />
              {window.electronAPI?.selectDirectory && (
                <button onClick={async () => {
                  const dir = await window.electronAPI.selectDirectory();
                  if (dir) set("working_dir", dir);
                }} style={{
                  padding: "8px 14px", borderRadius: 8, cursor: "pointer",
                  border: `1px solid ${theme.border}`, background: theme.bg,
                  color: theme.textMuted, fontSize: 12, fontWeight: 600,
                  whiteSpace: "nowrap", transition: "all 0.15s",
                }}>
                  Browse
                </button>
              )}
            </div>
          </div>

          <div>
            <label style={labelStyle}>Schedule Type</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {["immediate", "delayed", "scheduled_at", "cron"].map(t => (
                <button key={t} onClick={() => set("schedule_type", t)} style={{
                  flex: 1, padding: "8px 12px", borderRadius: 8, cursor: "pointer",
                  border: `1px solid ${form.schedule_type === t ? theme.accent : theme.border}`,
                  background: form.schedule_type === t ? theme.accentGlow : "transparent",
                  color: form.schedule_type === t ? theme.accent : theme.textMuted,
                  fontSize: 12, fontWeight: 600, textTransform: "capitalize",
                  transition: "all 0.15s", minWidth: 100,
                }}>
                  {t === "immediate" ? "⚡ Immediate" :
                   t === "delayed" ? "⏳ Delayed" :
                   t === "scheduled_at" ? "📅 At Time" :
                   "⏲ Cron"}
                </button>
              ))}
            </div>
          </div>

          {form.schedule_type === "delayed" && (
            <div>
              <label style={labelStyle}>Delay (seconds)</label>
              <input type="number" style={inputStyle} value={form.delay_seconds}
                onChange={e => set("delay_seconds", e.target.value)} />
            </div>
          )}

          {form.schedule_type === "scheduled_at" && (
            <div>
              <label style={labelStyle}>Run At (Local Time)</label>
              <input
                type="datetime-local"
                style={inputStyle}
                value={form.scheduled_at}
                onChange={e => { set("scheduled_at", e.target.value); setScheduledAtError(""); }}
              />
              {scheduledAtError && (
                <div style={{ fontSize: 11, color: "#ff5f5f", marginTop: 4 }}>
                  {scheduledAtError}
                </div>
              )}
              <div style={{ fontSize: 10, color: theme.textDim, marginTop: 4 }}>
                Select a specific date and time to execute this task once
              </div>
            </div>
          )}

          {form.schedule_type === "cron" && (
            <>
              <div>
                <label style={labelStyle}>Cron Expression</label>
                <input style={inputStyle} placeholder="*/30 * * * *" value={form.cron_expr}
                  onChange={e => set("cron_expr", e.target.value)} />
                <div style={{ fontSize: 10, color: theme.textDim, marginTop: 4 }}>
                  e.g. "0 9 * * *" = daily 9am, "*/30 * * * *" = every 30 min
                </div>
              </div>
              <div>
                <label style={labelStyle}>Max Runs (empty = unlimited)</label>
                <input type="number" style={inputStyle} value={form.max_runs}
                  onChange={e => set("max_runs", e.target.value)} />
              </div>
            </>
          )}

          <div>
            <label style={labelStyle}>Tags (comma separated)</label>
            <input style={inputStyle} placeholder="paper, review, arxiv" value={form.tags}
              onChange={e => set("tags", e.target.value)} />
          </div>

          {/* ── DAG Dependencies ── */}
          <div>
            <label style={labelStyle}>Dependencies (optional)</label>
            <div style={{ fontSize: 10, color: theme.textDim, marginBottom: 8 }}>
              This task will be blocked until all upstream tasks complete.
            </div>
            {depRows.map((row, idx) => (
              <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                <input
                  type="number"
                  placeholder="Task ID"
                  value={row._input || ""}
                  onChange={e => {
                    const val = e.target.value;
                    const parsed = parseInt(val);
                    setDepRows(prev => prev.map((r, i) => i === idx
                      ? { ...r, _input: val, task_id: isNaN(parsed) ? null : parsed }
                      : r));
                  }}
                  style={{ ...inputStyle, width: 100, flex: "none" }}
                />
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: theme.textMuted, cursor: "pointer", flex: 1 }}>
                  <input
                    type="checkbox"
                    checked={row.inject_result}
                    onChange={e => setDepRows(prev => prev.map((r, i) => i === idx ? { ...r, inject_result: e.target.checked } : r))}
                    style={{ accentColor: theme.accent }}
                  />
                  Inject result into prompt
                </label>
                <button onClick={() => setDepRows(prev => prev.filter((_, i) => i !== idx))}
                  style={{ background: "transparent", border: "none", color: theme.red, cursor: "pointer", fontSize: 16, padding: "0 4px" }}>
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={() => setDepRows(prev => [...prev, { task_id: null, inject_result: false, _input: "" }])}
              style={{
                padding: "5px 12px", borderRadius: 6, border: `1px dashed ${theme.border}`,
                background: "transparent", color: theme.textMuted, cursor: "pointer",
                fontSize: 11, fontWeight: 600,
              }}
            >
              + Add dependency
            </button>
          </div>

          <div>
            <label style={labelStyle}>DAG ID (optional)</label>
            <input style={inputStyle} placeholder="my-pipeline" value={form.dag_id}
              onChange={e => set("dag_id", e.target.value)} />
            <div style={{ fontSize: 10, color: theme.textDim, marginTop: 4 }}>
              Group tasks into a named workflow
            </div>
          </div>

          <div>
            <label style={labelStyle}>Agent</label>
            <select style={inputStyle} value={form.agent} onChange={e => set("agent", e.target.value)}>
              <option value="claude">Claude Code (claude CLI)</option>
              <option value="codex">Codex CLI (openai/codex)</option>
            </select>
          </div>

        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 28, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{
            padding: "10px 20px", borderRadius: 8, border: `1px solid ${theme.border}`,
            background: "transparent", color: theme.textMuted, cursor: "pointer",
            fontSize: 13, fontWeight: 600,
          }}>
            Cancel
          </button>
          <button onClick={handleSubmit} style={{
            padding: "10px 24px", borderRadius: 8, border: "none",
            background: theme.accent, color: "#fff", cursor: "pointer",
            fontSize: 13, fontWeight: 600,
            boxShadow: `0 0 20px ${theme.accentGlow}`,
          }}>
            {mode === "edit" ? "Save Changes" : mode === "fork" ? "Create Fork" : "Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailPanel({ task, onClose, onRespond, onResume }) {
  if (!task) return null;
  const cfg = getStatusConfig()[task.status] || getStatusConfig().pending;
  const [liveOutput, setLiveOutput] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [resumeError, setResumeError] = useState("");
  const [resumeSent, setResumeSent] = useState(false);
  const [messages, setMessages] = useState([]);
  const [events, setEvents] = useState([]);
  const [showMessages, setShowMessages] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showLiveOutput, setShowLiveOutput] = useState(true);
  const liveOutputRef = useRef(null);
  const messagesRef = useRef(null);
  const eventsRef = useRef(null);

  useEffect(() => {
    if (task.status !== "running") {
      setLiveOutput("");
      return;
    }
    let cancelled = false;
    let lastOutputLength = 0;
    const poll = async () => {
      try {
        const res = await fetch(`${API}/tasks/${task.id}/output`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          const currentOutput = data.output || "";
          // 增量更新：只添加新内容
          if (currentOutput.length > lastOutputLength) {
            const newContent = currentOutput.slice(lastOutputLength);
            setLiveOutput(prev => prev + newContent);
            lastOutputLength = currentOutput.length;
          }
        }
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 1000); // 缩短轮询间隔到1秒
    return () => { cancelled = true; clearInterval(interval); };
  }, [task.id, task.status]);

  useEffect(() => {
    if (liveOutputRef.current) {
      liveOutputRef.current.scrollTop = liveOutputRef.current.scrollHeight;
    }
  }, [liveOutput]);

  useEffect(() => {
    if (showMessages) {
      fetchTaskMessages(task.id).then(setMessages);
    }
  }, [task.id, showMessages]);

  useEffect(() => {
    if (showEvents) {
      fetchTaskEvents(task.id).then(setEvents);
    }
  }, [task.id, showEvents]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (eventsRef.current) {
      eventsRef.current.scrollTop = eventsRef.current.scrollHeight;
    }
  }, [events]);

  const handleResume = async () => {
    if (!resumeText.trim()) return;
    setResumeError("");
    const result = await resumeTask(task.id, resumeText.trim());
    if (result.error) {
      setResumeError(result.error);
    } else {
      setResumeText("");
      setResumeSent(true);
      setTimeout(() => setResumeSent(false), 3000);
      onResume();
    }
  };

  return (
    <div style={{
      position: "fixed", right: 0, top: 0, bottom: 0, width: 480,
      background: theme.surface, borderLeft: `1px solid ${theme.border}`,
      zIndex: 999, overflow: "auto", padding: 28,
      boxShadow: "-8px 0 40px rgba(0,0,0,0.4)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <Badge status={task.status} />
        <button onClick={onClose} style={{
          background: "transparent", border: "none", color: theme.textMuted,
          fontSize: 20, cursor: "pointer",
        }}>×</button>
      </div>

      <h2 style={{
        fontSize: 18, fontWeight: 700, color: theme.text, margin: "0 0 8px",
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        {task.title}
      </h2>

      <div style={{ fontSize: 11, color: theme.textDim, marginBottom: 24, fontFamily: "monospace" }}>
        ID: {task.id} · Created: {formatTaskDateTime(task.created_at)}
      </div>

      <Section title="Prompt">
        <pre style={{
          background: theme.bg, border: `1px solid ${theme.border}`,
          borderRadius: 8, padding: 14, fontSize: 12, color: theme.text,
          whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0,
          fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.6,
        }}>
          {task.prompt}
        </pre>
        {task.prompt_images && task.prompt_images.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 10, color: theme.textMuted, fontWeight: 600, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 8 }}>
              Attached Images ({task.prompt_images.length})
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {task.prompt_images.map((img, i) => (
                <img key={i} src={`data:${img.media_type};base64,${img.data}`} alt={img.name || `image ${i+1}`}
                  style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 6, border: `1px solid ${theme.border}` }} />
              ))}
            </div>
          </div>
        )}
      </Section>

      <Section title="Configuration">
        <InfoRow label="Working Dir" value={task.working_dir} />
        <InfoRow label="Agent" value={task.agent || "claude"} />
        <InfoRow label="Schedule" value={task.schedule_type} />
        {task.cron_expr && <InfoRow label="Cron" value={task.cron_expr} />}
        {task.delay_seconds && <InfoRow label="Delay" value={`${task.delay_seconds}s`} />}
        {task.next_run_at && <InfoRow label="Next Run" value={formatTaskDateTime(task.next_run_at)} />}
        <InfoRow label="Runs" value={`${task.run_count}${task.max_runs ? ` / ${task.max_runs}` : ""}`} />
        {task.dag_id && <InfoRow label="DAG" value={task.dag_id} />}
      </Section>

      {/* DAG dependency info */}
      {task.dependencies && task.dependencies.length > 0 && (
        <Section title="Upstream Dependencies">
          {task.dependencies.map(dep => (
            <div key={dep.id} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "5px 0", borderBottom: `1px solid ${theme.border}`, fontSize: 12,
            }}>
              <span style={{ color: theme.text, fontFamily: "monospace" }}>
                #{dep.depends_on_task_id}
                {dep.depends_on_title ? ` — ${dep.depends_on_title}` : ""}
              </span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {dep.inject_result ? (
                  <span style={{ fontSize: 10, color: theme.accent }}>↳ inject</span>
                ) : null}
                <span style={{
                  fontSize: 10, fontWeight: 600,
                  color: dep.depends_on_status === "completed" ? theme.green :
                         dep.depends_on_status === "failed" ? theme.red : theme.orange,
                }}>
                  {dep.depends_on_status}
                </span>
              </div>
            </div>
          ))}
        </Section>
      )}

      {task.dependents && task.dependents.length > 0 && (
        <Section title="Downstream Tasks">
          <div style={{ fontSize: 12, color: theme.textMuted, fontFamily: "monospace" }}>
            {task.dependents.map(id => `#${id}`).join(", ")}
          </div>
        </Section>
      )}

      {task.status === "running" && (
        <Section title={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>Live Output</span>
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              fontSize: 10, color: theme.blue,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: "50%",
                background: theme.blue,
                animation: "pulse 1.2s ease-in-out infinite",
              }} />
              live
            </div>
          </div>
        }>
          <div style={{
            background: theme.bg, border: `1px solid ${theme.borderActive}`,
            borderRadius: 8, overflow: "hidden",
          }}>
            {/* 工具栏 */}
            <div style={{
              display: "flex", justifyContent: "space-between",
              alignItems: "center", padding: "8px 12px",
              background: theme.surface, borderBottom: `1px solid ${theme.border}`,
              fontSize: 11, color: theme.textMuted,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button
                  onClick={() => setShowLiveOutput(!showLiveOutput)}
                  style={{
                    background: "transparent", border: "none",
                    color: theme.textMuted, fontSize: 11, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 4,
                  }}
                >
                  {showLiveOutput ? "▼" : "▶"} {showLiveOutput ? "Hide" : "Show"}
                </button>
                <span style={{ fontFamily: "monospace" }}>
                  {liveOutput.length.toLocaleString()} chars
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(liveOutput);
                  }}
                  style={{
                    background: "transparent", border: "none",
                    color: theme.textMuted, fontSize: 11, cursor: "pointer",
                    padding: "4px 8px", borderRadius: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  📋 Copy
                </button>
                <button
                  onClick={() => setLiveOutput("")}
                  style={{
                    background: "transparent", border: "none",
                    color: theme.textMuted, fontSize: 11, cursor: "pointer",
                    padding: "4px 8px", borderRadius: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  🗑️ Clear
                </button>
              </div>
            </div>

            {/* 输出内容区域 */}
            {showLiveOutput && (
              <div style={{
                maxHeight: 400, overflow: "auto",
                position: "relative",
              }} ref={liveOutputRef}>
                <pre style={{
                  fontSize: 12, color: theme.text, whiteSpace: "pre-wrap",
                  wordBreak: "break-word", margin: 0, padding: 14,
                  fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.6,
                  minHeight: 60,
                }}>
                  {liveOutput ? (
                    <FormattedOutput content={liveOutput} theme={theme} />
                  ) : (
                    <span style={{ color: theme.textDim, fontStyle: "italic" }}>
                      Waiting for agent output...
                    </span>
                  )}
                </pre>
              </div>
            )}
          </div>
        </Section>
      )}


      {task.result && (
        <Section title="Result">
          <pre style={{
            background: theme.bg, border: `1px solid ${theme.border}`,
            borderRadius: 8, padding: 14, fontSize: 12, color: theme.green,
            whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0,
            fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.6,
            maxHeight: 300, overflow: "auto",
          }}>
            {task.result}
          </pre>
        </Section>
      )}

      {task.error && (
        <Section title="Error">
          <pre style={{
            background: theme.redBg, border: `1px solid rgba(248,113,113,0.2)`,
            borderRadius: 8, padding: 14, fontSize: 12, color: theme.red,
            whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0,
            fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.6,
          }}>
            {task.error}
          </pre>
        </Section>
      )}

      {/* Output History Tabs */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => { setShowMessages(!showMessages); setShowEvents(false); }}
            style={{
              flex: 1, padding: "8px 12px", borderRadius: 8,
              background: showMessages ? theme.accentGlow : theme.surface,
              color: showMessages ? theme.accent : theme.textMuted,
              fontSize: 11, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${showMessages ? theme.accent : theme.border}`,
              transition: "all 0.15s",
            }}
          >
            Conversation
          </button>
          <button
            onClick={() => { setShowEvents(!showEvents); setShowMessages(false); }}
            style={{
              flex: 1, padding: "8px 12px", borderRadius: 8,
              background: showEvents ? theme.accentGlow : theme.surface,
              color: showEvents ? theme.accent : theme.textMuted,
              fontSize: 11, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${showEvents ? theme.accent : theme.border}`,
              transition: "all 0.15s",
            }}
          >
            Output Events
          </button>
        </div>

        {/* Conversation History */}
        {showMessages && (
          <div
            ref={messagesRef}
            style={{
              maxHeight: 400, overflow: "auto",
              display: "flex", flexDirection: "column", gap: 8,
            }}
          >
            {messages.length === 0 ? (
              <div style={{ fontSize: 12, color: theme.textDim, padding: "12px 0", textAlign: "center" }}>
                No conversation data — only tasks run after this feature was added have logs.
              </div>
            ) : messages.map((msg, i) => (
              <div key={i} style={{
                background: msg.role === "user" ? theme.accentGlow : theme.bg,
                border: `1px solid ${msg.role === "user" ? theme.accent + "33" : theme.border}`,
                borderRadius: 8, padding: "10px 14px",
                borderLeft: `3px solid ${msg.role === "user" ? theme.accent : theme.green}`,
              }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
                  color: msg.role === "user" ? theme.accent : theme.green,
                  textTransform: "uppercase", marginBottom: 6,
                }}>
                  {msg.role}
                </div>
                <pre style={{
                  fontSize: 12, color: theme.text, whiteSpace: "pre-wrap",
                  wordBreak: "break-word", margin: 0,
                  fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.6,
                  maxHeight: 200, overflow: "auto",
                }}>
                  {msg.text}
                </pre>
              </div>
            ))}
          </div>
        )}

        {/* Output Events History */}
        {showEvents && (
          <div
            ref={eventsRef}
            style={{
              maxHeight: 400, overflow: "auto",
              display: "flex", flexDirection: "column", gap: 6,
            }}
          >
            {events.length === 0 ? (
              <div style={{ fontSize: 12, color: theme.textDim, padding: "12px 0", textAlign: "center" }}>
                No output events recorded — events are recorded for new task runs.
              </div>
            ) : events.map((event, i) => (
              <div key={i} style={{
                background: theme.bg,
                border: `1px solid ${theme.border}`,
                borderRadius: 6, padding: "8px 12px",
                fontSize: 11,
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{
                    color: getEventTypeColor(event.event_type),
                    fontWeight: 600,
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}>
                    {event.event_type}
                  </span>
                  <span style={{ color: theme.textDim, fontSize: 9 }}>
                    {formatTaskTime(event.timestamp)}
                  </span>
                </div>
                <div style={{
                  color: theme.text,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  lineHeight: 1.4,
                  maxHeight: 200,
                  overflow: "auto",
                }}>
                  <EventContent content={event.content} eventType={event.event_type} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Resume completed/failed session */}
      {["completed", "failed"].includes(task.status) && task.session_id && (
        <Section title="Resume Session">
          <div style={{ fontSize: 11, color: theme.textDim, marginBottom: 10, fontFamily: "monospace" }}>
            Session: {task.session_id}
          </div>
          <textarea
            placeholder="Send a follow-up message to continue this conversation…"
            value={resumeText}
            onChange={e => setResumeText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleResume(); }}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: 8,
              border: `1px solid ${theme.border}`, background: theme.bg,
              color: theme.text, fontSize: 13, outline: "none", boxSizing: "border-box",
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              resize: "vertical", minHeight: 80,
            }}
          />
          {resumeError && (
            <div style={{ fontSize: 11, color: theme.red, marginTop: 6 }}>{resumeError}</div>
          )}
          {resumeSent && (
            <div style={{ fontSize: 12, color: theme.green, marginTop: 6 }}>
              ✨ 已发送！任务正在重新唤醒，请稍候~
            </div>
          )}
          <button
            onClick={handleResume}
            style={{
              marginTop: 10, padding: "8px 20px", borderRadius: 8, border: "none",
              background: theme.accent, color: "#fff", cursor: "pointer",
              fontSize: 13, fontWeight: 600,
              boxShadow: `0 0 20px ${theme.accentGlow}`,
            }}
          >
            ↩ Resume (⌘↵)
          </button>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: theme.textDim,
        letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 10,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", padding: "6px 0",
      borderBottom: `1px solid ${theme.border}`, fontSize: 12,
    }}>
      <span style={{ color: theme.textMuted }}>{label}</span>
      <span style={{ color: theme.text, fontFamily: "monospace" }}>{value}</span>
    </div>
  );
}

function getEventTypeColor(eventType) {
  switch (eventType) {
    case "user": return theme.accent;
    case "assistant": return theme.green;
    case "result": return theme.green;
    case "error": return theme.red;
    case "text": return theme.blue;
    case "image_content": return theme.accent;
    default: return theme.textMuted;
  }
}

function SettingsModal({ onClose, timeout: initialTimeout, defaultAgent: initialDefaultAgent, onSave, feishu: initialFeishu, onFeishuSave, channelsStatus: initialChannelsStatus, onChannelsSave }) {
  const [tab, setTab] = useState("general");
  const [timeout, setTimeout] = useState(initialTimeout ?? 600);
  const [defaultAgent, setDefaultAgent] = useState(initialDefaultAgent ?? "claude");
  const [feishu, setFeishu] = useState({
    feishu_app_id: "",
    feishu_app_secret: "",
    feishu_default_chat_id: "",
    feishu_default_working_dir: "~",
    feishu_enabled: "false",
    ...initialFeishu,
  });
  const [feishuSaving, setFeishuSaving] = useState(false);
  const [feishuMsg, setFeishuMsg] = useState(null); // {ok, text}
  const [channels, setChannels] = useState(createInitialChannelsState(initialChannelsStatus));
  const [channelsSaving, setChannelsSaving] = useState(false);
  const [channelsMsg, setChannelsMsg] = useState(null);
  const [weixinQrSrc, setWeixinQrSrc] = useState("");
  const [weixinActionBusy, setWeixinActionBusy] = useState(false);
  const [collapsedChannels, setCollapsedChannels] = useState({
    telegram: true,
    slack: true,
    weixin: true,
  });

  // Refresh all channel settings when the modal opens so bot-side /dir changes are visible
  useEffect(() => {
    let cancelled = false;
    const refreshChannels = async () => {
      const status = await fetchChannelsStatus();
      if (!cancelled) {
        setChannels(c => mergeChannelsStatus(c, status));
      }
    };
    refreshChannels();
    const intervalId = setInterval(refreshChannels, 2000);
    fetchFeishuSettings().then(s => {
      if (s && Object.keys(s).length) setFeishu(f => ({ ...f, ...s }));
    });
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const qrValue = channels.weixin?.qr_code_url || "";
    if (!qrValue) {
      setWeixinQrSrc("");
      return () => {
        cancelled = true;
      };
    }

    if (isWeixinQrImageSource(qrValue)) {
      setWeixinQrSrc(qrValue);
      return () => {
        cancelled = true;
      };
    }

    QRCode.toDataURL(qrValue, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 440,
    })
      .then((dataUrl) => {
        if (!cancelled) setWeixinQrSrc(dataUrl);
      })
      .catch((error) => {
        console.error("Failed to generate Weixin QR code", error);
        if (!cancelled) setWeixinQrSrc("");
      });

    return () => {
      cancelled = true;
    };
  }, [channels.weixin?.qr_code_url]);

  const handleWeixinAction = async (action) => {
    setWeixinActionBusy(true);
    setChannelsMsg(null);
    try {
      await runWeixinAction(action);
      const updated = await fetchChannelsStatus();
      setChannels(c => mergeChannelsStatus(c, updated));
      if (onChannelsSave) onChannelsSave(updated);
      setChannelsMsg({
        ok: true,
        text: action === "logout" ? "Wechat logged out." : "Wechat login restarted.",
      });
    } catch (e) {
      setChannelsMsg({ ok: false, text: String(e) });
    } finally {
      setWeixinActionBusy(false);
    }
  };

  const handleSaveGeneral = async () => {
    await updateSettings({ timeout: parseInt(timeout) || 600, default_agent: defaultAgent });
    onSave(parseInt(timeout) || 600, defaultAgent);
    onClose();
  };

  const handleSaveFeishu = async () => {
    setFeishuSaving(true);
    setFeishuMsg(null);
    try {
      await updateFeishuSettings(feishu);
      setFeishuMsg({ ok: true, text: "Saved. Bridge restarted." });
      // Reload settings after save
      if (onFeishuSave) {
        const updated = await fetchFeishuSettings();
        onFeishuSave(updated);
      }
    } catch (e) {
      setFeishuMsg({ ok: false, text: String(e) });
    } finally {
      setFeishuSaving(false);
    }
  };

  const handleSaveChannels = async () => {
    setChannelsSaving(true);
    setChannelsMsg(null);
    try {
      await updateChannelsSettings(buildChannelsSavePayload(channels));
      // Reload channel status after save to reflect new running state
      const updated = await fetchChannelsStatus();
      setChannels(c => mergeChannelsStatus(c, updated));
      if (onChannelsSave) onChannelsSave(updated);
      setChannelsMsg({ ok: true, text: "Saved. Channels restarted." });
    } catch (e) {
      setChannelsMsg({ ok: false, text: String(e) });
    } finally {
      setChannelsSaving(false);
    }
  };

  const fieldStyle = {
    width: "100%", padding: "10px 14px", borderRadius: 8,
    border: `1px solid ${theme.border}`, background: theme.bg,
    color: theme.text, fontSize: 13, outline: "none", boxSizing: "border-box",
    fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
  };
  const labelStyle = {
    fontSize: 11, fontWeight: 600, color: theme.textMuted,
    letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 8, display: "block",
  };
  const hintStyle = { fontSize: 10, color: theme.textDim, marginTop: 4 };

  const tabs = ["general", "channels", "feishu"];
  const tabLabel = { general: "General", channels: "Channels", feishu: "Feishu / Lark" };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, backdropFilter: "blur(8px)",
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: theme.surface, border: `1px solid ${theme.border}`,
        borderRadius: 16, padding: 32, width: 480,
        maxHeight: "85vh", overflowY: "auto",
        boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
      }}>
        <h2 style={{
          margin: "0 0 20px", fontSize: 18, fontWeight: 700, color: theme.text,
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          Settings
        </h2>

        {/* Tab bar */}
        <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: `1px solid ${theme.border}`, paddingBottom: 0 }}>
          {tabs.map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "7px 16px", borderRadius: "8px 8px 0 0",
              border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
              background: tab === t ? theme.bg : "transparent",
              color: tab === t ? theme.text : theme.textMuted,
              borderBottom: tab === t ? `2px solid ${theme.accent}` : "2px solid transparent",
              marginBottom: -1,
            }}>
              {tabLabel[t]}
            </button>
          ))}
        </div>

        {/* ── General tab ── */}
        {tab === "general" && (
          <>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Task Timeout (seconds)</label>
              <input
                type="number" min="10" step="10"
                value={timeout}
                onChange={e => setTimeout(e.target.value)}
                style={fieldStyle}
              />
              <div style={hintStyle}>Default: 600s (10 min). Max time before a running task is killed.</div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Default Agent</label>
              <select value={defaultAgent} onChange={e => setDefaultAgent(e.target.value)} style={fieldStyle}>
                <option value="claude">Claude Code (claude CLI)</option>
                <option value="codex">Codex CLI (openai/codex)</option>
              </select>
              <div style={hintStyle}>Agent used for new tasks unless overridden per-task.</div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={{
                padding: "10px 20px", borderRadius: 8, border: `1px solid ${theme.border}`,
                background: "transparent", color: theme.textMuted, cursor: "pointer",
                fontSize: 13, fontWeight: 600,
              }}>Cancel</button>
              <button onClick={handleSaveGeneral} style={{
                padding: "10px 24px", borderRadius: 8, border: "none",
                background: theme.accent, color: "#fff", cursor: "pointer",
                fontSize: 13, fontWeight: 600,
                boxShadow: `0 0 20px ${theme.accentGlow}`,
              }}>Save</button>
            </div>
          </>
        )}

        {/* ── Channels tab ── */}
        {tab === "channels" && (
          <>
            {/* ── Telegram ── */}
            {(() => {
              const ch = channels.telegram;
              const collapsed = collapsedChannels.telegram;
              const statusDot = ch.running
                ? { bg: theme.green, label: "Connected" }
                : ch.configured
                  ? { bg: theme.yellow || "#f59e0b", label: "Configured (not running)" }
                  : { bg: theme.textDim, label: "Not configured" };
              return (
                <div style={{ marginBottom: 16, borderRadius: 10, border: `1px solid ${theme.border}`, background: theme.bg, overflow: "hidden" }}>
                  {/* Header row - clickable to collapse */}
                  <div
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", cursor: "pointer", userSelect: "none" }}
                    onClick={() => setCollapsedChannels(c => ({ ...c, telegram: !c.telegram }))}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 10, color: theme.textMuted, transition: "transform 0.2s", transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", display: "inline-block" }}>{"▼"}</span>
                      <span style={{ display: "inline-flex", width: 22, height: 22, alignItems: "center", justifyContent: "center", color: "#2AABEE", flexShrink: 0 }}>
                        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
                          <path d="M21.4 4.6a1.2 1.2 0 0 0-1.24-.2L3.8 11.15c-.6.25-.57 1.12.05 1.33l4.6 1.62 1.62 4.6c.22.62 1.08.65 1.33.05l6.75-16.36a1.2 1.2 0 0 0-.2-1.24 1.18 1.18 0 0 0-1.22-.3Z" />
                        </svg>
                      </span>
                      <span style={{ fontWeight: 700, fontSize: 14, color: theme.text }}>Telegram</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusDot.bg, display: "inline-block", boxShadow: ch.running ? `0 0 6px ${statusDot.bg}` : "none" }} />
                        <span style={{ fontSize: 11, color: theme.textMuted }}>{statusDot.label}</span>
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); setChannels(c => ({ ...c, telegram: { ...c.telegram, enabled: !c.telegram.enabled } })); }}
                      style={{
                        width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
                        background: ch.enabled ? theme.accent : theme.border,
                        position: "relative", transition: "background 0.2s", flexShrink: 0,
                      }}
                    >
                      <span style={{
                        position: "absolute", top: 3, width: 18, height: 18, borderRadius: "50%",
                        background: "#fff", transition: "left 0.2s",
                        left: ch.enabled ? 23 : 3,
                      }} />
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
                          onChange={e => setChannels(c => ({ ...c, telegram: { ...c.telegram, bot_token: e.target.value } }))}
                          placeholder="123456:ABC-DEF..."
                          style={fieldStyle}
                        />
                        <div style={hintStyle}>Token from @BotFather</div>
                      </div>

                      <div style={{ marginBottom: 12 }}>
                        <label style={labelStyle}>Allowed User IDs</label>
                        <input
                          value={ch.allowed_users}
                          onChange={e => setChannels(c => ({ ...c, telegram: { ...c.telegram, allowed_users: e.target.value } }))}
                          placeholder="123456789,987654321 (optional)"
                          style={fieldStyle}
                        />
                        <div style={hintStyle}>Comma-separated numeric Telegram user IDs. Leave empty to allow all.</div>
                      </div>

                      <div style={{ marginBottom: 12 }}>
                        <label style={labelStyle}>Default Working Directory</label>
                        <input
                          value={ch.default_working_dir}
                          onChange={e => setChannels(c => ({ ...c, telegram: { ...c.telegram, default_working_dir: e.target.value } }))}
                          placeholder="~/my-project"
                          style={fieldStyle}
                        />
                        <div style={hintStyle}>Working directory for tasks created via the Telegram bot.</div>
                      </div>

                      <div style={{ marginBottom: 12 }}>
                        <label style={labelStyle}>Default Notification Chat ID</label>
                        <input
                          value={ch.default_chat_id}
                          onChange={e => setChannels(c => ({ ...c, telegram: { ...c.telegram, default_chat_id: e.target.value } }))}
                          placeholder="-1001234567890 or 123456789"
                          style={fieldStyle}
                        />
                        <div style={hintStyle}>Fallback chat for notifications from UI-created tasks (group or user chat ID).</div>
                      </div>

                      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: "10px 12px", fontSize: 11, fontFamily: "monospace", color: theme.textMuted, lineHeight: 1.8 }}>
                        <div style={{ color: theme.textDim, marginBottom: 4 }}>Bot commands:</div>
                        {["/newtask <title> | <prompt>", "/list", "/status <id>", "/cancel <id>"].map(cmd => <div key={cmd}><span style={{ color: theme.cyan }}>{cmd}</span></div>)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* ── Slack ── */}
            {(() => {
              const ch = channels.slack;
              const collapsed = collapsedChannels.slack;
              const statusDot = ch.running
                ? { bg: theme.green, label: "Connected" }
                : ch.configured
                  ? { bg: theme.yellow || "#f59e0b", label: "Configured (not running)" }
                  : { bg: theme.textDim, label: "Not configured" };
              return (
                <div style={{ marginBottom: 16, borderRadius: 10, border: `1px solid ${theme.border}`, background: theme.bg, overflow: "hidden" }}>
                  {/* Header row - clickable to collapse */}
                  <div
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", cursor: "pointer", userSelect: "none" }}
                    onClick={() => setCollapsedChannels(c => ({ ...c, slack: !c.slack }))}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 10, color: theme.textMuted, transition: "transform 0.2s", transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", display: "inline-block" }}>{"▼"}</span>
                      <span style={{ display: "inline-flex", width: 22, height: 22, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                          <path fill="#36C5F0" d="M10.1 3.2A2.2 2.2 0 0 1 12.2 1h.7v5.1h-2.8V3.2Z"/>
                          <path fill="#2EB67D" d="M20.8 10.1A2.2 2.2 0 0 1 23 12.2v.7h-5.1v-2.8h2.9Z"/>
                          <path fill="#ECB22E" d="M13.9 20.8A2.2 2.2 0 0 1 11.8 23h-.7v-5.1h2.8v2.9Z"/>
                          <path fill="#E01E5A" d="M3.2 13.9A2.2 2.2 0 0 1 1 11.8v-.7h5.1v2.8H3.2Z"/>
                          <path fill="#36C5F0" d="M13.2 4.3a2.7 2.7 0 1 1 5.4 0 2.7 2.7 0 0 1-5.4 0Z"/>
                          <path fill="#2EB67D" d="M16.9 13.2a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4Z"/>
                          <path fill="#ECB22E" d="M5.4 16.9a2.7 2.7 0 1 1 5.4 0 2.7 2.7 0 0 1-5.4 0Z"/>
                          <path fill="#E01E5A" d="M4.3 5.4a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4Z"/>
                        </svg>
                      </span>
                      <span style={{ fontWeight: 700, fontSize: 14, color: theme.text }}>Slack</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusDot.bg, display: "inline-block", boxShadow: ch.running ? `0 0 6px ${statusDot.bg}` : "none" }} />
                        <span style={{ fontSize: 11, color: theme.textMuted }}>{statusDot.label}</span>
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); setChannels(c => ({ ...c, slack: { ...c.slack, enabled: !c.slack.enabled } })); }}
                      style={{
                        width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
                        background: ch.enabled ? theme.accent : theme.border,
                        position: "relative", transition: "background 0.2s", flexShrink: 0,
                      }}
                    >
                      <span style={{
                        position: "absolute", top: 3, width: 18, height: 18, borderRadius: "50%",
                        background: "#fff", transition: "left 0.2s",
                        left: ch.enabled ? 23 : 3,
                      }} />
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
                          onChange={e => setChannels(c => ({ ...c, slack: { ...c.slack, bot_token: e.target.value } }))}
                          placeholder="xoxb-..."
                          style={fieldStyle}
                        />
                        <div style={hintStyle}>Bot token from OAuth & Permissions</div>
                      </div>

                      <div style={{ marginBottom: 12 }}>
                        <label style={labelStyle}>App Token</label>
                        <input
                          type="password"
                          value={ch.app_token}
                          onChange={e => setChannels(c => ({ ...c, slack: { ...c.slack, app_token: e.target.value } }))}
                          placeholder="xapp-..."
                          style={fieldStyle}
                        />
                        <div style={hintStyle}>App-level token for Socket Mode</div>
                      </div>

                      <div style={{ marginBottom: 12 }}>
                        <label style={labelStyle}>Default Working Directory</label>
                        <input
                          value={ch.default_working_dir}
                          onChange={e => setChannels(c => ({ ...c, slack: { ...c.slack, default_working_dir: e.target.value } }))}
                          placeholder="~/my-project"
                          style={fieldStyle}
                        />
                        <div style={hintStyle}>Working directory for tasks created via the Slack bot.</div>
                      </div>

                      <div style={{ marginBottom: 12 }}>
                        <label style={labelStyle}>Default DM User</label>
                        <input
                          value={ch.default_user}
                          onChange={e => setChannels(c => ({ ...c, slack: { ...c.slack, default_user: e.target.value } }))}
                          placeholder="U0123456789"
                          style={fieldStyle}
                        />
                        <div style={hintStyle}>Slack user ID to DM when tasks have no origin thread (e.g. subtasks created via API). Find your ID in Slack profile → ⋯ → Copy member ID.</div>
                      </div>

                      <div style={{ marginBottom: 12 }}>
                        <label style={labelStyle}>Default Notification Channel</label>
                        <input
                          value={ch.default_channel}
                          onChange={e => setChannels(c => ({ ...c, slack: { ...c.slack, default_channel: e.target.value } }))}
                          placeholder="#general or C0123456789"
                          style={fieldStyle}
                        />
                        <div style={hintStyle}>Optional. Fallback channel if Default DM User is not set.</div>
                      </div>

                      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: "10px 12px", fontSize: 11, fontFamily: "monospace", color: theme.textMuted, lineHeight: 1.8 }}>
                        <div style={{ color: theme.textDim, marginBottom: 4 }}>Bot commands:</div>
                        {["newtask <title> | <prompt>", "list", "status <id>", "cancel <id>", "help"].map(cmd => <div key={cmd}><span style={{ color: theme.cyan }}>{cmd}</span></div>)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* ── Weixin ── */}
            {(() => {
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
                <div style={{ marginBottom: 16, borderRadius: 10, border: `1px solid ${theme.border}`, background: theme.bg, overflow: "hidden" }}>
                  <div
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", cursor: "pointer", userSelect: "none" }}
                    onClick={() => setCollapsedChannels(c => ({ ...c, weixin: !c.weixin }))}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 10, color: theme.textMuted, transition: "transform 0.2s", transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", display: "inline-block" }}>{"▼"}</span>
                      <span style={{ display: "inline-flex", width: 22, height: 22, alignItems: "center", justifyContent: "center", color: "#07C160", flexShrink: 0 }}>
                        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
                          <path d="M9.2 4.2c-4 0-7.2 2.6-7.2 5.9 0 1.9 1.1 3.6 2.9 4.7l-.9 2.5 2.9-1.5c.7.1 1.4.2 2.2.2 4 0 7.2-2.6 7.2-5.9S13.2 4.2 9.2 4.2Zm-2.7 4.8a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Zm5.4 0a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z" />
                          <path d="M16.8 9.1c-3 0-5.5 2-5.5 4.5 0 2.5 2.4 4.5 5.5 4.5.6 0 1.2-.1 1.8-.2l2.4 1.2-.7-2c1.5-.8 2.5-2.1 2.5-3.6 0-2.5-2.4-4.4-5.5-4.4Zm-1.9 4a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4Zm3.8 0a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4Z" opacity="0.88" />
                        </svg>
                      </span>
                      <span style={{ fontWeight: 700, fontSize: 14, color: theme.text }}>Wechat</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusDot.bg, display: "inline-block", boxShadow: ch.running ? `0 0 6px ${statusDot.bg}` : "none" }} />
                        <span style={{ fontSize: 11, color: theme.textMuted }}>{statusDot.label}</span>
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); setChannels(c => ({ ...c, weixin: { ...c.weixin, enabled: !c.weixin.enabled } })); }}
                      style={{
                        width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
                        background: ch.enabled ? theme.accent : theme.border,
                        position: "relative", transition: "background 0.2s", flexShrink: 0,
                      }}
                    >
                      <span style={{
                        position: "absolute", top: 3, width: 18, height: 18, borderRadius: "50%",
                        background: "#fff", transition: "left 0.2s",
                        left: ch.enabled ? 23 : 3,
                      }} />
                    </button>
                  </div>

                  {!collapsed && (
                    <div style={{ padding: "0 16px 16px" }}>
                      <div style={{ marginBottom: 12 }}>
                        <label style={labelStyle}>Default Working Directory</label>
                        <input
                          value={ch.default_working_dir}
                          onChange={e => setChannels(c => ({ ...c, weixin: { ...c.weixin, default_working_dir: e.target.value } }))}
                          placeholder="~/my-project"
                          style={fieldStyle}
                        />
                        <div style={hintStyle}>Working directory for tasks created from incoming Weixin messages.</div>
                      </div>

                      <div style={{ marginBottom: 12 }}>
                        <label style={labelStyle}>Base URL</label>
                        <input
                          value={ch.base_url}
                          onChange={e => setChannels(c => ({ ...c, weixin: { ...c.weixin, base_url: e.target.value } }))}
                          placeholder="https://ilinkai.weixin.qq.com"
                          style={fieldStyle}
                        />
                        <div style={hintStyle}>Gateway API base URL used for QR login, long-polling, and sendmessage.</div>
                      </div>

                      <div style={{ marginBottom: 12 }}>
                        <label style={labelStyle}>Account ID</label>
                        <input
                          value={ch.account_id}
                          onChange={e => setChannels(c => ({ ...c, weixin: { ...c.weixin, account_id: e.target.value } }))}
                          placeholder="Optional fixed account id"
                          style={fieldStyle}
                        />
                        <div style={hintStyle}>Optional. Leave empty to let the bridge adopt the account id returned by QR login.</div>
                      </div>

                      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                        <button
                          onClick={() => handleWeixinAction("reconnect")}
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
                          onClick={() => handleWeixinAction("logout")}
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

                      {(ch.qr_code_url || ch.login_status === "waiting_for_scan" || ch.login_status === "scanned" || ch.last_error) && (
                        <div style={{ marginBottom: 12, borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.surface, padding: 12 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: theme.text, marginBottom: 8 }}>
                            Weixin Login Status
                          </div>
                          <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: ch.qr_code_url ? 10 : 0 }}>
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
                                Open Weixin on your phone and scan this QR code. The status updates automatically.
                              </div>
                            </div>
                          )}
                          {ch.last_error && (
                            <div style={{ marginTop: 10, fontSize: 11, color: theme.red }}>
                              {ch.last_error}
                            </div>
                          )}
                        </div>
                      )}

                      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: "10px 12px", fontSize: 11, fontFamily: "monospace", color: theme.textMuted, lineHeight: 1.8 }}>
                        <div style={{ color: theme.textDim, marginBottom: 4 }}>Notes:</div>
                        {[
                          "Enabling Weixin starts the local bridge process",
                          "First launch without a saved session will trigger QR login",
                          "Reply to a result message to resume the same task session",
                        ].map(note => <div key={note}><span style={{ color: theme.cyan }}>{note}</span></div>)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {channelsMsg && (
              <div style={{ padding: "8px 12px", borderRadius: 8, marginBottom: 16, fontSize: 12, background: channelsMsg.ok ? theme.greenBg : theme.redBg, color: channelsMsg.ok ? theme.green : theme.red, border: `1px solid ${channelsMsg.ok ? theme.green : theme.red}` }}>
                {channelsMsg.text}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={{ padding: "10px 20px", borderRadius: 8, border: `1px solid ${theme.border}`, background: "transparent", color: theme.textMuted, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Close</button>
              <button onClick={handleSaveChannels} disabled={channelsSaving} style={{ padding: "10px 24px", borderRadius: 8, border: "none", background: channelsSaving ? theme.border : theme.accent, color: channelsSaving ? theme.textMuted : "#fff", cursor: channelsSaving ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, boxShadow: channelsSaving ? "none" : `0 0 20px ${theme.accentGlow}` }}>
                {channelsSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}

        {/* ── Feishu tab ── */}
        {tab === "feishu" && (
          <>
            {/* Enable toggle */}
            <div style={{ marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>Enable Feishu Bot</div>
                <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>WebSocket long-connection, no public IP required</div>
              </div>
              <button
                onClick={() => setFeishu(f => ({ ...f, feishu_enabled: f.feishu_enabled === "true" ? "false" : "true" }))}
                style={{
                  width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
                  background: feishu.feishu_enabled === "true" ? theme.accent : theme.border,
                  position: "relative", transition: "background 0.2s", flexShrink: 0,
                }}
              >
                <span style={{
                  position: "absolute", top: 3, width: 18, height: 18, borderRadius: "50%",
                  background: "#fff", transition: "left 0.2s",
                  left: feishu.feishu_enabled === "true" ? 23 : 3,
                }} />
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 20 }}>
              <div>
                <label style={labelStyle}>App ID</label>
                <input value={feishu.feishu_app_id} onChange={e => setFeishu(f => ({ ...f, feishu_app_id: e.target.value }))}
                  placeholder="cli_xxxxxxxxxxxxxxxx" style={fieldStyle} />
              </div>
              <div>
                <label style={labelStyle}>App Secret</label>
                <input type="password" value={feishu.feishu_app_secret} onChange={e => setFeishu(f => ({ ...f, feishu_app_secret: e.target.value }))}
                  placeholder="••••••••••••••••" style={fieldStyle} />
              </div>
              <div>
                <label style={labelStyle}>Default Chat ID</label>
                <input value={feishu.feishu_default_chat_id} onChange={e => setFeishu(f => ({ ...f, feishu_default_chat_id: e.target.value }))}
                  placeholder="oc_xxxxxxxx (group) or ou_xxxxxxxx (DM)" style={fieldStyle} />
                <div style={hintStyle}>Task completion notifications will be sent here.</div>
              </div>
              <div>
                <label style={labelStyle}>Default Working Directory</label>
                <input value={feishu.feishu_default_working_dir} onChange={e => setFeishu(f => ({ ...f, feishu_default_working_dir: e.target.value }))}
                  placeholder="~/my-project" style={fieldStyle} />
                <div style={hintStyle}>Working directory for tasks created via the bot.</div>
              </div>
            </div>

            {/* Bot commands cheatsheet */}
            <div style={{
              background: theme.bg, border: `1px solid ${theme.border}`,
              borderRadius: 8, padding: "12px 14px", marginBottom: 20, fontSize: 11,
              fontFamily: "monospace", color: theme.textMuted, lineHeight: 1.8,
            }}>
              <div style={{ color: theme.textDim, marginBottom: 6, fontFamily: "inherit" }}>Bot commands:</div>
              <div><span style={{ color: theme.cyan }}>&lt;any text&gt;</span> — create a new task</div>
              <div><span style={{ color: theme.cyan }}>/resume &lt;id&gt; &lt;msg&gt;</span> — resume a task session</div>
              <div><span style={{ color: theme.cyan }}>/status &lt;id&gt;</span> — query task status</div>
            </div>

            {feishuMsg && (
              <div style={{
                padding: "8px 12px", borderRadius: 8, marginBottom: 16, fontSize: 12,
                background: feishuMsg.ok ? theme.greenBg : theme.redBg,
                color: feishuMsg.ok ? theme.green : theme.red,
                border: `1px solid ${feishuMsg.ok ? theme.green : theme.red}`,
              }}>
                {feishuMsg.text}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={{
                padding: "10px 20px", borderRadius: 8, border: `1px solid ${theme.border}`,
                background: "transparent", color: theme.textMuted, cursor: "pointer",
                fontSize: 13, fontWeight: 600,
              }}>Close</button>
              <button onClick={handleSaveFeishu} disabled={feishuSaving} style={{
                padding: "10px 24px", borderRadius: 8, border: "none",
                background: feishuSaving ? theme.border : theme.accent,
                color: feishuSaving ? theme.textMuted : "#fff",
                cursor: feishuSaving ? "not-allowed" : "pointer",
                fontSize: 13, fontWeight: 600,
                boxShadow: feishuSaving ? "none" : `0 0 20px ${theme.accentGlow}`,
              }}>
                {feishuSaving ? "Saving…" : "Save & Apply"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── App ───

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [heartbeats, setHeartbeats] = useState([]);
  const [heartbeatTicks, setHeartbeatTicks] = useState([]);
  const [activeView, setActiveView] = useState("tasks");
  const [showNew, setShowNew] = useState(false);
  const [showNewHeartbeat, setShowNewHeartbeat] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [detail, setDetail] = useState(null);
  const [heartbeatDetail, setHeartbeatDetail] = useState(null);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState("");
  const [taskTimeout, setTaskTimeout] = useState(600);
  const [defaultAgent, setDefaultAgent] = useState("claude");
  const [feishuSettings, setFeishuSettings] = useState({});
  const [channelsStatus, setChannelsStatus] = useState({});
  const [backendReady, setBackendReady] = useState(false);
  const [backendError, setBackendError] = useState(null);
  const [apiError, setApiError] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [forkingTask, setForkingTask] = useState(null);
  const [editingHeartbeat, setEditingHeartbeat] = useState(null);

  // ─── Color mode ───
  const [colorMode, setColorMode] = useState(() =>
    localStorage.getItem("colorMode") || "system"
  );
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const resolvedMode = colorMode === "system" ? (systemDark ? "dark" : "light") : colorMode;
  theme = THEMES[resolvedMode];

  useEffect(() => {
    localStorage.setItem("colorMode", colorMode);
    document.body.style.background = THEMES[resolvedMode].bg;
  }, [colorMode, resolvedMode]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => setSystemDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const deadline = Date.now() + 20000;
    const probe = async () => {
      try {
        const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(800) });
        if (res.ok) { if (!cancelled) setBackendReady(true); return; }
      } catch { /* not ready yet */ }
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setBackendError('Backend did not start within 20 seconds.');
        return;
      }
      setTimeout(probe, 300);
    };
    probe();
    return () => { cancelled = true; };
  }, []);

  const poll = useCallback(async () => {
    try {
      const [taskData, heartbeatData] = await Promise.all([fetchTasks(), fetchHeartbeats()]);
      setTasks(taskData);
      setHeartbeats(heartbeatData);
      setConnected(true);
      setApiError(null);
    } catch (err) {
      setConnected(false);
      setApiError(`Failed to fetch tasks: ${err.message}`);
    }
  }, []);

  useEffect(() => {
    if (!backendReady) return;
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [poll, backendReady]);

  useEffect(() => {
    if (!backendReady) return;
    fetchSettings().then(s => {
      if (s.timeout) setTaskTimeout(s.timeout);
      if (s.default_agent) setDefaultAgent(s.default_agent);
    });
    fetchFeishuSettings().then(s => setFeishuSettings(s));
    fetchChannelsStatus().then(s => setChannelsStatus(s));
  }, [backendReady]);

  const handleAction = async (action, id) => {
    try {
      if (action === "cancel") await cancelTask(id);
      else if (action === "retry") await retryTask(id);
      else if (action === "delete") {
        await deleteTask(id);
        if (detail?.id === id) setDetail(null);
      } else if (action === "edit") {
        const task = tasks.find(t => t.id === id);
        if (task) setEditingTask(task);
        return;
      } else if (action === "fork") {
        const task = tasks.find(t => t.id === id);
        if (task) setForkingTask(task);
        return;
      }
      poll();
    } catch (e) {
      setApiError(`${action} failed: ${e.message}`);
    }
  };

  const handleHeartbeatAction = async (action, id) => {
    try {
      if (action === "run") {
        await runHeartbeatNow(id);
      } else if (action === "pause") {
        await pauseHeartbeat(id);
      } else if (action === "resume") {
        await resumeHeartbeatApi(id);
      } else if (action === "delete") {
        await deleteHeartbeat(id);
        if (heartbeatDetail?.id === id) {
          setHeartbeatDetail(null);
          setHeartbeatTicks([]);
        }
      } else if (action === "edit") {
        const heartbeat = heartbeats.find(h => h.id === id);
        if (heartbeat) setEditingHeartbeat(heartbeat);
        return;
      }
      poll();
      if (heartbeatDetail?.id === id && action !== "delete") {
        const [updatedHeartbeat, ticks] = await Promise.all([
          fetch(`${API}/heartbeats/${id}`).then(r => r.json()),
          fetchHeartbeatTicks(id),
        ]);
        setHeartbeatDetail(updatedHeartbeat);
        setHeartbeatTicks(ticks);
      }
    } catch (e) {
      setApiError(`Heartbeat ${action} failed: ${e.message}`);
    }
  };

  const handleCreate = async (data) => {
    try {
      await createTask(data);
      setShowNew(false);
      poll();
    } catch (e) {
      setApiError(`Create task failed: ${e.message}`);
    }
  };

  const handleEdit = async (data) => {
    try {
      await updateTask(editingTask.id, data);
      setEditingTask(null);
      poll();
    } catch (e) {
      setApiError(`Edit task failed: ${e.message}`);
    }
  };

  const handleFork = async (data) => {
    try {
      await createTask(data);
      setForkingTask(null);
      poll();
    } catch (e) {
      setApiError(`Fork task failed: ${e.message}`);
    }
  };

  const handleRespond = async (id, answer) => {
    try {
      await respondToTask(id, answer);
      poll();
    } catch (e) {
      setApiError(`Respond failed: ${e.message}`);
    }
  };

  const handleResume = () => {
    poll();
  };

  const handleCreateHeartbeat = async (data) => {
    try {
      await createHeartbeat(data);
      setShowNewHeartbeat(false);
      poll();
    } catch (e) {
      setApiError(`Create heartbeat failed: ${e.message}`);
    }
  };

  const handleEditHeartbeat = async (data) => {
    try {
      await updateHeartbeat(editingHeartbeat.id, data);
      setEditingHeartbeat(null);
      poll();
    } catch (e) {
      setApiError(`Edit heartbeat failed: ${e.message}`);
    }
  };

  const openHeartbeatDetail = async (heartbeat) => {
    setHeartbeatDetail(heartbeat);
    try {
      const ticks = await fetchHeartbeatTicks(heartbeat.id);
      setHeartbeatTicks(ticks);
    } catch (e) {
      setApiError(`Failed to fetch heartbeat ticks: ${e.message}`);
      setHeartbeatTicks([]);
    }
  };

  const filtered = filter
    ? tasks.filter(t =>
        t.title.toLowerCase().includes(filter.toLowerCase()) ||
        t.tags?.toLowerCase().includes(filter.toLowerCase())
      )
    : tasks;

  const runningCount = tasks.filter(t => t.status === "running").length;
  const scheduledCount = tasks.filter(t => t.status === "scheduled").length;
  const enabledHeartbeatCount = heartbeats.filter(h => h.enabled).length;

  if (backendError) {
    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        height: "100vh", background: theme.bg, color: theme.red, gap: 12, fontFamily: "inherit",
      }}>
        <div style={{ fontSize: 32 }}>✕</div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Backend failed to start</div>
        <div style={{ fontSize: 12, color: theme.textMuted, maxWidth: 400, textAlign: "center" }}>{backendError}</div>
      </div>
    );
  }

  if (!backendReady) {
    return (
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        height: "100vh", background: theme.bg, color: theme.textMuted, gap: 16, fontFamily: "inherit",
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: "50%",
          border: `3px solid ${theme.border}`,
          borderTopColor: theme.accent,
          animation: "spin 0.8s linear infinite",
        }} />
        <div style={{ fontSize: 13 }}>Starting backend…</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh", background: theme.bg, color: theme.text,
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
      {/* API error toast */}
      {apiError && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
          zIndex: 9999, display: "flex", alignItems: "center", gap: 10,
          background: theme.surface, border: `1px solid ${theme.red}`,
          borderRadius: 8, padding: "10px 16px",
          boxShadow: `0 4px 24px rgba(0,0,0,0.5)`,
          color: theme.red, fontSize: 12, fontWeight: 500,
          maxWidth: 480,
        }}>
          <span style={{ flexShrink: 0 }}>✕</span>
          <span style={{ flex: 1 }}>{apiError}</span>
          <button
            onClick={() => setApiError(null)}
            style={{
              background: "none", border: "none", color: theme.textMuted,
              cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 0 0 8px",
              flexShrink: 0,
            }}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      {/* Header */}
      <div style={{
        borderBottom: `1px solid ${theme.border}`,
        padding: "16px 28px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        backdropFilter: "blur(10px)",
        position: "sticky", top: 0, zIndex: 100,
        background: `${theme.bg}ee`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: `linear-gradient(135deg, ${theme.accent}, #a855f7)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, fontWeight: 800, color: "#fff",
          }}>
            ⌘
          </div>
          <div>
            <div style={{
              fontSize: 15, fontWeight: 700,
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: -0.3,
            }}>
              AgentForge
            </div>
            <div style={{ fontSize: 11, color: theme.textDim, marginTop: 1 }}>
              {connected ? (
                <span style={{ color: theme.green }}>● Connected</span>
              ) : (
                <span style={{ color: theme.red }}>● Disconnected — run `python taskboard.py`</span>
              )}
              {connected && ` · ${runningCount} running · ${scheduledCount} scheduled · ${enabledHeartbeatCount} heartbeats`}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            display: "flex", background: theme.surface, border: `1px solid ${theme.border}`,
            borderRadius: 10, padding: 4, gap: 4,
          }}>
            {[
              { key: "tasks", label: "Tasks" },
              { key: "heartbeats", label: "Heartbeats" },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveView(tab.key)}
                style={{
                  padding: "6px 10px", borderRadius: 8, border: "none",
                  background: activeView === tab.key ? theme.accentGlow : "transparent",
                  color: activeView === tab.key ? theme.accent : theme.textMuted,
                  cursor: "pointer", fontSize: 12, fontWeight: 700,
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <input
            placeholder={activeView === "tasks" ? "Filter tasks..." : "Filter heartbeats..."}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{
              padding: "8px 14px", borderRadius: 8,
              border: `1px solid ${theme.border}`, background: theme.surface,
              color: theme.text, fontSize: 12, outline: "none", width: 180,
            }}
          />
          {/* Color mode toggle */}
          {(() => {
            const cycle = { system: "light", light: "dark", dark: "system" };
            const icons = { system: "⊙", light: "☀", dark: "☾" };
            const labels = { system: "System theme", light: "Light mode", dark: "Dark mode" };
            return (
              <Tooltip text={labels[colorMode]}>
                <button
                  onClick={() => setColorMode(cycle[colorMode])}
                  style={{
                    padding: "8px 10px", borderRadius: 8,
                    border: `1px solid ${theme.border}`, background: "transparent",
                    color: theme.textMuted, cursor: "pointer", fontSize: 15,
                    display: "flex", alignItems: "center", transition: "all 0.15s",
                  }}
                >
                  {icons[colorMode]}
                </button>
              </Tooltip>
            );
          })()}
          <Tooltip text="Settings">
            <button onClick={() => setShowSettings(true)} style={{
            padding: "8px 12px", borderRadius: 8,
            border: `1px solid ${theme.border}`, background: "transparent",
            color: theme.textMuted, cursor: "pointer", fontSize: 15,
            display: "flex", alignItems: "center", transition: "all 0.15s",
          }}>
            ⚙
          </button>
          </Tooltip>
          <button onClick={() => activeView === "tasks" ? setShowNew(true) : setShowNewHeartbeat(true)} style={{
            padding: "8px 18px", borderRadius: 8, border: "none",
            background: theme.accent, color: "#fff", cursor: "pointer",
            fontSize: 12, fontWeight: 700, letterSpacing: 0.3,
            display: "flex", alignItems: "center", gap: 6,
            boxShadow: `0 0 24px ${theme.accentGlow}`,
            transition: "transform 0.15s",
          }}>
            {activeView === "tasks" ? "+ New Task" : "+ New Heartbeat"}
          </button>
        </div>
      </div>

      {activeView === "tasks" ? (
        <div style={{
          display: "flex", gap: 20, padding: 28,
          minHeight: "calc(100vh - 72px)",
        }}>
          {COLUMNS.map(col => (
            <Column
              key={col.key}
              col={col}
              tasks={filtered.filter(t => col.statuses.includes(t.status))}
              onAction={handleAction}
              onViewDetail={setDetail}
            />
          ))}
        </div>
      ) : (
        <div style={{ padding: 28, minHeight: "calc(100vh - 72px)" }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
            gap: 14,
          }}>
            {(filter
              ? heartbeats.filter(h =>
                  h.name.toLowerCase().includes(filter.toLowerCase()) ||
                  h.check_prompt.toLowerCase().includes(filter.toLowerCase())
                )
              : heartbeats
            ).map(h => (
              <HeartbeatCard
                key={h.id}
                heartbeat={h}
                onAction={handleHeartbeatAction}
                onViewDetail={openHeartbeatDetail}
              />
            ))}
            {heartbeats.length === 0 && (
              <div style={{
                border: `1px dashed ${theme.border}`, borderRadius: 12,
                padding: 32, textAlign: "center", color: theme.textDim, fontSize: 12,
                gridColumn: "1 / -1",
              }}>
                No heartbeats yet
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      {showNew && <NewTaskModal onClose={() => setShowNew(false)} onSubmit={handleCreate} initialData={{ agent: defaultAgent }} />}
      {showNewHeartbeat && (
        <HeartbeatModal
          onClose={() => setShowNewHeartbeat(false)}
          onSubmit={handleCreateHeartbeat}
          defaultAgent={defaultAgent}
        />
      )}
      {editingTask && (
        <NewTaskModal
          onClose={() => setEditingTask(null)}
          onSubmit={handleEdit}
          initialData={editingTask}
          mode="edit"
        />
      )}
      {editingHeartbeat && (
        <HeartbeatModal
          onClose={() => setEditingHeartbeat(null)}
          onSubmit={handleEditHeartbeat}
          initialData={editingHeartbeat}
          defaultAgent={defaultAgent}
          mode="edit"
        />
      )}
      {forkingTask && (
        <NewTaskModal
          onClose={() => setForkingTask(null)}
          onSubmit={handleFork}
          initialData={forkingTask}
          mode="fork"
        />
      )}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          timeout={taskTimeout}
          defaultAgent={defaultAgent}
          onSave={(timeout, agent) => { setTaskTimeout(timeout); if (agent) setDefaultAgent(agent); }}
          feishu={feishuSettings}
          onFeishuSave={(updated) => setFeishuSettings(updated)}
          channelsStatus={channelsStatus}
          onChannelsSave={(updated) => setChannelsStatus(updated)}
        />
      )}
      {detail && <DetailPanel task={tasks.find(t => t.id === detail.id) || detail} onClose={() => setDetail(null)} onRespond={handleRespond} onResume={handleResume} />}
      {heartbeatDetail && (
        <HeartbeatDetailPanel
          heartbeat={heartbeats.find(h => h.id === heartbeatDetail.id) || heartbeatDetail}
          ticks={heartbeatTicks}
          onClose={() => { setHeartbeatDetail(null); setHeartbeatTicks([]); }}
        />
      )}

      {/* Startup guide when no tasks */}
      {connected && activeView === "tasks" && tasks.length === 0 && (
        <div style={{
          position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)",
          background: theme.surface, border: `1px solid ${theme.border}`,
          borderRadius: 12, padding: "16px 24px", maxWidth: 500,
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        }}>
          <div style={{ fontSize: 13, color: theme.text, fontWeight: 600, marginBottom: 6 }}>
            Ready to go! Click "+ New Task" to create your first task.
          </div>
          <div style={{ fontSize: 11, color: theme.textDim, lineHeight: 1.6 }}>
            Tasks are dispatched to Claude Code in your specified working directory.
            Set cron schedules for recurring tasks, or delay execution.
          </div>
        </div>
      )}
      {connected && activeView === "heartbeats" && heartbeats.length === 0 && (
        <div style={{
          position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)",
          background: theme.surface, border: `1px solid ${theme.border}`,
          borderRadius: 12, padding: "16px 24px", maxWidth: 560,
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        }}>
          <div style={{ fontSize: 13, color: theme.text, fontWeight: 600, marginBottom: 6 }}>
            Heartbeats let AgentForge check first and only create work when needed.
          </div>
          <div style={{ fontSize: 11, color: theme.textDim, lineHeight: 1.6 }}>
            Create one to run a stateless agent decision tick on an interval or cron schedule, then trigger a real task only when the signal is actionable.
          </div>
        </div>
      )}

      {!connected && (
        <div style={{
          position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)",
          background: theme.redBg, border: `1px solid rgba(248,113,113,0.2)`,
          borderRadius: 12, padding: "16px 24px", maxWidth: 520,
        }}>
          <div style={{ fontSize: 13, color: theme.red, fontWeight: 600, marginBottom: 4 }}>
            Backend not running
          </div>
          <code style={{ fontSize: 11, color: theme.text, lineHeight: 1.8, display: "block" }}>
            pip install croniter<br/>
            python taskboard.py
          </code>
        </div>
      )}
    </div>
  );
}

// CSS动画定义
const styles = `
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .live-output-line {
    transition: color 0.2s ease;
  }

  .live-output-line.error {
    color: ${theme.red};
  }

  .live-output-line.success {
    color: ${theme.green};
  }

  .live-output-line.warning {
    color: ${theme.orange};
  }

  .live-output-line.info {
    color: ${theme.blue};
  }

  .live-output-line.command {
    color: ${theme.cyan};
    font-weight: bold;
  }

  .live-output-line.path {
    color: ${theme.accent};
  }
`;

// 注入样式
if (typeof document !== 'undefined' && !document.querySelector('#live-output-styles')) {
  const styleEl = document.createElement('style');
  styleEl.id = 'live-output-styles';
  styleEl.textContent = styles;
  document.head.appendChild(styleEl);
}
