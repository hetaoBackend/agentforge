import { useState } from "react";
import {
  formatDateTimeLocalInput,
  parseTaskDateTime,
  serializeDateTimeLocalInput,
} from "../../dateTime.ts";
import { DEFAULT_AGENT } from "../../constants.ts";
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

export function NewTaskModal({ onClose, onSubmit, initialData, mode = "create" }) {
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
