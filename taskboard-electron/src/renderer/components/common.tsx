/**
 * Presentational primitives shared by every feature view.
 *
 * Moved verbatim out of App.tsx; `clamp` and `getStatusConfig` came along
 * because Tooltip and Badge are their only callers.
 */

import { useState, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { DISPLAY_FONT_STACK, MONO_FONT_STACK, theme } from "../theme/tokens.ts";
import { AGENTS } from "../constants.ts";

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getStatusConfig() {
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

export function Tooltip({ text, children }: { text: ReactNode; children: ReactNode }) {
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

export function BrandMark({ size = 40 }) {
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

export function IconGlyph({
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

export function IconWell({
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

export function HeaderButton({
  children,
  onClick,
  title,
  active = false,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
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

export function StatusPill({
  connected,
  label,
  tone = theme.green,
  background = theme.greenBg,
}: {
  connected: boolean;
  label: string;
  tone?: string;
  background?: string;
}) {
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

export function MetricTile({
  label,
  value,
  tone = theme.text,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
}) {
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

export function Badge({ status }: { status: string }) {
  const config = getStatusConfig();
  const cfg = config[status as keyof typeof config] || config.pending;
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

export function Tag({ children }: { children: ReactNode }) {
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

export function AgentBadge({ agent }: { agent: string }) {
  const cfg = AGENTS[agent as keyof typeof AGENTS] || AGENTS.claude;
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

export function ActionBtn({
  icon,
  title,
  onClick,
  color,
}: {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
  color: string;
}) {
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
