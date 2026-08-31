import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatTaskDateTime } from "../../dateTime.ts";
import { ExecutionTimeline, FormattedOutput } from "../../components/output.tsx";
import { DEFAULT_AGENT } from "../../constants.ts";
import { Badge } from "../../components/common.tsx";
import { theme } from "../../theme/tokens.ts";
import { API, fetchTaskEvents, fetchTaskMessages, resumeTask } from "../../api/client.ts";
import type { PromptImage, Task, TaskDependency } from "../../types.ts";

export function DetailPanel({
  task,
  onClose,
  onResume,
}: {
  task: Task;
  onClose: () => void;
  onResume: () => void;
}) {
  // `task` is always truthy here — the only caller renders this inside
  // `{detail && <DetailPanel task={... || detail} />}`. Hooks must stay
  // unconditional, so do not early-return before them.
  const [liveOutput, setLiveOutput] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [resumeError, setResumeError] = useState("");
  const [resumeSent, setResumeSent] = useState(false);
  const [messages, setMessages] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [showMessages, setShowMessages] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showLiveOutput, setShowLiveOutput] = useState(true);
  const liveOutputRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const eventsRef = useRef<HTMLDivElement | null>(null);

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
          // Incremental update: append only new output.
          if (currentOutput.length > lastOutputLength) {
            const newContent = currentOutput.slice(lastOutputLength);
            setLiveOutput((prev) => prev + newContent);
            lastOutputLength = currentOutput.length;
          }
        }
      } catch {}
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
              {task.prompt_images.map((img: PromptImage, i: number) => (
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
          {task.dependencies.map((dep: TaskDependency) => (
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
            {task.dependents.map((id: number) => `#${id}`).join(", ")}
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

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
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

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
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
