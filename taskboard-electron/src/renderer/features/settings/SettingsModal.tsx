import type { ChannelsSavePayload, ChannelsStatusUpdate } from "../../channelsSettings.ts";
import type { FeishuSettings, SaveMessage } from "./types.ts";
import { GeneralTab } from "./GeneralTab.tsx";
import { ChannelsTab } from "./ChannelsTab.tsx";
import { FeishuTab } from "./FeishuTab.tsx";
import { useEffect, useState } from "react";
import {} from "lucide-react";
import QRCode from "qrcode";
import {
  buildChannelsSavePayload,
  createInitialChannelsState,
  isWeixinQrImageSource,
  mergeChannelsStatus,
} from "../../channelsSettings.ts";
import { DEFAULT_AGENT, DEFAULT_TIMEOUT_SECONDS } from "../../constants.ts";
import { theme } from "../../theme/tokens.ts";
import { modalOverlay, modalPanel, modalTitle, uiField, uiLabel } from "../../theme/styles.ts";
import {
  fetchChannelsStatus,
  fetchFeishuSettings,
  fetchSettings,
  runWeixinAction,
  updateChannelsSettings,
  updateFeishuSettings,
  updateSettings,
} from "../../api/client.ts";

export function SettingsModal({
  onClose,
  timeout: initialTimeout,
  defaultAgent: initialDefaultAgent,
  onSave,
  feishu: initialFeishu,
  onFeishuSave,
  channelsStatus: initialChannelsStatus,
  onChannelsSave,
}: {
  onClose: () => void;
  timeout?: number | string;
  defaultAgent?: string;
  onSave: (timeout: number, defaultAgent: string) => void;
  feishu?: Partial<FeishuSettings>;
  onFeishuSave?: (settings: FeishuSettings) => void;
  channelsStatus?: ChannelsStatusUpdate;
  onChannelsSave?: (payload: ChannelsSavePayload) => void;
}) {
  const [tab, setTab] = useState("general");
  // The number input writes back a raw string, so this holds either form.
  const [timeout, setTimeout] = useState<string | number>(
    initialTimeout ?? DEFAULT_TIMEOUT_SECONDS,
  );
  const [defaultAgent, setDefaultAgent] = useState(initialDefaultAgent ?? DEFAULT_AGENT);
  const [skillEnabled, setSkillEnabled] = useState(false);
  const [skillSweepAgent, setSkillSweepAgent] = useState(DEFAULT_AGENT);
  const [skillSweepCron, setSkillSweepCron] = useState("0 3 * * *");
  const [feishu, setFeishu] = useState({
    feishu_app_id: "",
    feishu_app_secret: "",
    feishu_default_chat_id: "",
    feishu_default_working_dir: "~",
    feishu_enabled: "false",
    ...initialFeishu,
  });
  const [feishuSaving, setFeishuSaving] = useState(false);
  const [feishuMsg, setFeishuMsg] = useState<SaveMessage | null>(null);
  const [channels, setChannels] = useState(createInitialChannelsState(initialChannelsStatus));
  const [channelsSaving, setChannelsSaving] = useState(false);
  const [channelsMsg, setChannelsMsg] = useState<SaveMessage | null>(null);
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
      if (s && Object.keys(s).length) setFeishu((f: FeishuSettings) => ({ ...f, ...s }));
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
      .then((dataUrl: string) => {
        if (!cancelled) setWeixinQrSrc(dataUrl);
      })
      .catch((error: unknown) => {
        console.error("Failed to generate Weixin QR code", error);
        if (!cancelled) setWeixinQrSrc("");
      });

    return () => {
      cancelled = true;
    };
  }, [channels.weixin?.qr_code_url]);

  const handleWeixinAction = async (action: string) => {
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
    await updateSettings({
      timeout: parseInt(String(timeout)) || DEFAULT_TIMEOUT_SECONDS,
      default_agent: defaultAgent,
      skill_library_enabled: skillEnabled ? "1" : "0",
      skill_sweep_agent: skillSweepAgent,
      skill_sweep_cron: skillSweepCron,
    });
    onSave(parseInt(String(timeout)) || DEFAULT_TIMEOUT_SECONDS, defaultAgent);
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
              {tabLabel[t as keyof typeof tabLabel]}
            </button>
          ))}
        </div>

        {/* ── General tab ── */}
        {tab === "general" && (
          <GeneralTab
            onClose={onClose}
            timeout={timeout}
            setTimeout={setTimeout}
            defaultAgent={defaultAgent}
            setDefaultAgent={setDefaultAgent}
            skillEnabled={skillEnabled}
            setSkillEnabled={setSkillEnabled}
            skillSweepAgent={skillSweepAgent}
            setSkillSweepAgent={setSkillSweepAgent}
            skillSweepCron={skillSweepCron}
            setSkillSweepCron={setSkillSweepCron}
            onSave={handleSaveGeneral}
            fieldStyle={fieldStyle}
            labelStyle={labelStyle}
            hintStyle={hintStyle}
          />
        )}

        {/* ── Channels tab ── */}
        {tab === "channels" && (
          <ChannelsTab
            onClose={onClose}
            channels={channels}
            setChannels={setChannels}
            channelsSaving={channelsSaving}
            channelsMsg={channelsMsg}
            weixinQrSrc={weixinQrSrc}
            weixinActionBusy={weixinActionBusy}
            collapsedChannels={collapsedChannels}
            setCollapsedChannels={setCollapsedChannels}
            onWeixinAction={handleWeixinAction}
            onSave={handleSaveChannels}
            fieldStyle={fieldStyle}
            labelStyle={labelStyle}
            hintStyle={hintStyle}
          />
        )}

        {/* ── Feishu tab ── */}
        {tab === "feishu" && (
          <FeishuTab
            onClose={onClose}
            feishu={feishu}
            setFeishu={setFeishu}
            feishuSaving={feishuSaving}
            feishuMsg={feishuMsg}
            onSave={handleSaveFeishu}
            fieldStyle={fieldStyle}
            labelStyle={labelStyle}
            hintStyle={hintStyle}
          />
        )}
      </div>
    </div>
  );
}
