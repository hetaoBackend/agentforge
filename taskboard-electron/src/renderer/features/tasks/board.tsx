import { useState } from "react";
import { GitFork, Pencil, RotateCcw, Square, Trash2 } from "lucide-react";
import { formatTaskDateTime, formatTaskTime } from "../../dateTime.ts";
import { ActionBtn, AgentBadge, Badge, IconWell, Tag } from "../../components/common.tsx";
import { DISPLAY_FONT_STACK, MONO_FONT_STACK, theme } from "../../theme/tokens.ts";

export function TaskCard({ task, onAction, onViewDetail }) {
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
          {task.prompt || "No prompt saved for this task."}
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

export function Column({ col, tasks, onAction, onViewDetail }) {
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
          <TaskCard key={t.id} task={t} onAction={onAction} onViewDetail={onViewDetail} />
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
