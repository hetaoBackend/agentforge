import { memo, useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from "react";
import {
  CheckCircle2,
  GitFork,
  HeartPulse,
  Home,
  Inbox,
  KanbanSquare,
  MonitorCog,
  Moon,
  Pause,
  Pencil,
  Play,
  Plus,
  Radar,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Square,
  Sun,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import QRCode from "qrcode";
import {
  formatDateTimeLocalInput,
  formatTaskDateTime,
  formatTaskTime,
  parseTaskDateTime,
  serializeDateTimeLocalInput,
} from "./dateTime.ts";
import {
  buildChannelsSavePayload,
  createInitialChannelsState,
  isWeixinQrImageSource,
  mergeChannelsStatus,
} from "./channelsSettings.ts";
import { createRequestGenerationGuard, parseApiResponse } from "./apiReliability.ts";
import {
  attemptTargetedTaskRefresh,
  getTaskResponseUiState,
  markTaskResponseSubmitted,
  mergeTargetedTaskDetail,
  prepareTaskResponse,
  reconcileTasksWithSubmittedAnswers,
  selectTickAfterRefresh,
  startHeartbeatTickPolling,
  taskNeedsResponse,
  type TaskResponseRefreshResult,
} from "./operatorUi.ts";
import { applyIncrementalOutput, createIncrementalOutputState } from "./outputStreaming.ts";
import {
  DetailRequestCoordinator,
  loadLatestTaskDetail,
  mergeTaskSummaryIntoDetail,
} from "./taskPollingState.ts";
import { buildExecutionSteps } from "./traceSteps.ts";
import { fetchMainViewData, type MainView } from "./viewPolling.ts";

const API = "http://127.0.0.1:9712/api";

// ─── Theme ───
const THEMES: Record<string, Record<string, string>> = {
  dark: {
    bg: "#0d0e10",
    surface: "#17181c",
    surfaceHover: "#1c1d22",
    panel: "#111216",
    panelRaised: "#18191e",
    field: "#101115",
    border: "rgba(255, 255, 255, 0.085)",
    borderActive: "rgba(94, 106, 210, 0.48)",
    text: "#f4f4f5",
    textMuted: "#a6a8b0",
    textDim: "#70737c",
    accent: "#5e6ad2",
    accentGlow: "rgba(94, 106, 210, 0.18)",
    green: "#4cb782",
    greenBg: "rgba(76, 183, 130, 0.12)",
    orange: "#d99a45",
    orangeBg: "rgba(217, 154, 69, 0.13)",
    red: "#e06c75",
    redBg: "rgba(224, 108, 117, 0.13)",
    blue: "#6aa6f8",
    blueBg: "rgba(106, 166, 248, 0.12)",
    cyan: "#64b5d9",
    cyanBg: "rgba(100, 181, 217, 0.12)",
    yellow: "#d8b84e",
    headerBg: "rgba(13, 14, 16, 0.9)",
    headerBorder: "rgba(255, 255, 255, 0.08)",
    boardBg: "linear-gradient(180deg, #101114 0%, #0d0e10 48%, #0b0c0e 100%)",
    columnBg: "rgba(18, 19, 23, 0.72)",
    columnHeader: "#f4f4f5",
    shadow: "0 22px 54px rgba(0, 0, 0, 0.34)",
    shadowSoft: "0 10px 28px rgba(0, 0, 0, 0.2)",
    brandStart: "#f2f3f5",
    brandEnd: "#bfc4cf",
    brandInk: "#ffffff",
  },
  light: {
    bg: "#f7f8fa",
    surface: "#ffffff",
    surfaceHover: "#fafbfc",
    panel: "#f1f2f5",
    panelRaised: "#ffffff",
    field: "#f3f4f7",
    border: "rgba(31, 35, 40, 0.12)",
    borderActive: "rgba(94, 106, 210, 0.44)",
    text: "#1f2328",
    textMuted: "#636a75",
    textDim: "#8a919d",
    accent: "#5e6ad2",
    accentGlow: "rgba(94, 106, 210, 0.13)",
    green: "#2f9f6a",
    greenBg: "rgba(47, 159, 106, 0.1)",
    orange: "#b97722",
    orangeBg: "rgba(185, 119, 34, 0.11)",
    red: "#d14d57",
    redBg: "rgba(209, 77, 87, 0.1)",
    blue: "#3978d8",
    blueBg: "rgba(57, 120, 216, 0.1)",
    cyan: "#2f8fb7",
    cyanBg: "rgba(47, 143, 183, 0.1)",
    yellow: "#a98b19",
    headerBg: "rgba(247, 248, 250, 0.9)",
    headerBorder: "rgba(31, 35, 40, 0.1)",
    boardBg: "linear-gradient(180deg, #fbfbfc 0%, #f7f8fa 48%, #eef0f4 100%)",
    columnBg: "rgba(255, 255, 255, 0.78)",
    columnHeader: "#1f2328",
    shadow: "0 18px 42px rgba(31, 35, 40, 0.12)",
    shadowSoft: "0 8px 22px rgba(31, 35, 40, 0.08)",
    brandStart: "#ffffff",
    brandEnd: "#d9dde7",
    brandInk: "#ffffff",
  },
};

// Mutable module-level theme reference — updated before each App render
let theme = THEMES.dark;
const APP_FONT_STACK =
  "'SF Pro Text', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
const DISPLAY_FONT_STACK =
  "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
const MONO_FONT_STACK = "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getStatusConfig() {
  return {
    pending: { label: "Pending", color: theme.orange, bg: theme.orangeBg },
    scheduled: { label: "Scheduled", color: theme.cyan, bg: theme.cyanBg },
    running: { label: "Running", color: theme.blue, bg: theme.blueBg },
    completed: { label: "Completed", color: theme.green, bg: theme.greenBg },
    failed: { label: "Failed", color: theme.red, bg: theme.redBg },
    cancelled: {
      label: "Cancelled",
      color: theme.textMuted,
      bg: "rgba(107,107,138,0.08)",
    },
    blocked: { label: "Blocked", color: theme.textMuted, bg: "rgba(107,107,138,0.1)" },
  };
}

const COLUMNS = [
  {
    key: "queued",
    label: "Queue",
    hint: "ready, delayed, or blocked",
    statuses: ["pending", "scheduled", "blocked"],
    icon: Inbox,
    tone: "orange",
  },
  {
    key: "running",
    label: "Running",
    hint: "live agent sessions",
    statuses: ["running"],
    icon: Play,
    tone: "blue",
  },
  {
    key: "done",
    label: "Done",
    hint: "completed, failed, cancelled",
    statuses: ["completed", "failed", "cancelled"],
    icon: CheckCircle2,
    tone: "green",
  },
];

const AGENTS = {
  claude: { label: "Claude Code", icon: "C", color: "#ff9f0a" },
  codex: { label: "Codex CLI", icon: "X", color: "#00c7be" },
};
const DEFAULT_AGENT = "codex";
const DEFAULT_TIMEOUT_SECONDS = 12000;

// ─── Formatted Output Component ───
function FormattedOutput({ content, theme }) {
  if (!content) return null;

  // Parse the JSON stream and render only the useful signal.
  const parseStreamJSON = (text) => {
    const lines = text.split("\n");
    const parsedLines = [];

    lines.forEach((line) => {
      if (!line.trim()) return;

      try {
        const event = JSON.parse(line);
        const eventType = event.type;

        switch (eventType) {
          case "user":
          case "assistant": {
            const isUser = eventType === "user";
            const msg = event.message || {};
            const msgContent = msg.content || [];
            const prefix = isUser ? "👤 User: " : "🤖 Assistant: ";
            const color = isUser ? theme.accent : theme.green;
            let textBuf = "";
            const flushText = () => {
              if (textBuf.trim()) {
                parsedLines.push({
                  type: eventType,
                  text: prefix + textBuf,
                  style: { color, fontWeight: isUser ? "bold" : "normal" },
                });
                textBuf = "";
              }
            };
            for (const c of msgContent) {
              if (typeof c === "string") {
                textBuf += c;
              } else if (c && typeof c === "object") {
                if (c.type === "text") {
                  textBuf += c.text || "";
                } else if (c.type === "image") {
                  flushText();
                  const src =
                    c.source && c.source.type === "base64"
                      ? `data:${c.source.media_type || "image/jpeg"};base64,${c.source.data}`
                      : null;
                  if (src) parsedLines.push({ type: "image", src });
                } else if (c.type === "tool_use") {
                  flushText();
                  const rows = buildTraceRows(
                    "tool_call",
                    {
                      id: c.id,
                      name: c.name,
                      input: c.input,
                    },
                    "",
                  );
                  parsedLines.push({
                    type: "tool_call",
                    text: rows.map((row) => `${row.label}: ${row.value}`).join("\n"),
                    style: { color: theme.cyan, fontSize: "11px", fontFamily: "monospace" },
                  });
                } else if (c.type === "tool_result") {
                  flushText();
                  const rows = buildTraceRows(
                    "tool_result",
                    {
                      tool_use_id: c.tool_use_id,
                      content: Array.isArray(c.content)
                        ? c.content
                            .map((part) =>
                              part && part.type === "text" ? part.text || "" : JSON.stringify(part),
                            )
                            .join("")
                        : c.content,
                      is_error: c.is_error,
                    },
                    "",
                  );
                  parsedLines.push({
                    type: "tool_result",
                    text: rows.map((row) => `${row.label}: ${row.value}`).join("\n"),
                    style: {
                      color: c.is_error ? theme.red : theme.blue,
                      fontSize: "11px",
                      fontFamily: "monospace",
                    },
                  });
                }
              }
            }
            flushText();
            break;
          }

          case "item.completed": {
            const item = event.item || {};
            if (item.type === "command_execution") {
              const rows = buildTraceRows(
                "command_execution",
                {
                  command: item.command,
                  output: item.aggregated_output,
                  exit_code: item.exit_code,
                  status: item.status,
                },
                "",
              );
              parsedLines.push({
                type: "command_execution",
                text: rows.map((row) => `${row.label}: ${row.value}`).join("\n"),
                style: { color: theme.orange, fontSize: "11px", fontFamily: "monospace" },
              });
            } else if (item.type === "mcp_tool_call" || item.type === "collab_tool_call") {
              const rows = buildTraceRows(
                "tool_call",
                {
                  server: item.server,
                  name: item.tool || item.name,
                  input: item.arguments || item.input,
                  result: item.result,
                  status: item.status,
                  error: item.error,
                },
                "",
              );
              parsedLines.push({
                type: "tool_call",
                text: rows.map((row) => `${row.label}: ${row.value}`).join("\n"),
                style: { color: theme.cyan, fontSize: "11px", fontFamily: "monospace" },
              });
            } else if (item.type === "web_search") {
              const rows = buildTraceRows("web_search", item, "");
              parsedLines.push({
                type: "web_search",
                text: rows.map((row) => `${row.label}: ${row.value}`).join("\n"),
                style: { color: theme.cyan, fontSize: "11px", fontFamily: "monospace" },
              });
            } else if (item.type === "file_change") {
              const rows = buildTraceRows("file_change", item, "");
              parsedLines.push({
                type: "file_change",
                text: rows.map((row) => `${row.label}: ${row.value}`).join("\n"),
                style: { color: theme.accent, fontSize: "11px", fontFamily: "monospace" },
              });
            }
            break;
          }

          case "result":
            // Final result.
            if (event.result) {
              parsedLines.push({
                type: "result",
                text: `✅ Result: ${event.result}`,
                style: { color: theme.green, fontWeight: "bold" },
              });
            }
            break;

          case "error":
            // Error details.
            parsedLines.push({
              type: "error",
              text: `❌ Error: ${event.error || "Unknown error"}`,
              style: { color: theme.red, fontWeight: "bold" },
            });
            break;

          default:
            // Other event types: surface compact context.
            if (eventType) {
              let displayText = `[${eventType}]`;
              // Try to render the key event fields.
              if (event.message) {
                const msg = event.message;
                if (msg.content && Array.isArray(msg.content)) {
                  const textContent = msg.content
                    .filter(
                      (c) =>
                        typeof c === "string" || (c && typeof c === "object" && c.type === "text"),
                    )
                    .map((c) => (typeof c === "string" ? c : c.text || ""))
                    .join("");
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
                type: "event",
                text: displayText,
                style: { color: theme.textDim, fontSize: "11px", fontFamily: "monospace" },
              });
            }
        }
      } catch (_error) {
        // If it is not valid JSON, it may be plain text output.
        if (line.trim() && !line.startsWith("{")) {
          // Only render meaningful non-JSON lines.
          if (line.includes("error") || line.includes("Error")) {
            parsedLines.push({
              type: "error",
              text: line,
              style: { color: theme.red },
            });
          } else if (line.includes("success") || line.includes("Success")) {
            parsedLines.push({
              type: "success",
              text: line,
              style: { color: theme.green },
            });
          } else if (line.length > 10) {
            // Only render longer non-JSON lines.
            parsedLines.push({
              type: "text",
              text: line,
              style: { color: theme.textDim },
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
      <div style={{ color: theme.textDim, fontStyle: "italic", fontSize: "12px" }}>
        Waiting for agent output...
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", lineHeight: "1.6" }}>
      {parsedContent.map((item, index) =>
        item.type === "image" ? (
          <div key={index} style={{ margin: "6px 0" }}>
            <img
              src={item.src}
              alt="output image"
              style={{ maxWidth: "100%", borderRadius: "4px", display: "block" }}
            />
          </div>
        ) : (
          <div
            key={index}
            style={{
              ...item.style,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              marginBottom: "2px",
              padding: "2px 0",
            }}
          >
            {item.text}
          </div>
        ),
      )}
    </div>
  );
}

function ExecutionTimeline({ events }) {
  const [expanded, setExpanded] = useState(true);
  const steps = buildExecutionSteps(events);

  if (steps.length === 0) {
    return (
      <div style={{ fontSize: 12, color: theme.textDim, padding: "12px 0", textAlign: "center" }}>
        No output events recorded — events are recorded for new task runs.
      </div>
    );
  }

  return (
    <div
      style={{
        border: `1px solid ${theme.border}`,
        borderRadius: 8,
        overflow: "hidden",
        background: theme.bg,
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          padding: "10px 12px",
          background: theme.surface,
          border: "none",
          borderBottom: expanded ? `1px solid ${theme.border}` : "none",
          color: theme.text,
          cursor: "pointer",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ color: theme.textMuted }}>{expanded ? "⌄" : "›"}</span>
          <span>
            Show {steps.length} {steps.length === 1 ? "step" : "steps"}
          </span>
        </span>
        <span style={{ color: theme.textDim, fontSize: 10, whiteSpace: "nowrap" }}>
          {events.length} events
        </span>
      </button>

      {expanded && (
        <div style={{ padding: "12px 12px 14px" }}>
          {steps.map((step, index) => (
            <ExecutionTimelineStep
              key={`${step.id}-${step.number}`}
              step={step}
              isLast={index === steps.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ExecutionTimelineStep({ step, isLast }) {
  const config = getExecutionStepConfig(step.type);
  const detail = (step.detail || "").trim();
  const hasRows = step.rows && step.rows.length > 0;
  const hasImage = Boolean(step.imageSrc);
  const showDetail = detail && detail !== step.title && !hasRows && !hasImage;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "28px 1fr", columnGap: 10 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: config.bg,
            border: `1px solid ${config.color}55`,
            color: config.color,
            fontSize: 10,
            fontWeight: 800,
            lineHeight: 1,
          }}
        >
          {config.icon}
        </div>
        {!isLast && (
          <div
            style={{ width: 1, flex: 1, minHeight: 16, background: theme.border, marginTop: 4 }}
          />
        )}
      </div>

      <div style={{ paddingBottom: isLast ? 0 : 14, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
            alignItems: "baseline",
          }}
        >
          <div
            style={{
              color: theme.text,
              fontSize: 12,
              lineHeight: 1.55,
              wordBreak: "break-word",
              minWidth: 0,
            }}
          >
            {step.title}
          </div>
          <div
            style={{
              color: theme.textDim,
              fontSize: 9,
              whiteSpace: "nowrap",
              flexShrink: 0,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {formatTaskTime(step.timestamp)}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 3,
            marginBottom: hasRows || showDetail ? 7 : 0,
          }}
        >
          <span
            style={{
              color: config.color,
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0,
            }}
          >
            {config.label}
          </span>
          {step.count > 1 && (
            <span style={{ color: theme.textDim, fontSize: 10 }}>{step.count} chunks</span>
          )}
        </div>

        {hasImage && (
          <img
            src={step.imageSrc}
            alt="image output"
            style={{
              maxWidth: "100%",
              borderRadius: 6,
              display: "block",
              marginTop: 7,
              border: `1px solid ${theme.border}`,
            }}
          />
        )}

        {hasRows && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 5,
              background: theme.surface,
              border: `1px solid ${theme.border}`,
              borderRadius: 6,
              padding: "8px 10px",
              maxHeight: 220,
              overflow: "auto",
            }}
          >
            {step.rows.map((row, i) => (
              <div
                key={i}
                style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 8, minWidth: 0 }}
              >
                <span style={{ color: theme.textMuted, fontWeight: 700 }}>{row.label}</span>
                <span
                  style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: theme.text }}
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {showDetail && (
          <pre
            style={{
              margin: 0,
              background: theme.surface,
              border: `1px solid ${theme.border}`,
              borderRadius: 6,
              padding: "8px 10px",
              color: theme.textMuted,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              lineHeight: 1.5,
              maxHeight: 220,
              overflow: "auto",
            }}
          >
            {detail}
          </pre>
        )}
      </div>
    </div>
  );
}

function getExecutionStepConfig(type) {
  switch (type) {
    case "thinking":
      return { label: "Thinking", icon: "⌁", color: theme.textMuted, bg: "rgba(107,107,138,0.08)" };
    case "tool_call":
      return { label: "Tool Call", icon: "▣", color: theme.cyan, bg: theme.cyanBg };
    case "tool_result":
      return { label: "Tool Result", icon: "↵", color: theme.blue, bg: theme.blueBg };
    case "command_execution":
      return { label: "Command", icon: "$", color: theme.orange, bg: theme.orangeBg };
    case "file_change":
      return { label: "File", icon: "◇", color: theme.accent, bg: theme.accentGlow };
    case "generated_image":
      return { label: "Image", icon: "□", color: theme.accent, bg: theme.accentGlow };
    case "image_content":
      return { label: "Image", icon: "□", color: theme.accent, bg: theme.accentGlow };
    case "web_search":
      return { label: "Search", icon: "⌕", color: theme.cyan, bg: theme.cyanBg };
    case "result":
      return { label: "Result", icon: "✓", color: theme.green, bg: theme.greenBg };
    case "error":
      return { label: "Error", icon: "!", color: theme.red, bg: theme.redBg };
    case "user":
      return { label: "User", icon: "U", color: theme.accent, bg: theme.accentGlow };
    case "assistant":
      return { label: "Assistant", icon: "AI", color: theme.green, bg: theme.greenBg };
    default:
      return { label: "Event", icon: "•", color: theme.textMuted, bg: "rgba(107,107,138,0.08)" };
  }
}

function formatTraceValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function buildTraceRows(eventType, payload, rawContent) {
  const row = (label, value) => {
    const formatted = formatTraceValue(value);
    return formatted === "" ? null : { label, value: formatted };
  };
  const compact = (rows) => rows.filter(Boolean);

  if (eventType === "tool_call") {
    const name = payload.server
      ? `${payload.server}.${payload.name || payload.tool || "unknown"}`
      : payload.name || payload.tool || "unknown";
    return compact([
      row("Tool", name),
      row("Input", payload.input || payload.arguments),
      row("Result", payload.result),
      row("Status", payload.status),
      row("Error", payload.error),
    ]);
  }

  if (eventType === "tool_result") {
    return compact([
      row(payload.is_error ? "Tool Error" : "Tool Result", payload.tool_use_id || "result"),
      row("Content", payload.content),
    ]);
  }

  if (eventType === "command_execution") {
    return compact([
      row("Command", payload.command),
      row("Output", payload.output),
      row("Exit", payload.exit_code),
      row("Status", payload.status),
    ]);
  }

  if (eventType === "file_change") {
    const changes = Array.isArray(payload.changes)
      ? payload.changes
          .map((change) => {
            if (!change || typeof change !== "object") return formatTraceValue(change);
            const kind = change.kind || change.type || "changed";
            const path = change.path || change.file || "";
            return path ? `${kind}: ${path}` : kind;
          })
          .join("\n")
      : payload.changes;
    return compact([row("Changes", changes), row("Status", payload.status)]);
  }

  if (eventType === "web_search") {
    return compact([
      row("Query", payload.query),
      row("Action", payload.action),
      row("Status", payload.status),
    ]);
  }

  return [{ label: eventType, value: rawContent }];
}

// ─── CSRF token ───
// Fetched once at startup; reused for all state-changing requests.
let _csrfTokenPromise = null;
function getCsrfToken() {
  if (!_csrfTokenPromise) {
    _csrfTokenPromise = fetch(`${API}/csrf-token`)
      .then((r) => r.json())
      .then((d) => d.csrf_token || "")
      .catch(() => "");
  }
  return _csrfTokenPromise;
}

async function csrfHeaders(extra = {}) {
  const token = await getCsrfToken();
  return { "Content-Type": "application/json", "X-CSRF-Token": token, ...extra };
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  timeoutMs: number,
  init: RequestInit = {},
) {
  if (typeof AbortController === "undefined") {
    let timeout = 0;
    const timeoutPromise = new Promise<Response>((_, reject) => {
      timeout = window.setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
    });
    try {
      return await Promise.race([fetch(input, init), timeoutPromise]);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

// ─── API helpers ───
async function fetchTask(id, signal?: AbortSignal) {
  const res = await fetch(`${API}/tasks/${id}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiMutation<T = any>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, init);
  return parseApiResponse<T>(response);
}

async function createTask(data) {
  return apiMutation("/tasks", {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

async function triggerSkillSweep(agent?: string) {
  return apiMutation("/skills/sweep", {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(agent ? { agent } : {}),
  });
}

async function triggerSkillDraft(id, agent?: string) {
  return apiMutation(`/skill-patterns/${id}/draft`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(agent ? { agent } : {}),
  });
}

async function approveSkill(id, data) {
  return apiMutation(`/skill-patterns/${id}/approve`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

async function dismissSkillPattern(id) {
  return apiMutation(`/skill-patterns/${id}/dismiss`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: "{}",
  });
}

async function setSkillEnabledApi(id, enabled) {
  return apiMutation(`/skills/${id}`, {
    method: "PUT",
    headers: await csrfHeaders(),
    body: JSON.stringify({ enabled }),
  });
}

async function deleteSkillApi(id) {
  return apiMutation(`/skills/${id}`, {
    method: "DELETE",
    headers: await csrfHeaders(),
  });
}

async function createHeartbeat(data) {
  return apiMutation("/heartbeats", {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

async function updateHeartbeat(id, data) {
  return apiMutation(`/heartbeats/${id}`, {
    method: "PUT",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

async function deleteHeartbeat(id) {
  return apiMutation(`/heartbeats/${id}`, {
    method: "DELETE",
    headers: await csrfHeaders(),
  });
}

async function runHeartbeatNow(id) {
  return apiMutation(`/heartbeats/${id}/run-now`, {
    method: "POST",
    headers: await csrfHeaders(),
  });
}

async function pauseHeartbeat(id) {
  return apiMutation(`/heartbeats/${id}/pause`, {
    method: "POST",
    headers: await csrfHeaders(),
  });
}

async function resumeHeartbeatApi(id) {
  return apiMutation(`/heartbeats/${id}/resume`, {
    method: "POST",
    headers: await csrfHeaders(),
  });
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
  return apiMutation(`/tasks/${id}/cancel`, {
    method: "POST",
    headers: await csrfHeaders(),
  });
}

async function retryTask(id) {
  return apiMutation(`/tasks/${id}/retry`, {
    method: "POST",
    headers: await csrfHeaders(),
  });
}

async function deleteTask(id) {
  return apiMutation(`/tasks/${id}`, {
    method: "DELETE",
    headers: await csrfHeaders(),
  });
}

async function updateTask(id, data) {
  return apiMutation(`/tasks/${id}`, {
    method: "PUT",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

async function respondToTask(id, answer) {
  return apiMutation(`/tasks/${id}/respond`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify({ answer }),
  });
}

async function resumeTask(id, message) {
  return apiMutation(`/tasks/${id}/resume`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify({ message }),
  });
}

async function fetchTaskMessages(id) {
  try {
    const res = await fetch(`${API}/tasks/${id}/messages`);
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

async function fetchTaskEvents(id) {
  try {
    const res = await fetch(`${API}/tasks/${id}/events?limit=1000`);
    if (res.ok) {
      const data = await res.json();
      return data.events || [];
    }
    return [];
  } catch {
    return [];
  }
}

async function fetchSettings() {
  try {
    const res = await fetch(`${API}/settings`);
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

async function updateSettings(data) {
  return apiMutation("/settings", {
    method: "PUT",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

async function fetchFeishuSettings() {
  try {
    const res = await fetch(`${API}/feishu/settings`);
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

async function updateFeishuSettings(data) {
  return apiMutation("/feishu/settings", {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

async function fetchChannelsStatus() {
  try {
    const res = await fetch(`${API}/channels/status`);
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

async function updateChannelsSettings(data) {
  return apiMutation("/channels/settings", {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(data),
  });
}

async function runWeixinAction(action) {
  return apiMutation("/channels/weixin/action", {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify({ action }),
  });
}

// ─── Components ───

function Tooltip({ text, children }) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<{
    arrowLeft: number;
    left: number;
    top: number;
    placement: "top" | "bottom";
  } | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!visible) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;

      const triggerRect = trigger.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const gap = 8;
      const margin = 8;
      const topCandidate = triggerRect.top - tooltipRect.height - gap;
      const placement = topCandidate < margin ? "bottom" : "top";
      const top = placement === "top" ? topCandidate : triggerRect.bottom + gap;
      const centeredLeft = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
      const maxLeft = window.innerWidth - tooltipRect.width - margin;
      const left = clamp(centeredLeft, margin, Math.max(margin, maxLeft));

      setPosition({
        arrowLeft: clamp(
          triggerRect.left + triggerRect.width / 2 - left,
          10,
          tooltipRect.width - 10,
        ),
        left,
        top,
        placement,
      });
    };

    const frame = requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [visible, text]);

  return (
    <div
      ref={triggerRef}
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => {
        setPosition(null);
        setVisible(true);
      }}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => {
        setPosition(null);
        setVisible(true);
      }}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div
          ref={tooltipRef}
          style={{
            position: "fixed",
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            opacity: position ? 1 : 0,
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            color: theme.textMuted,
            fontSize: 11,
            padding: "5px 8px",
            borderRadius: 8,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: theme.shadowSoft,
            zIndex: 9999,
            transition: "opacity 0.12s ease",
          }}
        >
          {text}
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: position?.arrowLeft ?? "50%",
              [position?.placement === "bottom" ? "top" : "bottom"]: -4,
              width: 7,
              height: 7,
              background: theme.surface,
              borderLeft: `1px solid ${theme.border}`,
              borderTop: `1px solid ${theme.border}`,
              transform:
                position?.placement === "bottom"
                  ? "translateX(-50%) rotate(45deg)"
                  : "translateX(-50%) rotate(225deg)",
            }}
          />
        </div>
      )}
    </div>
  );
}

function BrandMark({ size = 40 }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        display: "grid",
        placeItems: "center",
        background: `linear-gradient(180deg, ${theme.brandStart}, ${theme.brandEnd})`,
        border: `1px solid ${theme.border}`,
        position: "relative",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <img
        src="./assets/agentforge.png"
        alt="AgentForge"
        style={{ width: size, height: size, display: "block" }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 1,
          borderRadius: 7,
          border: "1px solid rgba(255,255,255,0.14)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

function IconGlyph({
  icon: Icon,
  size = 15,
  strokeWidth = 2.35,
  style,
}: {
  icon: LucideIcon;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <Icon
      aria-hidden="true"
      size={size}
      strokeWidth={strokeWidth}
      style={{ display: "block", flexShrink: 0, ...style }}
    />
  );
}

function IconWell({
  icon,
  color = theme.accent,
  background = theme.field,
  size = 28,
  iconSize = 15,
  active = false,
}: {
  icon: LucideIcon;
  color?: string;
  background?: string;
  size?: number;
  iconSize?: number;
  active?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: 7,
        display: "grid",
        placeItems: "center",
        background: active ? theme.accentGlow : background,
        border: `1px solid ${active ? theme.borderActive : theme.border}`,
        color,
        flexShrink: 0,
      }}
    >
      <IconGlyph icon={icon} size={iconSize} />
    </span>
  );
}

function HeaderButton({ children, onClick, title, active = false }) {
  return (
    <Tooltip text={title}>
      <button
        onClick={onClick}
        aria-label={title}
        style={{
          width: 32,
          height: 32,
          borderRadius: 6,
          border: `1px solid ${active ? theme.accent : theme.border}`,
          background: active ? theme.accentGlow : theme.surface,
          color: active ? theme.accent : theme.textMuted,
          cursor: "pointer",
          fontSize: 15,
          display: "grid",
          placeItems: "center",
          boxShadow: active ? `0 0 0 2px ${theme.accentGlow}` : "none",
          transition: "background 0.15s ease, color 0.15s ease, border-color 0.15s ease",
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function StatusPill({ connected, label, tone = theme.green, background = theme.greenBg }) {
  const activeTone = connected ? tone : theme.red;
  const activeBackground = connected ? background : theme.redBg;

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        color: activeTone,
        background: connected ? background : activeBackground,
        border: `1px solid ${connected ? `${activeTone}40` : `${theme.red}55`}`,
        borderRadius: 999,
        padding: "4px 9px",
        fontSize: 11,
        fontWeight: 650,
        fontFamily: MONO_FONT_STACK,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: activeTone,
        }}
      />
      {connected ? label : "offline"}
    </div>
  );
}

function MetricTile({ label, value, tone = theme.text }) {
  return (
    <div
      style={{
        minWidth: 84,
        padding: "8px 10px",
        borderRadius: 8,
        border: `1px solid ${theme.border}`,
        background: theme.surface,
      }}
    >
      <div style={{ color: theme.textDim, fontSize: 11, fontWeight: 600 }}>{label}</div>
      <div
        style={{
          color: tone,
          fontSize: 18,
          fontWeight: 720,
          lineHeight: 1.1,
          marginTop: 2,
          fontFamily: DISPLAY_FONT_STACK,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Badge({ status }) {
  const cfg = getStatusConfig()[status] || getStatusConfig().pending;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 7px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 650,
        color: cfg.color,
        background: cfg.bg,
        border: `1px solid ${cfg.color}33`,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: cfg.color,
        }}
      />
      {cfg.label}
    </span>
  );
}

function Tag({ children }) {
  return (
    <span
      style={{
        padding: "3px 7px",
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 650,
        background: theme.field,
        color: theme.textMuted,
        border: `1px solid ${theme.border}`,
      }}
    >
      {children}
    </span>
  );
}

function AgentBadge({ agent }) {
  const cfg = AGENTS[agent] || AGENTS.claude;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 650,
        color: cfg.color,
        background: `${cfg.color}18`,
        border: `1px solid ${cfg.color}2f`,
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 4,
          display: "grid",
          placeItems: "center",
          color: theme.brandInk,
          background: cfg.color,
          fontSize: 9,
          fontWeight: 700,
          lineHeight: 1,
          fontFamily: MONO_FONT_STACK,
        }}
      >
        {cfg.icon}
      </span>
      {cfg.label}
    </span>
  );
}

function uiField(overrides: CSSProperties = {}): CSSProperties {
  return {
    width: "100%",
    padding: "9px 11px",
    borderRadius: 6,
    border: `1px solid ${theme.border}`,
    background: theme.field,
    color: theme.text,
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box",
    fontFamily: APP_FONT_STACK,
    transition: "border-color 0.15s ease, background 0.15s ease",
    ...overrides,
  };
}

function uiLabel(): CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 650,
    color: theme.textMuted,
    letterSpacing: 0,
    marginBottom: 6,
    display: "block",
  };
}

function modalOverlay(): CSSProperties {
  return {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.58)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    backdropFilter: "blur(6px)",
    padding: 20,
  };
}

function modalPanel(width: number, maxHeight = "84vh"): CSSProperties {
  return {
    background: theme.surface,
    border: `1px solid ${theme.border}`,
    borderRadius: 10,
    padding: 24,
    width,
    maxWidth: "calc(100vw - 40px)",
    maxHeight,
    overflow: "auto",
    boxShadow: theme.shadow,
  };
}

function modalTitle(): CSSProperties {
  return {
    margin: "0 0 18px",
    fontSize: 16,
    fontWeight: 720,
    color: theme.text,
    fontFamily: DISPLAY_FONT_STACK,
  };
}

function secondaryButton(): CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: 6,
    border: `1px solid ${theme.border}`,
    background: theme.surface,
    color: theme.textMuted,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 650,
  };
}

function primaryButton(): CSSProperties {
  return {
    padding: "8px 15px",
    borderRadius: 6,
    border: `1px solid ${theme.accent}`,
    background: theme.accent,
    color: theme.brandInk,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 680,
  };
}

function segmentedButton(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: "7px 10px",
    borderRadius: 6,
    cursor: "pointer",
    border: `1px solid ${active ? theme.borderActive : theme.border}`,
    background: active ? theme.accentGlow : theme.surface,
    color: active ? theme.text : theme.textMuted,
    fontSize: 12,
    fontWeight: 650,
    minWidth: 96,
    transition: "background 0.15s ease, border-color 0.15s ease, color 0.15s ease",
  };
}

function TaskCard({ task, onAction, onViewDetail, themeVersion }) {
  void themeVersion;
  const [hovered, setHovered] = useState(false);
  const tags = task.tags ? task.tags.split(",").filter(Boolean) : [];

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onViewDetail(task)}
      style={{
        background: hovered ? theme.surfaceHover : theme.surface,
        border: `1px solid ${hovered ? theme.borderActive : theme.border}`,
        borderRadius: 8,
        cursor: "pointer",
        overflow: "hidden",
        transition:
          "transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, background 0.16s ease",
        transform: hovered ? "translateY(-1px)" : "none",
        boxShadow: hovered ? "0 8px 24px rgba(0,0,0,0.14)" : "none",
      }}
    >
      <div
        style={{
          padding: "12px 13px",
          display: "flex",
          flexDirection: "column",
          gap: 9,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            style={{
              color: theme.textDim,
              fontFamily: MONO_FONT_STACK,
              fontSize: 10,
              fontWeight: 800,
            }}
          >
            #{task.id}
          </span>
          <Badge status={task.status} />
        </div>

        <div
          style={{
            fontSize: 13.5,
            fontWeight: 680,
            color: theme.text,
            lineHeight: 1.35,
            fontFamily: DISPLAY_FONT_STACK,
          }}
        >
          {task.title || "Untitled task"}
        </div>

        <div
          style={{
            fontSize: 12,
            color: theme.textMuted,
            lineHeight: 1.45,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {task.prompt_preview || task.prompt || "No prompt saved for this task."}
        </div>

        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          <AgentBadge agent={task.agent} />
          {task.schedule_type === "delayed" && <Tag>delay {task.delay_seconds}s</Tag>}
          {task.schedule_type === "scheduled_at" && task.next_run_at && (
            <Tag>at {formatTaskDateTime(task.next_run_at)}</Tag>
          )}
          {task.schedule_type === "cron" && <Tag>cron {task.cron_expr}</Tag>}
          {task.run_count > 0 && (
            <Tag>
              runs {task.run_count}
              {task.max_runs ? `/${task.max_runs}` : ""}
            </Tag>
          )}
          {tags.slice(0, 4).map((t, i) => (
            <Tag key={i}>{t.trim()}</Tag>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            borderTop: `1px solid ${theme.border}`,
            paddingTop: 9,
          }}
        >
          <div style={{ fontSize: 10, color: theme.textDim, fontFamily: MONO_FONT_STACK }}>
            {task.last_run_at ? `last ${formatTaskTime(task.last_run_at)}` : "not run yet"}
          </div>

          <div
            style={{ display: "flex", gap: 4, opacity: hovered ? 1 : 0.7 }}
            onClick={(e) => e.stopPropagation()}
          >
            {["pending", "scheduled", "blocked"].includes(task.status) && (
              <ActionBtn
                icon={Pencil}
                title="Edit"
                onClick={() => onAction("edit", task.id)}
                color={theme.blue || theme.accent}
              />
            )}
            {["completed", "cancelled", "failed"].includes(task.status) && (
              <ActionBtn
                icon={GitFork}
                title="Fork"
                onClick={() => onAction("fork", task.id)}
                color={theme.cyan || theme.accent}
              />
            )}
            {task.status === "failed" && (
              <ActionBtn
                icon={RotateCcw}
                title="Retry"
                onClick={() => onAction("retry", task.id)}
                color={theme.orange}
              />
            )}
            {["pending", "scheduled", "running"].includes(task.status) && (
              <ActionBtn
                icon={Square}
                title="Cancel"
                onClick={() => onAction("cancel", task.id)}
                color={theme.red}
              />
            )}
            <ActionBtn
              icon={Trash2}
              title="Delete"
              onClick={() => onAction("delete", task.id)}
              color={theme.textMuted}
            />
          </div>
        </div>

        {task.status === "blocked" && task.dependencies && task.dependencies.length > 0 && (
          <div style={{ fontSize: 10, color: theme.textDim, fontFamily: MONO_FONT_STACK }}>
            waiting for {task.dependencies.map((d) => `#${d.depends_on_task_id}`).join(", ")}
          </div>
        )}
        {task.dependents && task.dependents.length > 0 && task.status === "completed" && (
          <div style={{ fontSize: 10, color: theme.textDim, fontFamily: MONO_FONT_STACK }}>
            unlocks {task.dependents.map((id) => `#${id}`).join(", ")}
          </div>
        )}
        {task.dag_id && (
          <div
            style={{
              fontSize: 10,
              color: theme.accent,
              opacity: 0.72,
              fontFamily: MONO_FONT_STACK,
            }}
          >
            dag {task.dag_id}
          </div>
        )}
      </div>
    </div>
  );
}

const MemoizedTaskCard = memo(TaskCard);

function ActionBtn({ icon, title, onClick, color }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? `${color}22` : theme.field,
        border: `1px solid ${hovered ? `${color}66` : theme.border}`,
        color: color,
        cursor: "pointer",
        width: 26,
        height: 26,
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background 0.15s ease, border-color 0.15s ease",
      }}
    >
      <IconGlyph icon={icon} size={13} strokeWidth={2.4} />
    </button>
  );
}

function Column({ col, tasks, onAction, onViewDetail, themeVersion }) {
  const iconColor = theme[col.tone] || theme.accent;
  const iconBackground = theme[`${col.tone}Bg`] || theme.field;

  return (
    <div
      style={{
        minWidth: 0,
        borderRadius: 8,
        border: `1px solid ${theme.border}`,
        background: theme.columnBg,
        boxShadow: "none",
        padding: 10,
        minHeight: 420,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
          padding: "2px 2px 10px",
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <IconWell
            icon={col.icon}
            color={iconColor}
            background={iconBackground}
            size={28}
            iconSize={15}
          />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 720,
                color: theme.columnHeader,
                fontFamily: DISPLAY_FONT_STACK,
              }}
            >
              {col.label}
            </div>
            <div style={{ fontSize: 10, color: theme.textDim, marginTop: 2 }}>{col.hint}</div>
          </div>
        </div>
        <span
          style={{
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            borderRadius: 999,
            padding: "3px 8px",
            fontSize: 11,
            color: theme.textMuted,
            fontWeight: 600,
            fontFamily: MONO_FONT_STACK,
          }}
        >
          {tasks.length}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {tasks.map((t) => (
          <MemoizedTaskCard
            key={t.id}
            task={t}
            onAction={onAction}
            onViewDetail={onViewDetail}
            themeVersion={themeVersion}
          />
        ))}
        {tasks.length === 0 && (
          <div
            style={{
              border: `1px dashed ${theme.border}`,
              borderRadius: 8,
              padding: "28px 18px",
              textAlign: "center",
              color: theme.textDim,
              fontSize: 12,
              background: theme.surface,
            }}
          >
            Clear
          </div>
        )}
      </div>
    </div>
  );
}

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

function HeartbeatModal({ onClose, onSubmit, initialData, defaultAgent, mode = "create" }: any) {
  const savedDir = localStorage.getItem("agentforge_working_dir") || "~/papers";
  const [form, setForm] = useState(() => ({
    name: initialData?.name || "",
    working_dir: initialData?.working_dir || savedDir,
    schedule_type: initialData?.schedule_type || "interval",
    interval_seconds: initialData?.interval_seconds || 600,
    cron_expr: initialData?.cron_expr || "",
    check_prompt: initialData?.check_prompt || "",
    action_prompt_template: initialData?.action_prompt_template || "",
    default_agent: initialData?.default_agent || defaultAgent || DEFAULT_AGENT,
    cooldown_seconds: initialData?.cooldown_seconds || 1800,
    enabled: initialData?.enabled ?? true,
  }));

  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const inputStyle = uiField();
  const labelStyle = uiLabel();

  const handleSubmit = () => {
    localStorage.setItem("agentforge_working_dir", form.working_dir);
    onSubmit({
      ...form,
      name: form.name || "Untitled heartbeat",
      interval_seconds:
        form.schedule_type === "interval" ? parseInt(form.interval_seconds) || 600 : null,
      cooldown_seconds: parseInt(form.cooldown_seconds) || 0,
      cron_expr: form.schedule_type === "cron" ? form.cron_expr : null,
    });
  };

  return (
    <div
      style={{
        ...modalOverlay(),
      }}
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} style={modalPanel(640)}>
        <h2 style={modalTitle()}>{mode === "edit" ? "Edit Heartbeat" : "New Heartbeat"}</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={labelStyle}>Name</label>
            <input
              style={inputStyle}
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Repo review watcher"
            />
          </div>
          <div>
            <label style={labelStyle}>Working Directory</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                style={{ ...inputStyle, flex: 1 }}
                value={form.working_dir}
                onChange={(e) => set("working_dir", e.target.value)}
              />
              {window.electronAPI?.selectDirectory && (
                <button
                  onClick={async () => {
                    const dir = await window.electronAPI.selectDirectory();
                    if (dir) set("working_dir", dir);
                  }}
                  style={{
                    ...secondaryButton(),
                    padding: "0 13px",
                    height: 37,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  Browse
                </button>
              )}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Schedule Type</label>
            <div style={{ display: "flex", gap: 8 }}>
              {["interval", "cron"].map((t) => (
                <button
                  key={t}
                  onClick={() => set("schedule_type", t)}
                  style={segmentedButton(form.schedule_type === t)}
                >
                  {t === "interval" ? "Interval" : "Cron"}
                </button>
              ))}
            </div>
          </div>
          {form.schedule_type === "interval" ? (
            <div>
              <label style={labelStyle}>Interval (seconds)</label>
              <input
                type="number"
                style={inputStyle}
                value={form.interval_seconds}
                onChange={(e) => set("interval_seconds", e.target.value)}
              />
            </div>
          ) : (
            <div>
              <label style={labelStyle}>Cron Expression</label>
              <input
                style={inputStyle}
                value={form.cron_expr}
                onChange={(e) => set("cron_expr", e.target.value)}
                placeholder="*/10 * * * *"
              />
            </div>
          )}
          <div>
            <label style={labelStyle}>Decision Prompt *</label>
            <textarea
              style={{ ...inputStyle, height: 110, resize: "vertical" }}
              value={form.check_prompt}
              onChange={(e) => set("check_prompt", e.target.value)}
              placeholder="Check whether there are new meaningful code changes that deserve a review task. Return JSON only."
            />
          </div>
          <div>
            <label style={labelStyle}>Triggered Task Prompt Template</label>
            <textarea
              style={{ ...inputStyle, height: 90, resize: "vertical" }}
              value={form.action_prompt_template}
              onChange={(e) => set("action_prompt_template", e.target.value)}
              placeholder="Review the latest code changes and summarize bugs, regressions, and missing tests."
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>Default Agent</label>
              <select
                style={inputStyle}
                value={form.default_agent}
                onChange={(e) => set("default_agent", e.target.value)}
              >
                {Object.entries(AGENTS).map(([key, cfg]) => (
                  <option key={key} value={key}>
                    {cfg.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Cooldown (seconds)</label>
              <input
                type="number"
                style={inputStyle}
                value={form.cooldown_seconds}
                onChange={(e) => set("cooldown_seconds", e.target.value)}
              />
            </div>
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 13,
              color: theme.textMuted,
            }}
          >
            <input
              type="checkbox"
              checked={!!form.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            Enabled
          </label>
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 24 }}>
          <button onClick={onClose} style={secondaryButton()}>
            Cancel
          </button>
          <button onClick={handleSubmit} style={primaryButton()}>
            {mode === "edit" ? "Save" : "Create Heartbeat"}
          </button>
        </div>
      </div>
    </div>
  );
}

function HeartbeatCard({ heartbeat, onAction, onViewDetail }) {
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

function HeartbeatDetailPanel({ heartbeat, ticks, onClose }) {
  const [selectedTickId, setSelectedTickId] = useState<any>(null);
  const [tickOutput, setTickOutput] = useState("");
  const [tickRunning, setTickRunning] = useState(false);
  const outputRef = useRef<any>(null);
  const previousHeartbeatIdRef = useRef(heartbeat.id);

  useEffect(() => {
    const heartbeatChanged = previousHeartbeatIdRef.current !== heartbeat.id;
    previousHeartbeatIdRef.current = heartbeat.id;
    setSelectedTickId((current) => selectTickAfterRefresh(current, ticks, heartbeatChanged));
  }, [heartbeat.id, ticks]);

  useEffect(() => {
    if (!selectedTickId) {
      setTickOutput("");
      setTickRunning(false);
      return;
    }
    let cancelled = false;
    let timeout;
    const load = async () => {
      try {
        const data = await fetchHeartbeatTickOutput(heartbeat.id, selectedTickId);
        if (cancelled) return;
        setTickOutput(data.output || "");
        setTickRunning(!!data.is_running);
        if (data.is_running) {
          timeout = setTimeout(load, 1000);
        }
      } catch {
        if (!cancelled) {
          setTickOutput("");
          setTickRunning(false);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
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
        agent: initialData.agent || DEFAULT_AGENT,
        dag_id: initialData.dag_id || "",
      };
    }
    return {
      title: "",
      prompt: "",
      working_dir: savedDir,
      schedule_type: "immediate",
      cron_expr: "",
      delay_seconds: 60,
      scheduled_at: "",
      max_runs: "",
      tags: "",
      agent: DEFAULT_AGENT,
      dag_id: "",
    };
  });
  const [promptImages, setPromptImages] = useState(() => {
    if (initialData?.prompt_images && Array.isArray(initialData.prompt_images)) {
      return initialData.prompt_images.map((img) => ({
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
      return initialData.dependencies.map((dep) => ({
        task_id: dep.depends_on_task_id,
        inject_result: !!dep.inject_result,
        _input: String(dep.depends_on_task_id),
      }));
    }
    return [];
  });
  const [scheduledAtError, setScheduledAtError] = useState("");

  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const handleImageSelect = (e) => {
    const files = Array.from(e.target.files || []);
    files.forEach((file: any) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result as string; // "data:image/jpeg;base64,..."
        const [meta, data] = dataUrl.split(",");
        const media_type = meta.match(/:(.*?);/)?.[1] || "image/jpeg";
        setPromptImages((prev) => [
          ...prev,
          { name: file.name, media_type, data, preview: dataUrl },
        ]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };

  const removeImage = (idx) => setPromptImages((prev) => prev.filter((_, i) => i !== idx));

  const handleSubmit = () => {
    if (!form.prompt.trim()) return;
    localStorage.setItem("agentforge_working_dir", form.working_dir);

    // Build depends_on list (only valid numeric IDs)
    const depends_on = depRows
      .filter((r) => r.task_id)
      .map((r) => ({ task_id: r.task_id, inject_result: r.inject_result }));

    const data: any = {
      ...form,
      title: form.title || form.prompt.slice(0, 60),
      delay_seconds: form.schedule_type === "delayed" ? parseInt(form.delay_seconds) || 60 : null,
      cron_expr: form.schedule_type === "cron" ? form.cron_expr : null,
      max_runs: form.max_runs ? parseInt(form.max_runs) : null,
      prompt_images: promptImages.map(({ name, media_type, data }) => ({ name, media_type, data })),
      depends_on: mode === "edit" ? depends_on : depends_on.length > 0 ? depends_on : undefined,
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

  const inputStyle = uiField();
  const labelStyle = uiLabel();

  return (
    <div
      style={{
        ...modalOverlay(),
      }}
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} style={modalPanel(520, "82vh")}>
        <h2 style={modalTitle()}>
          {mode === "edit" ? "Edit Task" : mode === "fork" ? "Fork Task" : "New Task"}
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={labelStyle}>Title</label>
            <input
              style={inputStyle}
              placeholder="Task title..."
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
            />
          </div>

          <div>
            <label style={labelStyle}>Prompt *</label>
            <textarea
              style={{ ...inputStyle, height: 100, resize: "vertical" }}
              placeholder="The prompt to send to Claude Code..."
              value={form.prompt}
              onChange={(e) => set("prompt", e.target.value)}
            />
          </div>

          <div>
            <label style={labelStyle}>Images (optional)</label>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: promptImages.length ? 8 : 0,
              }}
            >
              {promptImages.map((img, idx) => (
                <div key={idx} style={{ position: "relative", width: 72, height: 72 }}>
                  <img
                    src={img.preview}
                    alt={img.name}
                    style={{
                      width: 72,
                      height: 72,
                      objectFit: "cover",
                      borderRadius: 6,
                      border: `1px solid ${theme.border}`,
                    }}
                  />
                  <button
                    onClick={() => removeImage(idx)}
                    style={{
                      position: "absolute",
                      top: -6,
                      right: -6,
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      border: "none",
                      background: theme.red || "#e74c3c",
                      color: "#fff",
                      fontSize: 11,
                      cursor: "pointer",
                      lineHeight: "18px",
                      padding: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <label
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 6,
                  border: `1px dashed ${theme.border}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  color: theme.textDim,
                  fontSize: 22,
                  flexShrink: 0,
                }}
              >
                +
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={handleImageSelect}
                />
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
              <input
                style={{ ...inputStyle, flex: 1 }}
                placeholder="~/papers"
                value={form.working_dir}
                onChange={(e) => set("working_dir", e.target.value)}
              />
              {window.electronAPI?.selectDirectory && (
                <button
                  onClick={async () => {
                    const dir = await window.electronAPI.selectDirectory();
                    if (dir) set("working_dir", dir);
                  }}
                  style={{
                    ...secondaryButton(),
                    padding: "0 13px",
                    height: 37,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  Browse
                </button>
              )}
            </div>
          </div>

          <div>
            <label style={labelStyle}>Schedule Type</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {["immediate", "delayed", "scheduled_at", "cron"].map((t) => (
                <button
                  key={t}
                  onClick={() => set("schedule_type", t)}
                  style={segmentedButton(form.schedule_type === t)}
                >
                  {t === "immediate"
                    ? "Immediate"
                    : t === "delayed"
                      ? "Delayed"
                      : t === "scheduled_at"
                        ? "At Time"
                        : "Cron"}
                </button>
              ))}
            </div>
          </div>

          {form.schedule_type === "delayed" && (
            <div>
              <label style={labelStyle}>Delay (seconds)</label>
              <input
                type="number"
                style={inputStyle}
                value={form.delay_seconds}
                onChange={(e) => set("delay_seconds", e.target.value)}
              />
            </div>
          )}

          {form.schedule_type === "scheduled_at" && (
            <div>
              <label style={labelStyle}>Run At (Local Time)</label>
              <input
                type="datetime-local"
                style={inputStyle}
                value={form.scheduled_at}
                onChange={(e) => {
                  set("scheduled_at", e.target.value);
                  setScheduledAtError("");
                }}
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
                <input
                  style={inputStyle}
                  placeholder="*/30 * * * *"
                  value={form.cron_expr}
                  onChange={(e) => set("cron_expr", e.target.value)}
                />
                <div style={{ fontSize: 10, color: theme.textDim, marginTop: 4 }}>
                  e.g. "0 9 * * *" = daily 9am, "*/30 * * * *" = every 30 min
                </div>
              </div>
              <div>
                <label style={labelStyle}>Max Runs (empty = unlimited)</label>
                <input
                  type="number"
                  style={inputStyle}
                  value={form.max_runs}
                  onChange={(e) => set("max_runs", e.target.value)}
                />
              </div>
            </>
          )}

          <div>
            <label style={labelStyle}>Tags (comma separated)</label>
            <input
              style={inputStyle}
              placeholder="paper, review, arxiv"
              value={form.tags}
              onChange={(e) => set("tags", e.target.value)}
            />
          </div>

          {/* ── DAG Dependencies ── */}
          <div>
            <label style={labelStyle}>Dependencies (optional)</label>
            <div style={{ fontSize: 10, color: theme.textDim, marginBottom: 8 }}>
              This task will be blocked until all upstream tasks complete.
            </div>
            {depRows.map((row, idx) => (
              <div
                key={idx}
                style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}
              >
                <input
                  type="number"
                  placeholder="Task ID"
                  value={row._input || ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    const parsed = parseInt(val);
                    setDepRows((prev) =>
                      prev.map((r, i) =>
                        i === idx
                          ? { ...r, _input: val, task_id: isNaN(parsed) ? null : parsed }
                          : r,
                      ),
                    );
                  }}
                  style={{ ...inputStyle, width: 100, flex: "none" }}
                />
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 11,
                    color: theme.textMuted,
                    cursor: "pointer",
                    flex: 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={row.inject_result}
                    onChange={(e) =>
                      setDepRows((prev) =>
                        prev.map((r, i) =>
                          i === idx ? { ...r, inject_result: e.target.checked } : r,
                        ),
                      )
                    }
                    style={{ accentColor: theme.accent }}
                  />
                  Inject result into prompt
                </label>
                <button
                  onClick={() => setDepRows((prev) => prev.filter((_, i) => i !== idx))}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: theme.red,
                    cursor: "pointer",
                    fontSize: 16,
                    padding: "0 4px",
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                setDepRows((prev) => [...prev, { task_id: null, inject_result: false, _input: "" }])
              }
              style={{
                padding: "5px 12px",
                borderRadius: 6,
                border: `1px dashed ${theme.border}`,
                background: theme.surface,
                color: theme.textMuted,
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 650,
              }}
            >
              + Add dependency
            </button>
          </div>

          <div>
            <label style={labelStyle}>DAG ID (optional)</label>
            <input
              style={inputStyle}
              placeholder="my-pipeline"
              value={form.dag_id}
              onChange={(e) => set("dag_id", e.target.value)}
            />
            <div style={{ fontSize: 10, color: theme.textDim, marginTop: 4 }}>
              Group tasks into a named workflow
            </div>
          </div>

          <div>
            <label style={labelStyle}>Agent</label>
            <select
              style={inputStyle}
              value={form.agent}
              onChange={(e) => set("agent", e.target.value)}
            >
              <option value="claude">Claude Code (claude CLI)</option>
              <option value="codex">Codex CLI (openai/codex)</option>
            </select>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 28, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={secondaryButton()}>
            Cancel
          </button>
          <button onClick={handleSubmit} style={primaryButton()}>
            {mode === "edit" ? "Save Changes" : mode === "fork" ? "Create Fork" : "Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailPanel({ task, onClose, onRespond, onResume }: any) {
  // `task` is always truthy here — the only caller renders this inside
  // `{detail && <DetailPanel task={... || detail} />}`. Hooks must stay
  // unconditional, so do not early-return before them.
  const [liveOutput, setLiveOutput] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [resumeError, setResumeError] = useState("");
  const [resumeSent, setResumeSent] = useState(false);
  const [answerText, setAnswerText] = useState("");
  const [responseLoading, setResponseLoading] = useState(false);
  const [responseError, setResponseError] = useState("");
  const [responseResult, setResponseResult] = useState<TaskResponseRefreshResult | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [showMessages, setShowMessages] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showLiveOutput, setShowLiveOutput] = useState(true);
  const liveOutputRef = useRef<any>(null);
  const messagesRef = useRef<any>(null);
  const eventsRef = useRef<any>(null);

  useEffect(() => {
    setLiveOutput("");
    if (task.status !== "running") {
      return;
    }
    let cancelled = false;
    const initialOutput = createIncrementalOutputState();
    let accumulatedOutput = initialOutput.output;
    let nextOffset = initialOutput.nextOffset;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const requestedOffset = nextOffset;
      try {
        const res = await fetch(
          `${API}/tasks/${task.id}/output?offset=${requestedOffset}&unit=characters`,
        );
        if (res.ok && !cancelled) {
          const data = await res.json();
          const update = applyIncrementalOutput(accumulatedOutput, requestedOffset, data);
          accumulatedOutput = update.output;
          nextOffset = update.nextOffset;
          setLiveOutput(accumulatedOutput);
        }
      } catch {
      } finally {
        inFlight = false;
      }
    };
    poll();
    const interval = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
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
    if (!showEvents) return;
    let cancelled = false;
    const load = async () => {
      const nextEvents = await fetchTaskEvents(task.id);
      if (!cancelled) setEvents(nextEvents);
    };
    load();
    if (task.status !== "running") {
      return () => {
        cancelled = true;
      };
    }
    const interval = setInterval(load, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [task.id, task.status, showEvents]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    setAnswerText("");
    setResponseError("");
    setResponseLoading(false);
    setResponseResult(null);
  }, [task.id, task.question, task.answer]);

  const handleResponse = async () => {
    const prepared = prepareTaskResponse(answerText);
    if (prepared.error) {
      setResponseError(prepared.error);
      return;
    }

    setResponseError("");
    setResponseLoading(true);
    try {
      const result = await onRespond(task.id, prepared.answer);
      setAnswerText("");
      setResponseResult({ refreshed: result?.refreshed !== false });
    } catch (error) {
      setResponseError(error instanceof Error ? error.message : "Failed to submit response.");
    } finally {
      setResponseLoading(false);
    }
  };
  const responseUiState = getTaskResponseUiState(task.question, task.answer, responseResult);

  const handleResume = async () => {
    if (!resumeText.trim()) return;
    setResumeError("");
    try {
      const result = await resumeTask(task.id, resumeText.trim());
      if (result?.error) {
        setResumeError(result.error);
        return;
      }
      setResumeText("");
      setResumeSent(true);
      setTimeout(() => setResumeSent(false), 3000);
      onResume();
    } catch (error) {
      setResumeError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        right: 0,
        top: 0,
        bottom: 0,
        width: 480,
        background: theme.surface,
        borderLeft: `1px solid ${theme.border}`,
        zIndex: 999,
        overflow: "auto",
        padding: 28,
        boxShadow: "-8px 0 40px rgba(0,0,0,0.4)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <Badge status={task.status} />
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: theme.textMuted,
            fontSize: 20,
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </div>

      <h2
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: theme.text,
          margin: "0 0 8px",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {task.title}
      </h2>

      <div
        style={{ fontSize: 11, color: theme.textDim, marginBottom: 24, fontFamily: "monospace" }}
      >
        ID: {task.id} · Created: {formatTaskDateTime(task.created_at)}
      </div>

      <Section title="Prompt">
        <pre
          style={{
            background: theme.bg,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            padding: 14,
            fontSize: 12,
            color: theme.text,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
            fontFamily: "'JetBrains Mono', monospace",
            lineHeight: 1.6,
          }}
        >
          {task.prompt}
        </pre>
        {task.prompt_images && task.prompt_images.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div
              style={{
                fontSize: 10,
                color: theme.textMuted,
                fontWeight: 600,
                letterSpacing: 0.8,
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Attached Images ({task.prompt_images.length})
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {task.prompt_images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.media_type};base64,${img.data}`}
                  alt={img.name || `image ${i + 1}`}
                  style={{
                    width: 80,
                    height: 80,
                    objectFit: "cover",
                    borderRadius: 6,
                    border: `1px solid ${theme.border}`,
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </Section>

      {responseUiState !== "hidden" && (
        <Section title="Agent Question">
          <div
            style={{
              background: theme.orangeBg,
              border: `1px solid ${theme.orange}`,
              borderRadius: 8,
              padding: 14,
              fontSize: 12,
              color: theme.text,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: 1.6,
              marginBottom: 12,
            }}
          >
            {task.question}
          </div>
          {responseUiState === "form" ? (
            <>
              <textarea
                value={answerText}
                onChange={(event) => {
                  setAnswerText(event.target.value);
                  if (responseError) setResponseError("");
                }}
                placeholder="Enter your answer..."
                disabled={responseLoading}
                rows={4}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  background: theme.field,
                  color: theme.text,
                  border: `1px solid ${responseError ? theme.red : theme.border}`,
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 12,
                  fontFamily: "'JetBrains Mono', monospace",
                  lineHeight: 1.6,
                  resize: "vertical",
                  outline: "none",
                }}
              />
              {responseError && (
                <div style={{ color: theme.red, fontSize: 11, marginTop: 8 }}>{responseError}</div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                <button
                  onClick={handleResponse}
                  disabled={responseLoading}
                  style={{
                    ...primaryButton(),
                    cursor: responseLoading ? "wait" : "pointer",
                    opacity: responseLoading ? 0.65 : 1,
                  }}
                >
                  {responseLoading ? "Submitting..." : "Submit Answer"}
                </button>
              </div>
            </>
          ) : (
            <div
              style={{
                background: responseUiState === "submitted-stale" ? theme.orangeBg : theme.greenBg,
                border: `1px solid ${
                  responseUiState === "submitted-stale" ? theme.orange : theme.green
                }`,
                borderRadius: 8,
                padding: 12,
                color: theme.text,
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {responseUiState === "submitted-stale"
                ? "Answer submitted, but the task refresh failed. This view may be stale; automatic refresh will retry."
                : "Answer submitted. Refreshing task status..."}
            </div>
          )}
        </Section>
      )}

      <Section title="Configuration">
        <InfoRow label="Working Dir" value={task.working_dir} />
        <InfoRow label="Agent" value={task.agent || DEFAULT_AGENT} />
        <InfoRow label="Schedule" value={task.schedule_type} />
        {task.cron_expr && <InfoRow label="Cron" value={task.cron_expr} />}
        {task.delay_seconds && <InfoRow label="Delay" value={`${task.delay_seconds}s`} />}
        {task.next_run_at && (
          <InfoRow label="Next Run" value={formatTaskDateTime(task.next_run_at)} />
        )}
        <InfoRow
          label="Runs"
          value={`${task.run_count}${task.max_runs ? ` / ${task.max_runs}` : ""}`}
        />
        {task.dag_id && <InfoRow label="DAG" value={task.dag_id} />}
      </Section>

      {/* DAG dependency info */}
      {task.dependencies && task.dependencies.length > 0 && (
        <Section title="Upstream Dependencies">
          {task.dependencies.map((dep) => (
            <div
              key={dep.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "5px 0",
                borderBottom: `1px solid ${theme.border}`,
                fontSize: 12,
              }}
            >
              <span style={{ color: theme.text, fontFamily: "monospace" }}>
                #{dep.depends_on_task_id}
                {dep.depends_on_title ? ` — ${dep.depends_on_title}` : ""}
              </span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {dep.inject_result ? (
                  <span style={{ fontSize: 10, color: theme.accent }}>↳ inject</span>
                ) : null}
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color:
                      dep.depends_on_status === "completed"
                        ? theme.green
                        : dep.depends_on_status === "failed"
                          ? theme.red
                          : theme.orange,
                  }}
                >
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
            {task.dependents.map((id) => `#${id}`).join(", ")}
          </div>
        </Section>
      )}

      {task.status === "running" && (
        <Section
          title={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Live Output</span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 10,
                  color: theme.blue,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: theme.blue,
                    animation: "pulse 1.2s ease-in-out infinite",
                  }}
                />
                live
              </div>
            </div>
          }
        >
          <div
            style={{
              background: theme.bg,
              border: `1px solid ${theme.borderActive}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {/* Toolbar */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 12px",
                background: theme.surface,
                borderBottom: `1px solid ${theme.border}`,
                fontSize: 11,
                color: theme.textMuted,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button
                  onClick={() => setShowLiveOutput(!showLiveOutput)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: theme.textMuted,
                    fontSize: 11,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
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
                    background: "transparent",
                    border: "none",
                    color: theme.textMuted,
                    fontSize: 11,
                    cursor: "pointer",
                    padding: "4px 8px",
                    borderRadius: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  📋 Copy
                </button>
                <button
                  onClick={() => setLiveOutput("")}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: theme.textMuted,
                    fontSize: 11,
                    cursor: "pointer",
                    padding: "4px 8px",
                    borderRadius: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  🗑️ Clear
                </button>
              </div>
            </div>

            {/* Output content */}
            {showLiveOutput && (
              <div
                style={{
                  maxHeight: 400,
                  overflow: "auto",
                  position: "relative",
                }}
                ref={liveOutputRef}
              >
                <pre
                  style={{
                    fontSize: 12,
                    color: theme.text,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    margin: 0,
                    padding: 14,
                    fontFamily: "'JetBrains Mono', monospace",
                    lineHeight: 1.6,
                    minHeight: 60,
                  }}
                >
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
          <pre
            style={{
              background: theme.bg,
              border: `1px solid ${theme.border}`,
              borderRadius: 8,
              padding: 14,
              fontSize: 12,
              color: theme.green,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: 0,
              fontFamily: "'JetBrains Mono', monospace",
              lineHeight: 1.6,
              maxHeight: 300,
              overflow: "auto",
            }}
          >
            {task.result}
          </pre>
        </Section>
      )}

      {task.error && (
        <Section title="Error">
          <pre
            style={{
              background: theme.redBg,
              border: `1px solid rgba(248,113,113,0.2)`,
              borderRadius: 8,
              padding: 14,
              fontSize: 12,
              color: theme.red,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: 0,
              fontFamily: "'JetBrains Mono', monospace",
              lineHeight: 1.6,
            }}
          >
            {task.error}
          </pre>
        </Section>
      )}

      {/* Output History Tabs */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => {
              setShowMessages(!showMessages);
              setShowEvents(false);
            }}
            style={{
              flex: 1,
              padding: "8px 12px",
              borderRadius: 8,
              background: showMessages ? theme.accentGlow : theme.surface,
              color: showMessages ? theme.accent : theme.textMuted,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              border: `1px solid ${showMessages ? theme.accent : theme.border}`,
              transition: "all 0.15s",
            }}
          >
            Conversation
          </button>
          <button
            onClick={() => {
              setShowEvents(!showEvents);
              setShowMessages(false);
            }}
            style={{
              flex: 1,
              padding: "8px 12px",
              borderRadius: 8,
              background: showEvents ? theme.accentGlow : theme.surface,
              color: showEvents ? theme.accent : theme.textMuted,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              border: `1px solid ${showEvents ? theme.accent : theme.border}`,
              transition: "all 0.15s",
            }}
          >
            Execution Events
          </button>
        </div>

        {/* Conversation History */}
        {showMessages && (
          <div
            ref={messagesRef}
            style={{
              maxHeight: 400,
              overflow: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {messages.length === 0 ? (
              <div
                style={{
                  fontSize: 12,
                  color: theme.textDim,
                  padding: "12px 0",
                  textAlign: "center",
                }}
              >
                No conversation data — only tasks run after this feature was added have logs.
              </div>
            ) : (
              messages.map((msg, i) => (
                <div
                  key={i}
                  style={{
                    background: msg.role === "user" ? theme.accentGlow : theme.bg,
                    border: `1px solid ${msg.role === "user" ? theme.accent + "33" : theme.border}`,
                    borderRadius: 8,
                    padding: "10px 14px",
                    borderLeft: `3px solid ${msg.role === "user" ? theme.accent : theme.green}`,
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 0.8,
                      color: msg.role === "user" ? theme.accent : theme.green,
                      textTransform: "uppercase",
                      marginBottom: 6,
                    }}
                  >
                    {msg.role}
                  </div>
                  <pre
                    style={{
                      fontSize: 12,
                      color: theme.text,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      margin: 0,
                      fontFamily: "'JetBrains Mono', monospace",
                      lineHeight: 1.6,
                      maxHeight: 200,
                      overflow: "auto",
                    }}
                  >
                    {msg.text}
                  </pre>
                </div>
              ))
            )}
          </div>
        )}

        {/* Execution Events History */}
        {showEvents && (
          <div ref={eventsRef} style={{ maxHeight: 520, overflow: "auto" }}>
            <ExecutionTimeline events={events} />
          </div>
        )}
      </div>

      {/* Resume completed/failed session */}
      {["completed", "failed"].includes(task.status) && task.session_id && (
        <Section title="Resume Session">
          <div
            style={{
              fontSize: 11,
              color: theme.textDim,
              marginBottom: 10,
              fontFamily: "monospace",
            }}
          >
            Session: {task.session_id}
          </div>
          <textarea
            placeholder="Send a follow-up message to continue this conversation…"
            value={resumeText}
            onChange={(e) => setResumeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleResume();
            }}
            style={{
              width: "100%",
              padding: "10px 14px",
              borderRadius: 8,
              border: `1px solid ${theme.border}`,
              background: theme.bg,
              color: theme.text,
              fontSize: 13,
              outline: "none",
              boxSizing: "border-box",
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              resize: "vertical",
              minHeight: 80,
            }}
          />
          {resumeError && (
            <div style={{ fontSize: 11, color: theme.red, marginTop: 6 }}>{resumeError}</div>
          )}
          {resumeSent && (
            <div style={{ fontSize: 12, color: theme.green, marginTop: 6 }}>
              Sent. The task is waking up again.
            </div>
          )}
          <button
            onClick={handleResume}
            style={{
              marginTop: 10,
              padding: "8px 20px",
              borderRadius: 8,
              border: "none",
              background: theme.accent,
              color: "#fff",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
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
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: theme.textDim,
          letterSpacing: 1.2,
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "6px 0",
        borderBottom: `1px solid ${theme.border}`,
        fontSize: 12,
      }}
    >
      <span style={{ color: theme.textMuted }}>{label}</span>
      <span style={{ color: theme.text, fontFamily: "monospace" }}>{value}</span>
    </div>
  );
}

function SettingsModal({
  onClose,
  timeout: initialTimeout,
  defaultAgent: initialDefaultAgent,
  onSave,
  feishu: initialFeishu,
  onFeishuSave,
  channelsStatus: initialChannelsStatus,
  onChannelsSave,
}) {
  const [tab, setTab] = useState("general");
  const [timeout, setTimeout] = useState(initialTimeout ?? DEFAULT_TIMEOUT_SECONDS);
  const [defaultAgent, setDefaultAgent] = useState(initialDefaultAgent ?? DEFAULT_AGENT);
  const [skillEnabled, setSkillEnabled] = useState(false);
  const [skillSweepAgent, setSkillSweepAgent] = useState(DEFAULT_AGENT);
  const [skillSweepCron, setSkillSweepCron] = useState("0 3 * * *");
  const [generalSaving, setGeneralSaving] = useState(false);
  const [generalMsg, setGeneralMsg] = useState<any>(null);
  const [feishu, setFeishu] = useState({
    feishu_app_id: "",
    feishu_app_secret: "",
    feishu_default_chat_id: "",
    feishu_default_working_dir: "~",
    feishu_enabled: "false",
    ...initialFeishu,
  });
  const [feishuSaving, setFeishuSaving] = useState(false);
  const [feishuMsg, setFeishuMsg] = useState<any>(null); // {ok, text}
  const [channels, setChannels] = useState(createInitialChannelsState(initialChannelsStatus));
  const [channelsSaving, setChannelsSaving] = useState(false);
  const [channelsMsg, setChannelsMsg] = useState<any>(null);
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
    const refreshChannels = async (preserveUserEdits = true) => {
      const status = await fetchChannelsStatus();
      if (!cancelled) {
        setChannels((c) => {
          return mergeChannelsStatus(c, status, {
            preserveEditableFields: preserveUserEdits,
          });
        });
      }
    };
    refreshChannels(false); // initial load: full merge to populate fields
    const intervalId = setInterval(refreshChannels, 2000); // polling: preserve edits
    fetchFeishuSettings().then((s) => {
      if (s && Object.keys(s).length) setFeishu((f) => ({ ...f, ...s }));
    });
    fetchSettings().then((s) => {
      if (s && typeof s === "object") {
        if (typeof s.skill_library_enabled === "boolean") setSkillEnabled(s.skill_library_enabled);
        if (s.skill_sweep_agent) setSkillSweepAgent(s.skill_sweep_agent);
        if (s.skill_sweep_cron) setSkillSweepCron(s.skill_sweep_cron);
      }
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
      setChannels((c) => mergeChannelsStatus(c, updated));
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
    setGeneralSaving(true);
    setGeneralMsg(null);
    try {
      await updateSettings({
        timeout: parseInt(timeout) || DEFAULT_TIMEOUT_SECONDS,
        default_agent: defaultAgent,
        skill_library_enabled: skillEnabled ? "1" : "0",
        skill_sweep_agent: skillSweepAgent,
        skill_sweep_cron: skillSweepCron,
      });
      onSave(parseInt(timeout) || DEFAULT_TIMEOUT_SECONDS, defaultAgent);
      onClose();
    } catch (e) {
      setGeneralMsg({ ok: false, text: String(e) });
    } finally {
      setGeneralSaving(false);
    }
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
      setChannels((c) => mergeChannelsStatus(c, updated));
      if (onChannelsSave) onChannelsSave(updated);
      setChannelsMsg({ ok: true, text: "Saved. Channels restarted." });
    } catch (e) {
      setChannelsMsg({ ok: false, text: String(e) });
    } finally {
      setChannelsSaving(false);
    }
  };

  const fieldStyle = uiField();
  const labelStyle = uiLabel();
  const hintStyle = { fontSize: 10, color: theme.textDim, marginTop: 4 };

  const tabs = ["general", "channels", "feishu"];
  const tabLabel = { general: "General", channels: "Channels", feishu: "Feishu / Lark" };

  return (
    <div
      style={{
        ...modalOverlay(),
      }}
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} style={modalPanel(520, "85vh")}>
        <h2 style={modalTitle()}>Settings</h2>

        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            gap: 3,
            marginBottom: 20,
            padding: 2,
            border: `1px solid ${theme.border}`,
            borderRadius: 7,
            background: theme.field,
          }}
        >
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "7px 12px",
                borderRadius: 5,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 650,
                background: tab === t ? theme.surface : "transparent",
                color: tab === t ? theme.text : theme.textMuted,
              }}
            >
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
                type="number"
                min="10"
                step="10"
                value={timeout}
                onChange={(e) => setTimeout(e.target.value)}
                style={fieldStyle}
              />
              <div style={hintStyle}>
                Default: 12000s (200 min). Max time before a running task is killed.
              </div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Default Agent</label>
              <select
                value={defaultAgent}
                onChange={(e) => setDefaultAgent(e.target.value)}
                style={fieldStyle}
              >
                <option value="claude">Claude Code (claude CLI)</option>
                <option value="codex">Codex CLI (openai/codex)</option>
              </select>
              <div style={hintStyle}>Agent used for new tasks unless overridden per-task.</div>
            </div>

            {/* ── Skill Library ── */}
            <div
              style={{
                marginBottom: 20,
                paddingTop: 16,
                borderTop: `1px solid ${theme.border}`,
              }}
            >
              <label
                style={{
                  ...labelStyle,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={skillEnabled}
                  onChange={(e) => setSkillEnabled(e.target.checked)}
                  style={{ width: 16, height: 16, cursor: "pointer" }}
                />
                Skill Library automatic scans
              </label>
              <div style={hintStyle}>
                Run scheduled sweeps over completed tasks to detect recurring patterns. This uses
                tokens and is off by default. The manual scan button is not affected.
              </div>
            </div>
            {skillEnabled && (
              <>
                <div style={{ marginBottom: 20 }}>
                  <label style={labelStyle}>Sweep Agent</label>
                  <select
                    value={skillSweepAgent}
                    onChange={(e) => setSkillSweepAgent(e.target.value)}
                    style={fieldStyle}
                  >
                    <option value="claude">Claude Code (claude CLI)</option>
                    <option value="codex">Codex CLI (openai/codex)</option>
                  </select>
                  <div style={hintStyle}>Agent used for skill sweeps.</div>
                </div>
                <div style={{ marginBottom: 20 }}>
                  <label style={labelStyle}>Sweep Cadence (cron)</label>
                  <input
                    value={skillSweepCron}
                    onChange={(e) => setSkillSweepCron(e.target.value)}
                    placeholder="0 3 * * *"
                    style={{ ...fieldStyle, fontFamily: "monospace" }}
                  />
                  <div style={hintStyle}>
                    Default: 3 AM daily. Incremental scans only inspect tasks since the last sweep.
                  </div>
                </div>
              </>
            )}

            {generalMsg && (
              <div
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  marginBottom: 16,
                  fontSize: 12,
                  background: theme.redBg,
                  color: theme.red,
                  border: `1px solid ${theme.red}`,
                }}
              >
                {generalMsg.text}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={secondaryButton()}>
                Cancel
              </button>
              <button onClick={handleSaveGeneral} disabled={generalSaving} style={primaryButton()}>
                {generalSaving ? "Saving..." : "Save"}
              </button>
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
                        <svg
                          viewBox="0 0 24 24"
                          width="22"
                          height="22"
                          aria-hidden="true"
                          fill="currentColor"
                        >
                          <path d="M21.4 4.6a1.2 1.2 0 0 0-1.24-.2L3.8 11.15c-.6.25-.57 1.12.05 1.33l4.6 1.62 1.62 4.6c.22.62 1.08.65 1.33.05l6.75-16.36a1.2 1.2 0 0 0-.2-1.24 1.18 1.18 0 0 0-1.22-.3Z" />
                        </svg>
                      </span>
                      <span style={{ fontWeight: 700, fontSize: 14, color: theme.text }}>
                        Telegram
                      </span>
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
                        <span style={{ fontSize: 11, color: theme.textMuted }}>
                          {statusDot.label}
                        </span>
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
                        <div style={hintStyle}>
                          Working directory for tasks created via the Telegram bot.
                        </div>
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
                          Fallback chat for notifications from UI-created tasks (group or user chat
                          ID).
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
                        {[
                          "/newtask <title> | <prompt>",
                          "/list",
                          "/status <id>",
                          "/cancel <id>",
                        ].map((cmd) => (
                          <div key={cmd}>
                            <span style={{ color: theme.cyan }}>{cmd}</span>
                          </div>
                        ))}
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
                          <path
                            fill="#36C5F0"
                            d="M10.1 3.2A2.2 2.2 0 0 1 12.2 1h.7v5.1h-2.8V3.2Z"
                          />
                          <path
                            fill="#2EB67D"
                            d="M20.8 10.1A2.2 2.2 0 0 1 23 12.2v.7h-5.1v-2.8h2.9Z"
                          />
                          <path
                            fill="#ECB22E"
                            d="M13.9 20.8A2.2 2.2 0 0 1 11.8 23h-.7v-5.1h2.8v2.9Z"
                          />
                          <path
                            fill="#E01E5A"
                            d="M3.2 13.9A2.2 2.2 0 0 1 1 11.8v-.7h5.1v2.8H3.2Z"
                          />
                          <path
                            fill="#36C5F0"
                            d="M13.2 4.3a2.7 2.7 0 1 1 5.4 0 2.7 2.7 0 0 1-5.4 0Z"
                          />
                          <path
                            fill="#2EB67D"
                            d="M16.9 13.2a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4Z"
                          />
                          <path
                            fill="#ECB22E"
                            d="M5.4 16.9a2.7 2.7 0 1 1 5.4 0 2.7 2.7 0 0 1-5.4 0Z"
                          />
                          <path
                            fill="#E01E5A"
                            d="M4.3 5.4a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4Z"
                          />
                        </svg>
                      </span>
                      <span style={{ fontWeight: 700, fontSize: 14, color: theme.text }}>
                        Slack
                      </span>
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
                        <span style={{ fontSize: 11, color: theme.textMuted }}>
                          {statusDot.label}
                        </span>
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
                        <div style={hintStyle}>
                          Working directory for tasks created via the Slack bot.
                        </div>
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
                          Slack user ID to DM when tasks have no origin thread (e.g. subtasks
                          created via API). Find your ID in Slack profile → ⋯ → Copy member ID.
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
                        <div style={hintStyle}>
                          Optional. Fallback channel if Default DM User is not set.
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
                        {[
                          "newtask <title> | <prompt>",
                          "list",
                          "status <id>",
                          "cancel <id>",
                          "help",
                        ].map((cmd) => (
                          <div key={cmd}>
                            <span style={{ color: theme.cyan }}>{cmd}</span>
                          </div>
                        ))}
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
                        <svg
                          viewBox="0 0 24 24"
                          width="22"
                          height="22"
                          aria-hidden="true"
                          fill="currentColor"
                        >
                          <path d="M9.2 4.2c-4 0-7.2 2.6-7.2 5.9 0 1.9 1.1 3.6 2.9 4.7l-.9 2.5 2.9-1.5c.7.1 1.4.2 2.2.2 4 0 7.2-2.6 7.2-5.9S13.2 4.2 9.2 4.2Zm-2.7 4.8a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Zm5.4 0a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z" />
                          <path
                            d="M16.8 9.1c-3 0-5.5 2-5.5 4.5 0 2.5 2.4 4.5 5.5 4.5.6 0 1.2-.1 1.8-.2l2.4 1.2-.7-2c1.5-.8 2.5-2.1 2.5-3.6 0-2.5-2.4-4.4-5.5-4.4Zm-1.9 4a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4Zm3.8 0a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4Z"
                            opacity="0.88"
                          />
                        </svg>
                      </span>
                      <span style={{ fontWeight: 700, fontSize: 14, color: theme.text }}>
                        Wechat
                      </span>
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
                        <span style={{ fontSize: 11, color: theme.textMuted }}>
                          {statusDot.label}
                        </span>
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
                          Optional. Leave empty to let the bridge adopt the account id returned by
                          QR login.
                        </div>
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
                            <div style={{ marginTop: 10, fontSize: 11, color: theme.red }}>
                              {ch.last_error}
                            </div>
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
            })()}

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
                onClick={handleSaveChannels}
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
        )}

        {/* ── Feishu tab ── */}
        {tab === "feishu" && (
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
                <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>
                  Enable Feishu Bot
                </div>
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
                  onChange={(e) =>
                    setFeishu((f) => ({ ...f, feishu_default_chat_id: e.target.value }))
                  }
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
                <span style={{ color: theme.cyan }}>/resume &lt;id&gt; &lt;msg&gt;</span> — resume a
                task session
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
                onClick={handleSaveFeishu}
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
        )}
      </div>
    </div>
  );
}

// ─── App ───

function parseSkillFrontmatter(body) {
  const m = (body || "").match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return { name: "", description: "" };
  const out = { name: "", description: "" };
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === "name" && !out.name) out.name = v;
    if (k === "description" && !out.description) out.description = v;
  }
  return out;
}

function SkillKindBadge({ kind }) {
  const isPitfall = kind === "pitfall";
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        padding: "2px 7px",
        borderRadius: 6,
        letterSpacing: 0.4,
        background: isPitfall ? "rgba(239,68,68,0.15)" : "rgba(34,197,94,0.15)",
        color: isPitfall ? theme.red : theme.green,
      }}
    >
      {isPitfall ? "PITFALL" : "RECIPE"}
    </span>
  );
}

function SkillPatternCard({ p, tasks, onDraft, onApprove, onDismiss }) {
  let taskIds = [];
  try {
    taskIds = JSON.parse(p.contributing_task_ids || "[]");
  } catch {
    /* ignore */
  }
  const taskCount = taskIds.length;
  const ready = p.recurrence_count >= 3 && taskCount >= 2;
  const draftStatus = p.draft_status;
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState(p.draft_body || "");
  // The full SKILL.md is the single source of truth (name + description live in
  // its frontmatter). Sync the buffer when a fresh draft arrives.
  useEffect(() => {
    if (draftStatus === "ready") setBody(p.draft_body || "");
  }, [draftStatus, p.draft_body]);

  const borderColor =
    p.status === "promoted" ? theme.green : p.status === "candidate" ? theme.accent : theme.border;
  const muted = p.status === "dismissed";

  const btn = (bg, color) => ({
    padding: "6px 14px",
    borderRadius: 7,
    border: bg === "transparent" ? `1px solid ${theme.border}` : "none",
    background: bg,
    color,
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 700,
  });

  return (
    <div
      style={{
        background: theme.columnBg,
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        padding: 16,
        boxShadow: theme.shadowSoft,
        opacity: muted ? 0.5 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <SkillKindBadge kind={p.kind} />
        <span style={{ fontFamily: "monospace", fontSize: 12, color: theme.text, fontWeight: 700 }}>
          {p.pattern_key}
        </span>
      </div>
      <div
        style={{
          color: theme.textMuted,
          fontSize: 13,
          marginBottom: 10,
          lineHeight: 1.5,
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2,
          overflow: "hidden",
        }}
      >
        {p.summary || "—"}
      </div>
      <div
        style={{
          display: "flex",
          gap: 12,
          fontSize: 11,
          color: theme.textDim,
          marginBottom: 10,
          alignItems: "center",
        }}
      >
        <span>Recurs {p.recurrence_count}x</span>
        <span>
          {taskCount} {taskCount === 1 ? "task" : "tasks"}
        </span>
        <span>{p.status}</span>
        {ready && p.status !== "promoted" && (
          <span style={{ color: theme.accent, fontWeight: 700 }}>Ready</span>
        )}
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            marginLeft: "auto",
            background: "transparent",
            border: "none",
            color: theme.accent,
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {expanded ? "Hide" : "Details"}
        </button>
      </div>

      {expanded && (
        <div
          style={{
            background: theme.bg,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            padding: 10,
            marginBottom: 10,
            fontSize: 11,
            color: theme.textMuted,
          }}
        >
          <div style={{ marginBottom: 6 }}>
            <span style={{ color: theme.textDim }}>First seen </span>
            {(p.first_seen || "").replace("T", " ").slice(0, 19) || "—"}
            <span style={{ color: theme.textDim }}> · Last seen </span>
            {(p.last_seen || "").replace("T", " ").slice(0, 19) || "—"}
          </div>
          <div style={{ color: theme.textDim, marginBottom: 4 }}>
            Contributing tasks ({taskCount}):
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {taskIds.length === 0 && <span style={{ color: theme.textDim }}>—</span>}
            {taskIds.map((tid) => {
              const t = (tasks || []).find((x) => x.id === tid);
              return (
                <span key={tid} style={{ fontFamily: "monospace" }}>
                  #{tid} {t ? t.title : <span style={{ color: theme.textDim }}>(deleted)</span>}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {draftStatus === "ready" && p.draft_worthy !== null && p.draft_worthy !== undefined && (
        <div
          style={{
            fontSize: 11,
            padding: "7px 10px",
            borderRadius: 7,
            marginBottom: 8,
            background: p.draft_worthy ? "rgba(34,197,94,0.12)" : "rgba(245,158,11,0.14)",
            color: p.draft_worthy ? theme.green : "#f59e0b",
            border: `1px solid ${p.draft_worthy ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.35)"}`,
          }}
        >
          {p.draft_worthy
            ? "Agent recommends turning this into a skill"
            : "Agent thinks this may have limited value. You can still approve or reject it."}
          {p.draft_worthiness_reason ? `: ${p.draft_worthiness_reason}` : ""}
        </div>
      )}

      {p.status === "promoted" && (
        <div style={{ fontSize: 12, color: theme.green, fontWeight: 700 }}>Promoted to Skill</div>
      )}

      {(p.status === "candidate" || p.status === "tracking") &&
        draftStatus !== "ready" &&
        draftStatus !== "drafting" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={() => onDraft(p.id)} style={btn(theme.accent, "#fff")}>
              {draftStatus === "error" ? "Retry Distill" : "Distill Skill"}
            </button>
            <button onClick={() => onDismiss(p.id)} style={btn("transparent", theme.textMuted)}>
              Reject
            </button>
            {p.status === "tracking" && (
              <span style={{ color: theme.textDim, fontSize: 11 }}>
                Below the automatic threshold. You can still distill it manually.
              </span>
            )}
            {draftStatus === "error" && (
              <span style={{ color: theme.red, fontSize: 11 }}>
                Distill failed: {p.draft_error}
              </span>
            )}
          </div>
        )}

      {draftStatus === "drafting" && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>Distilling…</div>
      )}

      {draftStatus === "ready" &&
        (() => {
          const fm = parseSkillFrontmatter(body);
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* preview header */}
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    fontFamily: "ui-monospace, Menlo, monospace",
                    fontSize: 12,
                    fontWeight: 800,
                    color: theme.accent,
                    background: theme.accentGlow,
                    padding: "3px 9px",
                    borderRadius: 6,
                  }}
                >
                  {fm.name || "(no name)"}
                </span>
                <span style={{ fontSize: 11, color: theme.textDim }}>
                  → ~/.claude/skills/{fm.name || "…"}/SKILL.md
                </span>
              </div>
              {fm.description && (
                <div style={{ fontSize: 12, color: theme.textMuted, lineHeight: 1.55 }}>
                  {fm.description}
                </div>
              )}
              {/* editor */}
              <div>
                <div
                  style={{
                    fontSize: 10.5,
                    color: theme.textDim,
                    marginBottom: 5,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                  }}
                >
                  SKILL.md · editable. Frontmatter controls the name and trigger description.
                </div>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={16}
                  spellCheck={false}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "12px 14px",
                    borderRadius: 10,
                    border: `1px solid ${theme.border}`,
                    background: theme.bg,
                    color: theme.text,
                    fontSize: 12,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    lineHeight: 1.65,
                    resize: "vertical",
                    outline: "none",
                  }}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => onApprove(p.id, { body })}
                  style={{ ...btn(theme.green, "#fff"), padding: "8px 18px", fontSize: 12 }}
                >
                  Approve and Write
                </button>
                <button
                  onClick={() => onDismiss(p.id)}
                  style={{
                    ...btn("transparent", theme.textMuted),
                    padding: "8px 18px",
                    fontSize: 12,
                  }}
                >
                  Reject
                </button>
              </div>
            </div>
          );
        })()}
    </div>
  );
}

function SkillRegistryCard({ s, tasks, onToggle, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  let sourceTaskIds = [];
  try {
    sourceTaskIds = JSON.parse(s.source_task_ids || "[]");
  } catch {
    /* ignore */
  }

  const toggleDetail = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && content === null) {
      setLoading(true);
      try {
        const res = await fetch(`${API}/skills/${s.id}/content`);
        const d = await res.json();
        setContent(d.content ?? "");
      } catch (e) {
        setContent(`(failed to load: ${e.message})`);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div
      style={{
        background: theme.columnBg,
        border: `1px solid ${theme.border}`,
        borderRadius: 8,
        padding: 14,
        boxShadow: theme.shadowSoft,
        opacity: s.enabled ? 1 : 0.55,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <SkillKindBadge kind={s.kind} />
        <span style={{ fontFamily: "monospace", fontSize: 12, color: theme.text, fontWeight: 700 }}>
          {s.name}
        </span>
        <button
          onClick={toggleDetail}
          style={{
            marginLeft: "auto",
            background: "transparent",
            border: "none",
            color: theme.accent,
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {expanded ? "Hide" : "View SKILL.md"}
        </button>
      </div>
      <div
        style={{
          color: theme.textMuted,
          fontSize: 12,
          marginBottom: 10,
          lineHeight: 1.5,
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2,
          overflow: "hidden",
        }}
      >
        {s.description || "—"}
      </div>

      {expanded && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: theme.textDim, marginBottom: 6 }}>
            <span style={{ fontFamily: "monospace" }}>{s.path}</span>
            {s.source_pattern_key && <span> · Source pattern: {s.source_pattern_key}</span>}
            {sourceTaskIds.length > 0 && (
              <span>
                {" "}
                · Source tasks:{" "}
                {sourceTaskIds
                  .map((tid) => {
                    const t = (tasks || []).find((x) => x.id === tid);
                    return `#${tid}${t ? " (" + t.title + ")" : ""}`;
                  })
                  .join(", ")}
              </span>
            )}
          </div>
          <pre
            style={{
              margin: 0,
              padding: "12px 14px",
              borderRadius: 10,
              border: `1px solid ${theme.border}`,
              background: theme.bg,
              color: theme.text,
              fontSize: 12,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
            }}
          >
            {loading ? "Loading…" : content}
          </pre>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: theme.textDim,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={!!s.enabled}
            onChange={(e) => onToggle(s.id, e.target.checked)}
            style={{ cursor: "pointer" }}
          />
          {s.enabled ? "Enabled for Claude/Codex" : "Disabled (symlinks removed)"}
        </label>
        <button
          onClick={() => onDelete(s.id)}
          style={{
            marginLeft: "auto",
            padding: "4px 10px",
            borderRadius: 6,
            border: `1px solid ${theme.border}`,
            background: "transparent",
            color: theme.red,
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function SkillsView({
  skillData,
  skills,
  tasks,
  filter,
  onDraft,
  onApprove,
  onDismiss,
  onToggleSkill,
  onDeleteSkill,
}) {
  // Only recurrence >= 2 is worth surfacing; single-occurrence rows are noise.
  // (The backend still tracks them so the count can accumulate across sweeps.)
  const patterns = (skillData.patterns || []).filter((p) => p.recurrence_count >= 2);
  const skillQuery = (filter || "").trim().toLowerCase();
  const matchesQuery = (values) => {
    if (!skillQuery) return true;
    return values.some((value) =>
      String(value ?? "")
        .toLowerCase()
        .includes(skillQuery),
    );
  };
  const taskTitle = (id) => (tasks || []).find((t) => t.id === id)?.title || "";
  const parseIds = (raw) => {
    try {
      return JSON.parse(raw || "[]");
    } catch {
      return [];
    }
  };
  const filteredSkills = (skills || []).filter((s) =>
    matchesQuery([
      s.name,
      s.description,
      s.kind,
      s.path,
      s.source_pattern_key,
      s.enabled ? "enabled" : "disabled",
      ...parseIds(s.source_task_ids).map(taskTitle),
    ]),
  );
  const filteredPatterns = patterns.filter((p) =>
    matchesQuery([
      p.pattern_key,
      p.summary,
      p.kind,
      p.status,
      p.draft_status,
      p.draft_error,
      p.draft_worthiness_reason,
      p.draft_body,
      ...parseIds(p.contributing_task_ids).map(taskTitle),
    ]),
  );
  const sweep = skillData.sweep || {};
  const running = sweep.running;
  const last = sweep.last;
  let lastNote = null;
  if (running) {
    lastNote = "Sweep running…";
  } else if (last) {
    lastNote = last.error
      ? `Last sweep failed: ${last.error}`
      : last.scanned === 0
        ? `Last sweep: no completed tasks to analyze (agent ${last.agent})`
        : `Last sweep: analyzed ${last.scanned} tasks, added ${last.new ?? 0} recurrences, found ${last.candidates ?? 0} candidates (agent ${last.agent})`;
  }
  const [showRegistry, setShowRegistry] = useState(true);
  const [showPatterns, setShowPatterns] = useState(true);

  const sectionHeader = (label, count, open, toggle) => (
    <button
      onClick={toggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "auto",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: theme.text,
        fontSize: 13,
        fontWeight: 700,
        padding: 0,
        marginBottom: 10,
      }}
    >
      <span style={{ color: theme.textDim, fontSize: 11 }}>{open ? "▼" : "▶"}</span>
      {label}
      <span style={{ color: theme.textDim, fontWeight: 600 }}>({count})</span>
    </button>
  );

  return (
    <div style={{ padding: 20, minHeight: "calc(100vh - 148px)" }}>
      <div
        style={{
          marginBottom: 18,
          minHeight: 30,
          maxWidth: 920,
        }}
      >
        <div style={{ color: theme.textMuted, fontSize: 12 }}>
          Cross-task recurrence ledger. Recurrence &gt;= 2 can be distilled manually; recurrence
          &gt;= 3 across 2+ tasks becomes a candidate.
          {lastNote && <span style={{ marginLeft: 10, color: theme.textDim }}>· {lastNote}</span>}
        </div>
      </div>

      {(skills || []).length > 0 && (
        <div style={{ marginBottom: 26 }}>
          {sectionHeader(
            "Installed Skills",
            skillQuery ? `${filteredSkills.length}/${skills.length}` : skills.length,
            showRegistry,
            () => setShowRegistry((v) => !v),
          )}
          {showRegistry &&
            (filteredSkills.length === 0 ? (
              <div
                style={{
                  border: `1px dashed ${theme.border}`,
                  borderRadius: 8,
                  padding: 28,
                  textAlign: "center",
                  color: theme.textDim,
                  fontSize: 12,
                  background: theme.field,
                  maxWidth: 520,
                }}
              >
                No installed skills match this search.
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 380px), 520px))",
                  gap: 12,
                  justifyContent: "start",
                }}
              >
                {filteredSkills.map((s) => (
                  <SkillRegistryCard
                    key={s.id}
                    s={s}
                    tasks={tasks}
                    onToggle={onToggleSkill}
                    onDelete={onDeleteSkill}
                  />
                ))}
              </div>
            ))}
        </div>
      )}

      {sectionHeader(
        "Detected Patterns",
        skillQuery ? `${filteredPatterns.length}/${patterns.length}` : patterns.length,
        showPatterns,
        () => setShowPatterns((v) => !v),
      )}
      {showPatterns &&
        (filteredPatterns.length === 0 ? (
          <div
            style={{
              border: `1px dashed ${theme.border}`,
              borderRadius: 8,
              padding: 32,
              textAlign: "center",
              color: theme.textDim,
              fontSize: 12,
              background: theme.field,
              maxWidth: 520,
            }}
          >
            {patterns.length === 0
              ? "No patterns with recurrence >= 2 yet. Run a scan to analyze recent completed tasks."
              : "No detected patterns match this search."}
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 380px), 520px))",
              gap: 14,
              justifyContent: "start",
            }}
          >
            {filteredPatterns.map((p) => (
              <SkillPatternCard
                key={p.id}
                p={p}
                tasks={tasks}
                onDraft={onDraft}
                onApprove={onApprove}
                onDismiss={onDismiss}
              />
            ))}
          </div>
        ))}
    </div>
  );
}

export default function App() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [heartbeats, setHeartbeats] = useState<any[]>([]);
  const [heartbeatTicks, setHeartbeatTicks] = useState<any[]>([]);
  const [skillData, setSkillData] = useState({
    patterns: [],
    sweep: { running: false, last: null },
  });
  const [skills, setSkills] = useState<any[]>([]);
  const [activeView, setActiveView] = useState<MainView>("tasks");
  const [showNew, setShowNew] = useState(false);
  const [showNewHeartbeat, setShowNewHeartbeat] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [heartbeatDetail, setHeartbeatDetail] = useState<any>(null);
  const [connected, setConnected] = useState(false);
  const [filters, setFilters] = useState({ tasks: "", heartbeats: "", skills: "" });
  const [taskTimeout, setTaskTimeout] = useState(DEFAULT_TIMEOUT_SECONDS);
  const [defaultAgent, setDefaultAgent] = useState(DEFAULT_AGENT);
  const [feishuSettings, setFeishuSettings] = useState<any>({});
  const [channelsStatus, setChannelsStatus] = useState<any>({});
  const [backendReady, setBackendReady] = useState(false);
  const [backendError, setBackendError] = useState<any>(null);
  const [apiError, setApiError] = useState<any>(null);
  const [editingTask, setEditingTask] = useState<any>(null);
  const [forkingTask, setForkingTask] = useState<any>(null);
  const [editingHeartbeat, setEditingHeartbeat] = useState<any>(null);
  const pollGuardRef = useRef(createRequestGenerationGuard());
  const heartbeatDetailId = heartbeatDetail?.id;
  const submittedTaskAnswersRef = useRef<Record<string, string>>({});
  const detailRequestCoordinatorRef = useRef<DetailRequestCoordinator | null>(null);
  if (detailRequestCoordinatorRef.current === null) {
    detailRequestCoordinatorRef.current = new DetailRequestCoordinator();
  }

  // ─── Color mode ───
  const [colorMode, setColorMode] = useState(() => localStorage.getItem("colorMode") || "system");
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
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
        const res = await fetchWithTimeout(`${API}/health`, 800);
        if (res.ok) {
          if (!cancelled) setBackendReady(true);
          return;
        }
      } catch {
        /* not ready yet */
      }
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setBackendError("Backend did not start within 20 seconds.");
        return;
      }
      setTimeout(probe, 300);
    };
    probe();
    return () => {
      cancelled = true;
    };
  }, []);

  const poll = useCallback(async () => {
    const generation = pollGuardRef.current.begin();
    try {
      const data = await fetchMainViewData(activeView, API);
      if (!pollGuardRef.current.isCurrent(generation)) return;
      if (data.tasks !== undefined) {
        const reconciled = reconcileTasksWithSubmittedAnswers(
          data.tasks,
          submittedTaskAnswersRef.current,
        );
        submittedTaskAnswersRef.current = Object.fromEntries(
          reconciled.pendingSubmissionIds.map((id) => [id, submittedTaskAnswersRef.current[id]]),
        );
        setTasks(reconciled.tasks);
        setDetail((current) => {
          if (!current) return current;
          const summary = reconciled.tasks.find((task) => task.id === current.id);
          return mergeTaskSummaryIntoDetail(current, summary);
        });
      }
      if (data.heartbeats !== undefined) setHeartbeats(data.heartbeats);
      if (data.skillData !== undefined) setSkillData(data.skillData);
      if (data.skills !== undefined) setSkills(data.skills);
      setConnected(true);
      setApiError(null);
      return true;
    } catch (err) {
      if (!pollGuardRef.current.isCurrent(generation)) return;
      setConnected(false);
      setApiError(`Failed to refresh ${activeView}: ${err.message}`);
      return false;
    }
  }, [activeView]);

  useEffect(() => {
    if (!backendReady) return;
    const pollGuard = pollGuardRef.current;
    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      clearInterval(interval);
      pollGuard.invalidate();
    };
  }, [poll, backendReady]);

  useEffect(() => {
    if (!heartbeatDetailId) return;

    return startHeartbeatTickPolling({
      heartbeatId: heartbeatDetailId,
      load: fetchHeartbeatTicks,
      onTicks: setHeartbeatTicks,
      onError: (error) =>
        setApiError(
          `Failed to fetch heartbeat ticks: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
    });
  }, [heartbeatDetailId]);

  useEffect(() => {
    if (!backendReady) return;
    fetchSettings().then((s) => {
      if (s.timeout) setTaskTimeout(s.timeout);
      if (s.default_agent) setDefaultAgent(s.default_agent);
    });
    fetchFeishuSettings().then((s) => setFeishuSettings(s));
    fetchChannelsStatus().then((s) => setChannelsStatus(s));
  }, [backendReady]);

  useEffect(() => {
    return () => detailRequestCoordinatorRef.current?.invalidate();
  }, []);

  const openTaskDetail = useCallback((task) => {
    return loadLatestTaskDetail(
      task.id,
      detailRequestCoordinatorRef.current!,
      fetchTask,
      setDetail,
      (error) =>
        setApiError(
          `Failed to fetch task details: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }, []);
  const closeTaskDetail = useCallback(() => {
    detailRequestCoordinatorRef.current?.invalidate();
    setDetail(null);
  }, []);
  const switchActiveView = useCallback((view: MainView) => {
    pollGuardRef.current.invalidate();
    setActiveView(view);
  }, []);

  const handleAction = useCallback(
    async (action, id) => {
      try {
        if (action === "cancel") await cancelTask(id);
        else if (action === "retry") await retryTask(id);
        else if (action === "delete") {
          await deleteTask(id);
          setDetail((current) => (current?.id === id ? null : current));
        } else if (action === "edit") {
          setEditingTask(await fetchTask(id));
          return;
        } else if (action === "fork") {
          setForkingTask(await fetchTask(id));
          return;
        }
        poll();
      } catch (e) {
        setApiError(`${action} failed: ${e.message}`);
      }
    },
    [poll],
  );

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
        const heartbeat = heartbeats.find((h) => h.id === id);
        if (heartbeat) setEditingHeartbeat(heartbeat);
        return;
      }
      poll();
    } catch (e) {
      setApiError(`Heartbeat ${action} failed: ${e.message}`);
    }
  };

  const handleSweep = async () => {
    try {
      await triggerSkillSweep();
      // Optimistically reflect the running state; poll picks up the real status.
      setSkillData((prev) => ({ ...prev, sweep: { ...prev.sweep, running: true } }));
      setTimeout(poll, 1500);
    } catch (e) {
      setApiError(`Sweep failed: ${e.message}`);
    }
  };

  const handleSkillDraft = async (id) => {
    try {
      await triggerSkillDraft(id);
      setTimeout(poll, 1500);
    } catch (e) {
      setApiError(`Distill failed: ${e.message}`);
    }
  };

  const handleSkillApprove = async (id, data) => {
    try {
      await approveSkill(id, data);
      poll();
    } catch (e) {
      setApiError(`Approve failed: ${e.message}`);
    }
  };

  const handleSkillDismiss = async (id) => {
    try {
      await dismissSkillPattern(id);
      poll();
    } catch (e) {
      setApiError(`Dismiss failed: ${e.message}`);
    }
  };

  const handleSkillToggle = async (id, enabled) => {
    try {
      await setSkillEnabledApi(id, enabled);
      poll();
    } catch (e) {
      setApiError(`Toggle skill failed: ${e.message}`);
    }
  };

  const handleSkillDelete = async (id) => {
    try {
      await deleteSkillApi(id);
      poll();
    } catch (e) {
      setApiError(`Delete skill failed: ${e.message}`);
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
    } catch (e) {
      setApiError(`Respond failed: ${e.message}`);
      throw e;
    }

    submittedTaskAnswersRef.current[String(id)] = answer;
    setTasks((current) => current.map((task) => markTaskResponseSubmitted(task, id, answer)));
    setDetail((current) =>
      current?.id === id ? markTaskResponseSubmitted(current, id, answer) : current,
    );

    const refreshed = await attemptTargetedTaskRefresh({
      load: () => fetchTask(id),
      onTask: (refreshedTask) => {
        const responseStillPending = taskNeedsResponse(
          refreshedTask.question,
          refreshedTask.answer,
        );
        if (responseStillPending) {
          submittedTaskAnswersRef.current[String(id)] = answer;
        } else {
          delete submittedTaskAnswersRef.current[String(id)];
        }
        const safeTask = responseStillPending
          ? markTaskResponseSubmitted(refreshedTask, id, answer)
          : refreshedTask;
        setTasks((current) => current.map((task) => (task.id === id ? safeTask : task)));
        setDetail((current) => mergeTargetedTaskDetail(current, id, safeTask));
      },
      onError: () => {
        setApiError("Answer submitted, but task details have not refreshed yet.");
      },
    });
    return { refreshed };
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

  const openHeartbeatDetail = (heartbeat) => {
    if (heartbeatDetail?.id !== heartbeat.id) setHeartbeatTicks([]);
    setHeartbeatDetail(heartbeat);
  };

  const filter =
    activeView === "tasks"
      ? filters.tasks
      : activeView === "heartbeats"
        ? filters.heartbeats
        : activeView === "skills"
          ? filters.skills
          : "";
  const setActiveFilter = (value) => {
    setFilters((prev) =>
      activeView === "tasks"
        ? { ...prev, tasks: value }
        : activeView === "heartbeats"
          ? { ...prev, heartbeats: value }
          : activeView === "skills"
            ? { ...prev, skills: value }
            : prev,
    );
  };
  const searchPlaceholder =
    activeView === "tasks"
      ? "Search tasks"
      : activeView === "heartbeats"
        ? "Search heartbeats"
        : activeView === "skills"
          ? "Search skills"
          : "";

  const filtered = useMemo(() => {
    const query = filters.tasks.trim().toLowerCase();
    if (!query) return tasks;
    return tasks.filter(
      (task) =>
        task.title.toLowerCase().includes(query) || task.tags?.toLowerCase().includes(query),
    );
  }, [filters.tasks, tasks]);
  const tasksByColumn = useMemo(
    () =>
      Object.fromEntries(
        COLUMNS.map((column) => [
          column.key,
          filtered.filter((task) => column.statuses.includes(task.status)),
        ]),
      ),
    [filtered],
  );
  const filteredHeartbeats = useMemo(() => {
    const query = filters.heartbeats.trim().toLowerCase();
    if (!query) return heartbeats;
    return heartbeats.filter(
      (heartbeat) =>
        heartbeat.name.toLowerCase().includes(query) ||
        heartbeat.check_prompt.toLowerCase().includes(query),
    );
  }, [filters.heartbeats, heartbeats]);
  const { runningCount, queueCount, doneCount } = useMemo(() => {
    let running = 0;
    let queued = 0;
    let done = 0;
    for (const task of tasks) {
      if (task.status === "running") running += 1;
      else if (["pending", "scheduled", "blocked"].includes(task.status)) queued += 1;
      else if (["completed", "failed", "cancelled"].includes(task.status)) done += 1;
    }
    return { runningCount: running, queueCount: queued, doneCount: done };
  }, [tasks]);
  const enabledHeartbeatCount = heartbeats.filter((h) => h.enabled).length;
  const pausedHeartbeatCount = Math.max(heartbeats.length - enabledHeartbeatCount, 0);
  const heartbeatIssueCount = heartbeats.filter((h) => h.last_error).length;
  const enabledSkillCount = skills.filter((s) => s.enabled).length;
  const pausedSkillCount = Math.max(skills.length - enabledSkillCount, 0);
  const skillPatternCount = (skillData.patterns || []).filter(
    (p) => p.recurrence_count >= 2,
  ).length;
  const activeSummary = {
    home: {
      label: "Welcome to AgentForge",
      tone: theme.accent,
      background: theme.accentGlow,
      metrics: [
        { label: "Tasks", value: tasks.length, tone: theme.blue },
        { label: "Heartbeats", value: heartbeats.length, tone: theme.cyan },
        { label: "Skills", value: skills.length, tone: theme.accent },
        { label: "Running", value: runningCount, tone: theme.green },
      ],
    },
    tasks: {
      label: `${runningCount} running / ${queueCount} queued`,
      tone: runningCount > 0 ? theme.blue : theme.green,
      background: runningCount > 0 ? theme.blueBg : theme.greenBg,
      metrics: [
        { label: "Total", value: tasks.length },
        { label: "Queue", value: queueCount, tone: theme.orange },
        { label: "Running", value: runningCount, tone: theme.blue },
        { label: "Done", value: doneCount, tone: theme.green },
      ],
    },
    heartbeats: {
      label:
        heartbeatIssueCount > 0
          ? `${enabledHeartbeatCount} enabled / ${heartbeatIssueCount} issues`
          : `${enabledHeartbeatCount} enabled / ${pausedHeartbeatCount} paused`,
      tone: heartbeatIssueCount > 0 ? theme.orange : theme.cyan,
      background: heartbeatIssueCount > 0 ? theme.orangeBg : theme.cyanBg,
      metrics: [
        { label: "Total", value: heartbeats.length },
        { label: "Enabled", value: enabledHeartbeatCount, tone: theme.green },
        { label: "Paused", value: pausedHeartbeatCount, tone: theme.textMuted },
        {
          label: "Issues",
          value: heartbeatIssueCount,
          tone: heartbeatIssueCount ? theme.orange : theme.green,
        },
      ],
    },
    skills: {
      label: `${enabledSkillCount} enabled / ${skillPatternCount} patterns`,
      tone: theme.accent,
      background: theme.accentGlow,
      metrics: [
        { label: "Installed", value: skills.length },
        { label: "Enabled", value: enabledSkillCount, tone: theme.green },
        { label: "Paused", value: pausedSkillCount, tone: theme.textMuted },
        { label: "Patterns", value: skillPatternCount, tone: theme.accent },
      ],
    },
  }[activeView];

  if (backendError) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: theme.bg,
          color: theme.red,
          gap: 12,
          fontFamily: "inherit",
        }}
      >
        <div style={{ fontSize: 32 }}>✕</div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Backend failed to start</div>
        <div style={{ fontSize: 12, color: theme.textMuted, maxWidth: 400, textAlign: "center" }}>
          {backendError}
        </div>
      </div>
    );
  }

  if (!backendReady) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: theme.bg,
          color: theme.textMuted,
          gap: 16,
          fontFamily: "inherit",
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            border: `3px solid ${theme.border}`,
            borderTopColor: theme.accent,
            animation: "spin 0.8s linear infinite",
          }}
        />
        <div style={{ fontSize: 13 }}>Starting backend…</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: theme.bg,
        backgroundImage: theme.boardBg,
        color: theme.text,
        fontFamily: APP_FONT_STACK,
      }}
    >
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} } @keyframes deckIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      {/* API error toast */}
      {apiError && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: theme.surface,
            border: `1px solid ${theme.red}`,
            borderRadius: 8,
            padding: "10px 16px",
            boxShadow: `0 4px 24px rgba(0,0,0,0.5)`,
            color: theme.red,
            fontSize: 12,
            fontWeight: 500,
            maxWidth: 480,
          }}
        >
          <span style={{ flexShrink: 0 }}>✕</span>
          <span style={{ flex: 1 }}>{apiError}</span>
          <button
            onClick={() => setApiError(null)}
            style={{
              background: "none",
              border: "none",
              color: theme.textMuted,
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
              padding: "0 0 0 8px",
              flexShrink: 0,
            }}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      {/* Header */}
      <div
        style={{
          borderBottom: `1px solid ${theme.headerBorder}`,
          padding: "12px 20px",
          backdropFilter: "blur(16px)",
          position: "sticky",
          top: 0,
          zIndex: 100,
          background: theme.headerBg,
          animation: "deckIn 0.25s ease",
        }}
      >
        <div
          className="app-topbar"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 218 }}>
            <BrandMark size={34} />
            <div>
              <div
                style={{
                  fontSize: 17,
                  fontWeight: 780,
                  fontFamily: DISPLAY_FONT_STACK,
                  letterSpacing: 0,
                  lineHeight: 1,
                }}
              >
                AgentForge
              </div>
              <div style={{ fontSize: 11, color: theme.textDim, marginTop: 4, fontWeight: 650 }}>
                Agent orchestration board
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minWidth: 0,
              flex: 1,
              justifyContent: "center",
            }}
          >
            <StatusPill
              connected={connected}
              label={activeSummary.label}
              tone={activeSummary.tone}
              background={activeSummary.background}
            />
          </div>

          <div className="app-toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                display: "flex",
                background: theme.surface,
                border: `1px solid ${theme.border}`,
                borderRadius: 7,
                padding: 2,
                gap: 2,
              }}
            >
              {[
                { key: "home", label: "Home", icon: Home },
                { key: "tasks", label: "Tasks", icon: KanbanSquare },
                { key: "heartbeats", label: "Heartbeats", icon: HeartPulse },
                { key: "skills", label: "Skills", icon: Sparkles },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => switchActiveView(tab.key as MainView)}
                  style={{
                    padding: "6px 9px",
                    borderRadius: 5,
                    border: "none",
                    background: activeView === tab.key ? theme.field : "transparent",
                    color: activeView === tab.key ? theme.text : theme.textMuted,
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 720,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    transition: "background 0.15s ease, color 0.15s ease",
                  }}
                >
                  <IconGlyph icon={tab.icon} size={13} strokeWidth={2.6} />
                  {tab.label}
                </button>
              ))}
            </div>

            {activeView !== "home" && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "0 9px",
                  height: 32,
                  borderRadius: 7,
                  border: `1px solid ${theme.border}`,
                  background: theme.surface,
                }}
              >
                <Search
                  aria-hidden="true"
                  size={14}
                  strokeWidth={2.4}
                  style={{ color: theme.textDim, flexShrink: 0 }}
                />
                <input
                  placeholder={searchPlaceholder}
                  value={filter}
                  onChange={(e) => setActiveFilter(e.target.value)}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: theme.text,
                    fontSize: 12,
                    outline: "none",
                    width: 152,
                    fontFamily: APP_FONT_STACK,
                  }}
                />
              </div>
            )}

            {(() => {
              const cycle = { system: "light", light: "dark", dark: "system" };
              const icons = { system: MonitorCog, light: Sun, dark: Moon };
              const labels = { system: "System theme", light: "Light mode", dark: "Dark mode" };
              const ThemeIcon = icons[colorMode];
              return (
                <HeaderButton
                  title={labels[colorMode]}
                  onClick={() => setColorMode(cycle[colorMode])}
                  active={colorMode !== "system"}
                >
                  <IconGlyph icon={ThemeIcon} size={15} />
                </HeaderButton>
              );
            })()}

            <HeaderButton title="Settings" onClick={() => setShowSettings(true)}>
              <IconGlyph icon={Settings} size={15} />
            </HeaderButton>

            {activeView === "skills" ? (
              <button
                onClick={handleSweep}
                disabled={!!skillData.sweep?.running}
                style={{
                  height: 32,
                  padding: "0 12px",
                  borderRadius: 6,
                  border: `1px solid ${skillData.sweep?.running ? theme.border : theme.accent}`,
                  background: skillData.sweep?.running ? theme.field : theme.accent,
                  color: skillData.sweep?.running ? theme.textMuted : theme.brandInk,
                  cursor: skillData.sweep?.running ? "default" : "pointer",
                  fontSize: 12,
                  fontWeight: 720,
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  transition: "transform 0.15s ease, box-shadow 0.15s ease",
                }}
              >
                <IconGlyph icon={Radar} size={15} strokeWidth={2.8} />
                {skillData.sweep?.running ? "Scanning" : "Run Scan"}
              </button>
            ) : activeView !== "home" ? (
              <button
                onClick={() =>
                  activeView === "tasks" ? setShowNew(true) : setShowNewHeartbeat(true)
                }
                style={{
                  height: 32,
                  padding: "0 12px",
                  borderRadius: 6,
                  border: `1px solid ${theme.accent}`,
                  background: theme.accent,
                  color: theme.brandInk,
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 720,
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  transition: "transform 0.15s ease, box-shadow 0.15s ease",
                }}
              >
                <IconGlyph icon={Plus} size={15} strokeWidth={2.8} />
                {activeView === "tasks" ? "New Task" : "New Heartbeat"}
              </button>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10, overflowX: "auto" }}>
          {activeSummary.metrics.map((metric) => (
            <MetricTile
              key={metric.label}
              label={metric.label}
              value={metric.value}
              tone={metric.tone}
            />
          ))}
        </div>
      </div>

      {activeView === "home" ? (
        <div
          style={{
            padding: "48px 24px",
            maxWidth: 1200,
            margin: "0 auto",
            minHeight: "calc(100vh - 148px)",
          }}
        >
          {/* Hero Section */}
          <div
            style={{
              textAlign: "center",
              marginBottom: 56,
              animation: "deckIn 0.4s ease",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                padding: "6px 14px",
                borderRadius: 24,
                background: theme.accentGlow,
                color: theme.accent,
                fontSize: 12,
                fontWeight: 650,
                marginBottom: 24,
                border: `1px solid ${theme.borderActive}`,
              }}
            >
              <Sparkles size={14} strokeWidth={2.4} style={{ marginRight: 6 }} />
              Agent Orchestration Platform
            </div>
            <h1
              style={{
                fontSize: 56,
                fontWeight: 800,
                fontFamily: DISPLAY_FONT_STACK,
                lineHeight: 1.1,
                marginBottom: 20,
                background: `linear-gradient(135deg, ${theme.brandStart} 0%, ${theme.brandEnd} 100%)`,
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              Stop babysitting terminals
            </h1>
            <p
              style={{
                fontSize: 18,
                color: theme.textMuted,
                lineHeight: 1.6,
                maxWidth: 620,
                margin: "0 auto 40px",
                fontWeight: 450,
              }}
            >
              Queue tasks, watch live runs, schedule recurring checks, route work from chat, and
              distill patterns into reusable skills — all in one command center.
            </p>
            <div
              style={{
                display: "flex",
                gap: 12,
                justifyContent: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={() => setActiveView("tasks")}
                style={{
                  padding: "14px 32px",
                  borderRadius: 8,
                  border: "none",
                  background: theme.accent,
                  color: "#ffffff",
                  fontSize: 15,
                  fontWeight: 680,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  boxShadow: `0 8px 24px ${theme.accentGlow}`,
                  transition: "transform 0.15s ease, box-shadow 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-1px)";
                  e.currentTarget.style.boxShadow = `0 12px 32px ${theme.accentGlow}`;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translateY(0)";
                  e.currentTarget.style.boxShadow = `0 8px 24px ${theme.accentGlow}`;
                }}
              >
                <KanbanSquare size={18} strokeWidth={2.4} />
                View Task Board
              </button>
              <button
                onClick={() => setShowNew(true)}
                style={{
                  padding: "14px 32px",
                  borderRadius: 8,
                  border: `1px solid ${theme.border}`,
                  background: theme.surface,
                  color: theme.text,
                  fontSize: 15,
                  fontWeight: 680,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  transition: "background 0.15s ease, border-color 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = theme.surfaceHover;
                  e.currentTarget.style.borderColor = theme.borderActive;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = theme.surface;
                  e.currentTarget.style.borderColor = theme.border;
                }}
              >
                <Plus size={18} strokeWidth={2.4} />
                Create Task
              </button>
            </div>
          </div>

          {/* Feature Grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 20,
              marginBottom: 48,
            }}
          >
            {[
              {
                icon: KanbanSquare,
                title: "Visual Task Pipeline",
                description:
                  "Kanban board with queue, running, and done columns. Track pending, scheduled, blocked, and completed work at a glance.",
                color: theme.blue,
                bg: theme.blueBg,
              },
              {
                icon: Play,
                title: "Flexible Scheduling",
                description:
                  "Run tasks immediately, after a delay, at a specific time, or on a cron schedule. Set max-run limits for recurring tasks.",
                color: theme.cyan,
                bg: theme.cyanBg,
              },
              {
                icon: MonitorCog,
                title: "Live Agent Output",
                description:
                  "Stream structured output from Claude Code or Codex CLI. See tool calls, results, and errors in real-time.",
                color: theme.green,
                bg: theme.greenBg,
              },
              {
                icon: HeartPulse,
                title: "Background Watchers",
                description:
                  "Recurring heartbeats that check conditions and decide whether to trigger tasks, resume work, or send notifications.",
                color: theme.orange,
                bg: theme.orangeBg,
              },
              {
                icon: Sparkles,
                title: "Skill Library",
                description:
                  "Detect recurring patterns across runs, distill them into Claude Code skills, and install approved skills automatically.",
                color: theme.accent,
                bg: theme.accentGlow,
              },
              {
                icon: GitFork,
                title: "Multi-Agent Pipelines",
                description:
                  "Task dependencies with upstream result injection. Fan-out research, fan-in summaries, and sub-workflow orchestration.",
                color: theme.yellow,
                bg: "rgba(216, 184, 78, 0.12)",
              },
            ].map((feature, i) => (
              <div
                key={i}
                style={{
                  background: theme.surface,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 12,
                  padding: 24,
                  transition: "border-color 0.15s ease, box-shadow 0.15s ease",
                  animation: `deckIn 0.4s ease ${i * 0.05}s both`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = theme.borderActive;
                  e.currentTarget.style.boxShadow = theme.shadowSoft;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = theme.border;
                  e.currentTarget.style.boxShadow = "none";
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    background: feature.bg,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginBottom: 16,
                  }}
                >
                  <IconGlyph
                    icon={feature.icon}
                    size={22}
                    strokeWidth={2.4}
                    style={{ color: feature.color }}
                  />
                </div>
                <h3
                  style={{
                    fontSize: 17,
                    fontWeight: 700,
                    fontFamily: DISPLAY_FONT_STACK,
                    marginBottom: 8,
                    color: theme.text,
                  }}
                >
                  {feature.title}
                </h3>
                <p
                  style={{
                    fontSize: 14,
                    color: theme.textMuted,
                    lineHeight: 1.5,
                    margin: 0,
                  }}
                >
                  {feature.description}
                </p>
              </div>
            ))}
          </div>

          {/* Quick Stats */}
          {(tasks.length > 0 || heartbeats.length > 0 || skills.length > 0) && (
            <div
              style={{
                background: theme.surface,
                border: `1px solid ${theme.border}`,
                borderRadius: 12,
                padding: 32,
                textAlign: "center",
              }}
            >
              <h3
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  fontFamily: DISPLAY_FONT_STACK,
                  marginBottom: 24,
                  color: theme.text,
                }}
              >
                Your Activity
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                  gap: 24,
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 36,
                      fontWeight: 800,
                      fontFamily: DISPLAY_FONT_STACK,
                      color: theme.blue,
                      marginBottom: 4,
                    }}
                  >
                    {tasks.length}
                  </div>
                  <div style={{ fontSize: 13, color: theme.textMuted, fontWeight: 600 }}>
                    Total Tasks
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 36,
                      fontWeight: 800,
                      fontFamily: DISPLAY_FONT_STACK,
                      color: theme.green,
                      marginBottom: 4,
                    }}
                  >
                    {tasks.filter((t) => t.status === "completed").length}
                  </div>
                  <div style={{ fontSize: 13, color: theme.textMuted, fontWeight: 600 }}>
                    Completed
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 36,
                      fontWeight: 800,
                      fontFamily: DISPLAY_FONT_STACK,
                      color: theme.orange,
                      marginBottom: 4,
                    }}
                  >
                    {heartbeats.length}
                  </div>
                  <div style={{ fontSize: 13, color: theme.textMuted, fontWeight: 600 }}>
                    Heartbeats
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 36,
                      fontWeight: 800,
                      fontFamily: DISPLAY_FONT_STACK,
                      color: theme.accent,
                      marginBottom: 4,
                    }}
                  >
                    {skills.length}
                  </div>
                  <div style={{ fontSize: 13, color: theme.textMuted, fontWeight: 600 }}>
                    Skills
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Getting Started (if no tasks) */}
          {tasks.length === 0 && (
            <div
              style={{
                background: theme.surface,
                border: `1px solid ${theme.border}`,
                borderRadius: 12,
                padding: 32,
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  background: theme.accentGlow,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 20px",
                }}
              >
                <Radar size={28} strokeWidth={2.4} color={theme.accent} />
              </div>
              <h3
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  fontFamily: DISPLAY_FONT_STACK,
                  marginBottom: 12,
                  color: theme.text,
                }}
              >
                Ready to orchestrate your agents?
              </h3>
              <p
                style={{
                  fontSize: 15,
                  color: theme.textMuted,
                  lineHeight: 1.6,
                  marginBottom: 24,
                  maxWidth: 480,
                  margin: "0 auto 24px",
                }}
              >
                Create your first task to get started. Choose Claude Code or Codex CLI, write a
                prompt, set a schedule, and let AgentForge handle the rest.
              </p>
              <button
                onClick={() => setShowNew(true)}
                style={{
                  padding: "12px 28px",
                  borderRadius: 8,
                  border: "none",
                  background: theme.accent,
                  color: "#ffffff",
                  fontSize: 14,
                  fontWeight: 680,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <Plus size={16} strokeWidth={2.4} />
                Create Your First Task
              </button>
            </div>
          )}
        </div>
      ) : activeView === "tasks" ? (
        <div
          style={{
            padding: "20px",
            minHeight: "calc(100vh - 148px)",
          }}
        >
          <div
            className="board-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 12,
              alignItems: "start",
            }}
          >
            {COLUMNS.map((col) => (
              <Column
                key={col.key}
                col={col}
                tasks={tasksByColumn[col.key]}
                onAction={handleAction}
                onViewDetail={openTaskDetail}
                themeVersion={resolvedMode}
              />
            ))}
          </div>
        </div>
      ) : activeView === "heartbeats" ? (
        <div style={{ padding: 20, minHeight: "calc(100vh - 148px)" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
              gap: 12,
            }}
          >
            {filteredHeartbeats.map((h) => (
              <HeartbeatCard
                key={h.id}
                heartbeat={h}
                onAction={handleHeartbeatAction}
                onViewDetail={openHeartbeatDetail}
              />
            ))}
            {heartbeats.length === 0 && (
              <div
                style={{
                  border: `1px dashed ${theme.border}`,
                  borderRadius: 8,
                  padding: 32,
                  textAlign: "center",
                  color: theme.textDim,
                  fontSize: 12,
                  gridColumn: "1 / -1",
                  background: theme.columnBg,
                }}
              >
                No heartbeats yet
              </div>
            )}
          </div>
        </div>
      ) : (
        <SkillsView
          skillData={skillData}
          skills={skills}
          tasks={tasks}
          filter={filter}
          onDraft={handleSkillDraft}
          onApprove={handleSkillApprove}
          onDismiss={handleSkillDismiss}
          onToggleSkill={handleSkillToggle}
          onDeleteSkill={handleSkillDelete}
        />
      )}

      {/* Modals */}
      {showNew && (
        <NewTaskModal
          onClose={() => setShowNew(false)}
          onSubmit={handleCreate}
          initialData={{ agent: defaultAgent }}
        />
      )}
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
          onSave={(timeout, agent) => {
            setTaskTimeout(timeout);
            if (agent) setDefaultAgent(agent);
          }}
          feishu={feishuSettings}
          onFeishuSave={(updated) => setFeishuSettings(updated)}
          channelsStatus={channelsStatus}
          onChannelsSave={(updated) => setChannelsStatus(updated)}
        />
      )}
      {detail && (
        <DetailPanel
          task={detail}
          onClose={closeTaskDetail}
          onRespond={handleRespond}
          onResume={handleResume}
        />
      )}
      {heartbeatDetail && (
        <HeartbeatDetailPanel
          heartbeat={heartbeats.find((h) => h.id === heartbeatDetail.id) || heartbeatDetail}
          ticks={heartbeatTicks}
          onClose={() => {
            setHeartbeatDetail(null);
            setHeartbeatTicks([]);
          }}
        />
      )}

      {/* Startup guide when no tasks */}
      {connected && activeView === "tasks" && tasks.length === 0 && (
        <div
          style={{
            position: "fixed",
            bottom: 28,
            left: "50%",
            transform: "translateX(-50%)",
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            borderRadius: 12,
            padding: "16px 24px",
            maxWidth: 500,
            boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
          }}
        >
          <div style={{ fontSize: 13, color: theme.text, fontWeight: 600, marginBottom: 6 }}>
            Ready to go! Click "+ New Task" to create your first task.
          </div>
          <div style={{ fontSize: 11, color: theme.textDim, lineHeight: 1.6 }}>
            Tasks are dispatched to Claude Code in your specified working directory. Set cron
            schedules for recurring tasks, or delay execution.
          </div>
        </div>
      )}
      {connected && activeView === "heartbeats" && heartbeats.length === 0 && (
        <div
          style={{
            position: "fixed",
            bottom: 28,
            left: "50%",
            transform: "translateX(-50%)",
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            borderRadius: 12,
            padding: "16px 24px",
            maxWidth: 560,
            boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
          }}
        >
          <div style={{ fontSize: 13, color: theme.text, fontWeight: 600, marginBottom: 6 }}>
            Heartbeats let AgentForge check first and only create work when needed.
          </div>
          <div style={{ fontSize: 11, color: theme.textDim, lineHeight: 1.6 }}>
            Create one to run a stateless agent decision tick on an interval or cron schedule, then
            trigger a real task only when the signal is actionable.
          </div>
        </div>
      )}

      {!connected && (
        <div
          style={{
            position: "fixed",
            bottom: 28,
            left: "50%",
            transform: "translateX(-50%)",
            background: theme.redBg,
            border: `1px solid rgba(248,113,113,0.2)`,
            borderRadius: 12,
            padding: "16px 24px",
            maxWidth: 520,
          }}
        >
          <div style={{ fontSize: 13, color: theme.red, fontWeight: 600, marginBottom: 4 }}>
            Backend not running
          </div>
          <code style={{ fontSize: 11, color: theme.text, lineHeight: 1.8, display: "block" }}>
            cd backend
            <br />
            bun taskboard.ts
          </code>
        </div>
      )}
    </div>
  );
}

// CSS animation definitions.
const styles = `
  html, body, #root {
    min-height: 100%;
    margin: 0;
  }

  body {
    overflow-x: hidden;
  }

  button, input, textarea, select {
    font: inherit;
  }

  ::selection {
    background: ${theme.accentGlow};
    color: ${theme.text};
  }

  ::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  ::-webkit-scrollbar-track {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    background: ${theme.borderActive};
    border: 3px solid transparent;
    border-radius: 8px;
    background-clip: padding-box;
  }

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

// Inject styles.
if (typeof document !== "undefined" && !document.querySelector("#live-output-styles")) {
  const styleEl = document.createElement("style");
  styleEl.id = "live-output-styles";
  styleEl.textContent = styles;
  document.head.appendChild(styleEl);
}
