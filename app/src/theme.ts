import { Platform } from "react-native";

// ─── Palette ────────────────────────────────────────────────────────────────
// Warm-dark "amber terminal" aesthetic.
// Near-black with warm undertones, amber as the dominant accent.

export const colors = {
  // Backgrounds — layered warm blacks
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

  // User message bubble
  userBubble:   "#5b21b6",  // deep violet

  // Text scale
  text:         "#f0eef8",  // primary — slightly warm white
  textSub:      "#8b85a1",  // secondary
  textMuted:    "#3d3850",  // muted
  textFaint:    "#1e1b2a",  // barely-there

  // Semantic
  success:  "#34d399",
  warning:  "#fbbf24",
  error:    "#f87171",
  info:     "#60a5fa",
};

// ─── Typography ─────────────────────────────────────────────────────────────
// Syne (display) — angular, geometric, characterful
// Outfit (body) — clean but distinctive, not Inter

export const fonts = {
  display:     "Syne_700Bold",
  displayXBold:"Syne_800ExtraBold",
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
