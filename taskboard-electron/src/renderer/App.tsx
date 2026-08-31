import { useState, useEffect, useCallback } from "react";
import {
  HeartPulse,
  KanbanSquare,
  MonitorCog,
  Moon,
  Plus,
  Radar,
  Search,
  Settings,
  Sparkles,
  Sun,
} from "lucide-react";
import {} from "./channelsSettings.ts";
import { COLUMNS, DEFAULT_AGENT, DEFAULT_TIMEOUT_SECONDS } from "./constants.ts";
import {
  BrandMark,
  HeaderButton,
  IconGlyph,
  MetricTile,
  StatusPill,
} from "./components/common.tsx";
import {
  API,
  approveSkill,
  cancelTask,
  createHeartbeat,
  createTask,
  deleteHeartbeat,
  deleteSkillApi,
  deleteTask,
  dismissSkillPattern,
  fetchChannelsStatus,
  fetchFeishuSettings,
  fetchHeartbeatTicks,
  fetchHeartbeats,
  fetchSettings,
  fetchSkillPatterns,
  fetchSkills,
  fetchTasks,
  fetchWithTimeout,
  pauseHeartbeat,
  respondToTask,
  resumeHeartbeatApi,
  retryTask,
  runHeartbeatNow,
  setSkillEnabledApi,
  triggerSkillDraft,
  triggerSkillSweep,
  updateHeartbeat,
  updateTask,
} from "./api/client.ts";
import { APP_FONT_STACK, DISPLAY_FONT_STACK, THEMES, applyTheme, theme } from "./theme/tokens.ts";
import {} from "./theme/styles.ts";
import { Column } from "./features/tasks/board.tsx";
import { NewTaskModal } from "./features/tasks/NewTaskModal.tsx";
import { DetailPanel } from "./features/tasks/DetailPanel.tsx";
import { HeartbeatModal } from "./features/heartbeats/HeartbeatModal.tsx";
import { HeartbeatCard, HeartbeatDetailPanel } from "./features/heartbeats/panels.tsx";
import { SkillsView } from "./features/skills/SkillsView.tsx";
import { SettingsModal } from "./features/settings/SettingsModal.tsx";

// ─── App ───

export default function App() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [heartbeats, setHeartbeats] = useState<any[]>([]);
  const [heartbeatTicks, setHeartbeatTicks] = useState<any[]>([]);
  const [skillData, setSkillData] = useState({
    patterns: [],
    sweep: { running: false, last: null },
  });
  const [skills, setSkills] = useState<any[]>([]);
  const [activeView, setActiveView] = useState("tasks");
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

  // ─── Color mode ───
  const [colorMode, setColorMode] = useState(() => localStorage.getItem("colorMode") || "system");
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const resolvedMode = colorMode === "system" ? (systemDark ? "dark" : "light") : colorMode;
  applyTheme(resolvedMode);

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
    try {
      const [taskData, heartbeatData, skillRes, skillsRes] = await Promise.all([
        fetchTasks(),
        fetchHeartbeats(),
        fetchSkillPatterns(),
        fetchSkills(),
      ]);
      setTasks(taskData);
      setHeartbeats(heartbeatData);
      setSkillData(skillRes);
      setSkills(skillsRes.skills || []);
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
    fetchSettings().then((s) => {
      if (s.timeout) setTaskTimeout(s.timeout);
      if (s.default_agent) setDefaultAgent(s.default_agent);
    });
    fetchFeishuSettings().then((s) => setFeishuSettings(s));
    fetchChannelsStatus().then((s) => setChannelsStatus(s));
  }, [backendReady]);

  const handleAction = async (action, id) => {
    try {
      if (action === "cancel") await cancelTask(id);
      else if (action === "retry") await retryTask(id);
      else if (action === "delete") {
        await deleteTask(id);
        if (detail?.id === id) setDetail(null);
      } else if (action === "edit") {
        const task = tasks.find((t) => t.id === id);
        if (task) setEditingTask(task);
        return;
      } else if (action === "fork") {
        const task = tasks.find((t) => t.id === id);
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
        const heartbeat = heartbeats.find((h) => h.id === id);
        if (heartbeat) setEditingHeartbeat(heartbeat);
        return;
      }
      poll();
      if (heartbeatDetail?.id === id && action !== "delete") {
        const [updatedHeartbeat, ticks] = await Promise.all([
          fetch(`${API}/heartbeats/${id}`).then((r) => r.json()),
          fetchHeartbeatTicks(id),
        ]);
        setHeartbeatDetail(updatedHeartbeat);
        setHeartbeatTicks(ticks);
      }
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

  const filter =
    activeView === "tasks"
      ? filters.tasks
      : activeView === "heartbeats"
        ? filters.heartbeats
        : filters.skills;
  const setActiveFilter = (value) => {
    setFilters((prev) =>
      activeView === "tasks"
        ? { ...prev, tasks: value }
        : activeView === "heartbeats"
          ? { ...prev, heartbeats: value }
          : { ...prev, skills: value },
    );
  };
  const searchPlaceholder =
    activeView === "tasks"
      ? "Search tasks"
      : activeView === "heartbeats"
        ? "Search heartbeats"
        : "Search skills";

  const filtered = filter
    ? tasks.filter(
        (t) =>
          t.title.toLowerCase().includes(filter.toLowerCase()) ||
          t.tags?.toLowerCase().includes(filter.toLowerCase()),
      )
    : tasks;

  const runningCount = tasks.filter((t) => t.status === "running").length;
  const queueCount = tasks.filter((t) =>
    ["pending", "scheduled", "blocked"].includes(t.status),
  ).length;
  const doneCount = tasks.filter((t) =>
    ["completed", "failed", "cancelled"].includes(t.status),
  ).length;
  const enabledHeartbeatCount = heartbeats.filter((h) => h.enabled).length;
  const pausedHeartbeatCount = Math.max(heartbeats.length - enabledHeartbeatCount, 0);
  const heartbeatIssueCount = heartbeats.filter((h) => h.last_error).length;
  const enabledSkillCount = skills.filter((s) => s.enabled).length;
  const pausedSkillCount = Math.max(skills.length - enabledSkillCount, 0);
  const skillPatternCount = (skillData.patterns || []).filter(
    (p) => p.recurrence_count >= 2,
  ).length;
  const activeSummary = {
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
                { key: "tasks", label: "Tasks", icon: KanbanSquare },
                { key: "heartbeats", label: "Heartbeats", icon: HeartPulse },
                { key: "skills", label: "Skills", icon: Sparkles },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveView(tab.key)}
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
            ) : (
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
            )}
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

      {activeView === "tasks" ? (
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
                tasks={filtered.filter((t) => col.statuses.includes(t.status))}
                onAction={handleAction}
                onViewDetail={setDetail}
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
            {(filter
              ? heartbeats.filter(
                  (h) =>
                    h.name.toLowerCase().includes(filter.toLowerCase()) ||
                    h.check_prompt.toLowerCase().includes(filter.toLowerCase()),
                )
              : heartbeats
            ).map((h) => (
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
          task={tasks.find((t) => t.id === detail.id) || detail}
          onClose={() => setDetail(null)}
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
