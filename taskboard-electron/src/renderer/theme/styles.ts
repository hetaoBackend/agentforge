/**
 * Shared style factories.
 *
 * These are functions rather than constants because they read the live
 * `theme` binding at call time — evaluating them at module load would freeze
 * the dark palette in place.
 */

import type { CSSProperties } from "react";
import { APP_FONT_STACK, DISPLAY_FONT_STACK, theme } from "./tokens.ts";

export function uiField(overrides: CSSProperties = {}): CSSProperties {
  return {
    width: "100%",
    padding: "9px 11px",
    borderRadius: 6,
    border: `1px solid ${theme.border}`,
    background: theme.field,
    color: theme.text,
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box",
    fontFamily: APP_FONT_STACK,
    transition: "border-color 0.15s ease, background 0.15s ease",
    ...overrides,
  };
}

export function uiLabel(): CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 650,
    color: theme.textMuted,
    letterSpacing: 0,
    marginBottom: 6,
    display: "block",
  };
}

export function modalOverlay(): CSSProperties {
  return {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.58)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    backdropFilter: "blur(6px)",
    padding: 20,
  };
}

export function modalPanel(width: number, maxHeight = "84vh"): CSSProperties {
  return {
    background: theme.surface,
    border: `1px solid ${theme.border}`,
    borderRadius: 10,
    padding: 24,
    width,
    maxWidth: "calc(100vw - 40px)",
    maxHeight,
    overflow: "auto",
    boxShadow: theme.shadow,
  };
}

export function modalTitle(): CSSProperties {
  return {
    margin: "0 0 18px",
    fontSize: 16,
    fontWeight: 720,
    color: theme.text,
    fontFamily: DISPLAY_FONT_STACK,
  };
}

export function secondaryButton(): CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: 6,
    border: `1px solid ${theme.border}`,
    background: theme.surface,
    color: theme.textMuted,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 650,
  };
}

export function primaryButton(): CSSProperties {
  return {
    padding: "8px 15px",
    borderRadius: 6,
    border: `1px solid ${theme.accent}`,
    background: theme.accent,
    color: theme.brandInk,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 680,
  };
}

export function segmentedButton(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: "7px 10px",
    borderRadius: 6,
    cursor: "pointer",
    border: `1px solid ${active ? theme.borderActive : theme.border}`,
    background: active ? theme.accentGlow : theme.surface,
    color: active ? theme.text : theme.textMuted,
    fontSize: 12,
    fontWeight: 650,
    minWidth: 96,
    transition: "background 0.15s ease, border-color 0.15s ease, color 0.15s ease",
  };
}
