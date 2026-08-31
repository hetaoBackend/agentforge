import { useState } from "react";
import { AGENTS, DEFAULT_AGENT } from "../../constants.ts";
import { theme } from "../../theme/tokens.ts";
import {
  modalOverlay,
  modalPanel,
  modalTitle,
  primaryButton,
  secondaryButton,
  segmentedButton,
  uiField,
  uiLabel,
} from "../../theme/styles.ts";
import type { Heartbeat } from "../../types.ts";

export function HeartbeatModal({
  onClose,
  onSubmit,
  initialData,
  defaultAgent,
  mode = "create",
}: {
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>) => void;
  initialData?: Partial<Heartbeat> | null;
  defaultAgent?: string;
  mode?: "create" | "edit";
}) {
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

  const set = (k: string, v: unknown) => setForm((prev) => ({ ...prev, [k]: v }));

  const inputStyle = uiField();
  const labelStyle = uiLabel();

  const handleSubmit = () => {
    localStorage.setItem("agentforge_working_dir", form.working_dir);
    onSubmit({
      ...form,
      name: form.name || "Untitled heartbeat",
      interval_seconds:
        form.schedule_type === "interval" ? parseInt(String(form.interval_seconds)) || 600 : null,
      cooldown_seconds: parseInt(String(form.cooldown_seconds)) || 0,
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
                    const dir = await window.electronAPI?.selectDirectory();
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
