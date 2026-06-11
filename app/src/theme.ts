import { Platform } from "react-native";

// ─── Palette ────────────────────────────────────────────────────────────────
// "Violet terminal": layered violet-blacks, electric violet as the single
// accent, semantic colors doing the rest. Code/diff surfaces use the same
// family (codeBg/codeText below) — never import another palette (e.g. GitHub
// grays) next to this one.

export const colors = {
  // Backgrounds — layered violet-blacks
  bg:          "#07060a",   // canvas
  surface:     "#0f0d13",   // cards / screen bg
  card:        "#171420",   // elevated cards
  input:       "#1c1927",   // inputs
  border:      "#252130",   // standard border
  borderFaint: "#141220",   // very subtle divider

  // Primary accent — electric violet
  accent:       "#a78bfa",  // violet
  accentBright: "#c4b5fd",  // hover / highlight
  accentDim:    "#4c1d95",  // muted variant
  accentFaint:  "#120d1f",  // tinted surface
  // Dark ink for glyphs sitting ON an accent-filled control
  onAccent:     "#1a1033",

  // User message bubble
  userBubble:   "#5b21b6",  // deep violet

  // Text scale. textSub passes WCAG AA on bg (5.6:1) — use it for any copy a
  // user is meant to read. textMuted (~3:1) is for decoration only: chevrons,
  // dividers, timestamps — never sentences or hints.
  text:         "#f0eef8",  // primary — slightly warm white
  textSub:      "#8b85a1",  // secondary (readable)
  textMuted:    "#5f5878",  // decorative
  textFaint:    "#1e1b2a",  // barely-there

  // Code / tool-output surfaces (violet-tinted, NOT GitHub gray)
  codeBg:    "#110e18",
  codeText:  "#d6d2e8",

  // Semantic
  success:  "#34d399",
  warning:  "#fbbf24",
  error:    "#f87171",
  info:     "#60a5fa",
};

// ─── Typography ─────────────────────────────────────────────────────────────
// Space Grotesk (display) — technical, geometric, terminal-adjacent
// Outfit (body) — clean but distinctive, not Inter

export const fonts = {
  display:     "SpaceGrotesk_700Bold",
  body:        "Outfit_400Regular",
  bodyMedium:  "Outfit_500Medium",
  bodySemi:    "Outfit_600SemiBold",
  bodyBold:    "Outfit_700Bold",
  mono:        Platform.OS === "ios" ? "Menlo" : "monospace",
};

// ─── Spacing ─────────────────────────────────────────────────────────────────

export const space = {
  xs:  4,
  sm:  8,
  md:  14,
  lg:  20,
  xl:  28,
  xxl: 40,
};

// ─── Radii ────────────────────────────────────────────────────────────────────

export const radii = {
  sm:   6,
  md:   12,
  lg:   18,
  xl:   24,
  full: 999,
};
