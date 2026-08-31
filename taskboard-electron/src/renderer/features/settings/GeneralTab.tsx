import type { PanelStyles } from "./types.ts";
import { theme } from "../../theme/tokens.ts";
import { primaryButton, secondaryButton } from "../../theme/styles.ts";

export function GeneralTab({
  onClose,
  timeout,
  setTimeout,
  defaultAgent,
  setDefaultAgent,
  skillEnabled,
  setSkillEnabled,
  skillSweepAgent,
  setSkillSweepAgent,
  skillSweepCron,
  setSkillSweepCron,
  onSave,
  fieldStyle,
  labelStyle,
  hintStyle,
}: PanelStyles & {
  onClose: () => void;
  timeout: number | string;
  setTimeout: (value: string) => void;
  defaultAgent: string;
  setDefaultAgent: (value: string) => void;
  skillEnabled: boolean;
  setSkillEnabled: (value: boolean) => void;
  skillSweepAgent: string;
  setSkillSweepAgent: (value: string) => void;
  skillSweepCron: string;
  setSkillSweepCron: (value: string) => void;
  onSave: () => void;
}) {
  return (
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
          Run scheduled sweeps over completed tasks to detect recurring patterns. This uses tokens
          and is off by default. The manual scan button is not affected.
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

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button onClick={onClose} style={secondaryButton()}>
          Cancel
        </button>
        <button onClick={onSave} style={primaryButton()}>
          Save
        </button>
      </div>
    </>
  );
}
