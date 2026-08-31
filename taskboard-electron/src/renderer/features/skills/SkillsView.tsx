import { useEffect, useState } from "react";
import { theme } from "../../theme/tokens.ts";
import type { Skill, SkillData, SkillPattern, Task } from "../../types.ts";
import { API } from "../../api/client.ts";

function parseSkillFrontmatter(body: string) {
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

function SkillKindBadge({ kind }: { kind: string | null | undefined }) {
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

function SkillPatternCard({
  p,
  tasks,
  onDraft,
  onApprove,
  onDismiss,
}: {
  p: SkillPattern;
  tasks: Task[] | null | undefined;
  onDraft: (id: number) => void;
  onApprove: (id: number, payload: { body: string }) => void;
  onDismiss: (id: number) => void;
}) {
  let taskIds: number[] = [];
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

  const btn = (bg: string, color: string) => ({
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
            {taskIds.map((tid: number) => {
              const t = (tasks || []).find((x: Task) => x.id === tid);
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

function SkillRegistryCard({
  s,
  tasks,
  onToggle,
  onDelete,
}: {
  s: Skill;
  tasks: Task[] | null | undefined;
  onToggle: (id: number, enabled: boolean) => void;
  onDelete: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  let sourceTaskIds: number[] = [];
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
        setContent(`(failed to load: ${(e as Error).message})`);
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
                  .map((tid: number) => {
                    const t = (tasks || []).find((x: Task) => x.id === tid);
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

export function SkillsView({
  skillData,
  skills,
  tasks,
  filter,
  onDraft,
  onApprove,
  onDismiss,
  onToggleSkill,
  onDeleteSkill,
}: {
  skillData: SkillData;
  skills: Skill[] | null | undefined;
  tasks: Task[] | null | undefined;
  filter: string;
  onDraft: (id: number) => void;
  onApprove: (id: number, payload: { body: string }) => void;
  onDismiss: (id: number) => void;
  onToggleSkill: (id: number, enabled: boolean) => void;
  onDeleteSkill: (id: number) => void;
}) {
  // Only recurrence >= 2 is worth surfacing; single-occurrence rows are noise.
  // (The backend still tracks them so the count can accumulate across sweeps.)
  const patterns = (skillData.patterns || []).filter((p: SkillPattern) => p.recurrence_count >= 2);
  const skillQuery = (filter || "").trim().toLowerCase();
  const matchesQuery = (values: unknown[]) => {
    if (!skillQuery) return true;
    return values.some((value: unknown) =>
      String(value ?? "")
        .toLowerCase()
        .includes(skillQuery),
    );
  };
  const taskTitle = (id: number) => (tasks || []).find((t: Task) => t.id === id)?.title || "";
  const parseIds = (raw: string | null | undefined): number[] => {
    try {
      return JSON.parse(raw || "[]");
    } catch {
      return [];
    }
  };
  const filteredSkills = (skills || []).filter((s: Skill) =>
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

  const sectionHeader = (
    label: string,
    count: string | number,
    open: boolean,
    toggle: () => void,
  ) => (
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
            skillQuery ? `${filteredSkills.length}/${skills?.length ?? 0}` : (skills?.length ?? 0),
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
                {filteredSkills.map((s: Skill) => (
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
            {filteredPatterns.map((p: SkillPattern) => (
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
