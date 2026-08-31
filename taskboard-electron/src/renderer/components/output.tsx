/**
 * Agent stream-output rendering: raw stream-json formatting plus the execution
 * timeline built from trace events.
 *
 * Moved verbatim out of App.tsx. `FormattedOutput` still takes `theme` as a
 * prop (shadowing the module binding) exactly as it did before.
 */

import { useState } from "react";
import { theme } from "../theme/tokens.ts";
import { formatTaskTime } from "../dateTime.ts";
import { buildExecutionSteps } from "../traceSteps.ts";

// ─── Formatted Output Component ───
export function FormattedOutput({ content, theme }) {
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

export function ExecutionTimeline({ events }) {
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
