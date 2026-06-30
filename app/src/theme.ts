import { Platform } from "react-native";

// ─── Palette ────────────────────────────────────────────────────────────────
// "Violet terminal": layered violet-blacks, electric violet as the single
// accent, semantic colors doing the rest. Code/diff surfaces use the same
// family (codeBg/codeText below) — never import another palette (e.g. GitHub
// grays) next to this one.

export const colors = {
  // Backgrounds — layered violet-blacks, lifted a notch for daylight legibility
  // (was #07060a..#1c1927). Keeps the violet identity, just less of a void.
  bg:          "#0c0a12",   // canvas
  surface:     "#16131d",   // cards / screen bg
  card:        "#211c2e",   // elevated cards
  input:       "#272233",   // inputs
  border:      "#38324a",   // standard border (stronger, clearly visible)
  borderFaint: "#1d1a28",   // very subtle divider

  // Primary accent — electric violet
  accent:       "#a78bfa",  // violet
  accentBright: "#c4b5fd",  // hover / highlight
  accentDim:    "#4c1d95",  // muted variant
  accentFaint:  "#1a1230",  // tinted surface
  // Dark ink for glyphs sitting ON an accent-filled control
  onAccent:     "#1a1033",

  // User message bubble
  userBubble:   "#5b21b6",  // deep violet

  // Text scale. textSub is the readable secondary (~7:1 on bg) — use it for any
  // copy a user is meant to read. textMuted (~4.5:1) is for decoration:
  // chevrons, dividers, timestamps — now bright enough to not vanish.
  text:         "#f4f2fb",  // primary — slightly warm white
  textSub:      "#a59fbd",  // secondary (readable)
  textMuted:    "#7b7397",  // decorative
  textFaint:    "#2a2640",  // barely-there

  // Code / tool-output surfaces (violet-tinted, NOT GitHub gray)
  codeBg:    "#181423",
  codeText:  "#e2def0",

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
