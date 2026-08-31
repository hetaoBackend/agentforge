/**
 * Design tokens for the renderer.
 *
 * `theme` is a live module binding, reassigned by `applyTheme()` before each
 * App render — the same mechanism the single-file App.tsx used. Importers see
 * the update because ES module bindings are live; only this module may
 * reassign it, hence the setter.
 */

export const THEMES: Record<string, Record<string, string>> = {
  dark: {
    bg: "#0d0e10",
    surface: "#17181c",
    surfaceHover: "#1c1d22",
    panel: "#111216",
    panelRaised: "#18191e",
    field: "#101115",
    border: "rgba(255, 255, 255, 0.085)",
    borderActive: "rgba(94, 106, 210, 0.48)",
    text: "#f4f4f5",
    textMuted: "#a6a8b0",
    textDim: "#70737c",
    accent: "#5e6ad2",
    accentGlow: "rgba(94, 106, 210, 0.18)",
    green: "#4cb782",
    greenBg: "rgba(76, 183, 130, 0.12)",
    orange: "#d99a45",
    orangeBg: "rgba(217, 154, 69, 0.13)",
    red: "#e06c75",
    redBg: "rgba(224, 108, 117, 0.13)",
    blue: "#6aa6f8",
    blueBg: "rgba(106, 166, 248, 0.12)",
    cyan: "#64b5d9",
    cyanBg: "rgba(100, 181, 217, 0.12)",
    yellow: "#d8b84e",
    headerBg: "rgba(13, 14, 16, 0.9)",
    headerBorder: "rgba(255, 255, 255, 0.08)",
    boardBg: "linear-gradient(180deg, #101114 0%, #0d0e10 48%, #0b0c0e 100%)",
    columnBg: "rgba(18, 19, 23, 0.72)",
    columnHeader: "#f4f4f5",
    shadow: "0 22px 54px rgba(0, 0, 0, 0.34)",
    shadowSoft: "0 10px 28px rgba(0, 0, 0, 0.2)",
    brandStart: "#f2f3f5",
    brandEnd: "#bfc4cf",
    brandInk: "#ffffff",
  },
  light: {
    bg: "#f7f8fa",
    surface: "#ffffff",
    surfaceHover: "#fafbfc",
    panel: "#f1f2f5",
    panelRaised: "#ffffff",
    field: "#f3f4f7",
    border: "rgba(31, 35, 40, 0.12)",
    borderActive: "rgba(94, 106, 210, 0.44)",
    text: "#1f2328",
    textMuted: "#636a75",
    textDim: "#8a919d",
    accent: "#5e6ad2",
    accentGlow: "rgba(94, 106, 210, 0.13)",
    green: "#2f9f6a",
    greenBg: "rgba(47, 159, 106, 0.1)",
    orange: "#b97722",
    orangeBg: "rgba(185, 119, 34, 0.11)",
    red: "#d14d57",
    redBg: "rgba(209, 77, 87, 0.1)",
    blue: "#3978d8",
    blueBg: "rgba(57, 120, 216, 0.1)",
    cyan: "#2f8fb7",
    cyanBg: "rgba(47, 143, 183, 0.1)",
    yellow: "#a98b19",
    headerBg: "rgba(247, 248, 250, 0.9)",
    headerBorder: "rgba(31, 35, 40, 0.1)",
    boardBg: "linear-gradient(180deg, #fbfbfc 0%, #f7f8fa 48%, #eef0f4 100%)",
    columnBg: "rgba(255, 255, 255, 0.78)",
    columnHeader: "#1f2328",
    shadow: "0 18px 42px rgba(31, 35, 40, 0.12)",
    shadowSoft: "0 8px 22px rgba(31, 35, 40, 0.08)",
    brandStart: "#ffffff",
    brandEnd: "#d9dde7",
    brandInk: "#ffffff",
  },
};

// Mutable module-level theme reference — updated before each App render
export let theme = THEMES.dark!;

/** Point the live `theme` binding at one of THEMES. */
export function applyTheme(mode: string): void {
  theme = THEMES[mode] ?? THEMES.dark!;
}

export const APP_FONT_STACK =
  "'SF Pro Text', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
export const DISPLAY_FONT_STACK =
  "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
export const MONO_FONT_STACK = "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace";
