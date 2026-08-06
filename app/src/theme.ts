import { Platform } from "react-native";

// ─── Palette ────────────────────────────────────────────────────────────────
// "Neutral terminal": true neutral near-blacks and greys (no colour tint in the
// surfaces), with a single teal accent doing all the pointing. Reads like a
// serious developer tool, not a purple AI product. Code/diff surfaces use the
// same neutral family (codeBg/codeText below) — never import another palette
// (e.g. GitHub grays or a second accent) next to this one.
//
// To retint the accent, change `accent`/`accentBright`/`accentDim`/`accentFaint`
// (and `userBubble`) only — everything else is neutral and stays put. Blue
// alternative: accent #3b82f6, bright #60a5fa, dim #1e40af, faint #0d1526.

export const colors = {
  // Backgrounds — layered neutral near-blacks, lifted enough for daylight
  // legibility. No violet tint: pure cool greys.
  bg:          "#0b0b0d",   // canvas
  surface:     "#141417",   // cards / screen bg
  card:        "#1c1c21",   // elevated cards
  input:       "#212127",   // inputs
  border:      "#33333d",   // standard border (clearly visible)
  borderFaint: "#1c1c22",   // very subtle divider

  // Primary accent — teal
  accent:       "#2dd4bf",  // teal
  accentBright: "#5eead4",  // hover / highlight
  accentDim:    "#0f766e",  // muted variant
  accentFaint:  "#0c1a18",  // tinted surface
  // Dark ink for glyphs sitting ON an accent-filled control
  onAccent:     "#04211d",

  // User message bubble — deep teal (ties to accent, no purple)
  userBubble:   "#115e59",

  // Text scale. textSub is the readable secondary (~7:1 on bg) — use it for any
  // copy a user is meant to read. textMuted (~4.5:1) is for decoration:
  // chevrons, dividers, timestamps — bright enough to not vanish.
  text:         "#f2f2f4",  // primary — cool white
  textSub:      "#a1a1ac",  // secondary (readable)
  textMuted:    "#71717f",  // decorative
  textFaint:    "#2a2a32",  // barely-there

  // Code / tool-output surfaces (neutral, NOT tinted)
  codeBg:    "#141418",
  codeText:  "#e4e4ea",

  // Semantic
  success:  "#34d399",
  warning:  "#fbbf24",
  error:    "#f87171",
  info:     "#60a5fa",
};

// ─── Typography ─────────────────────────────────────────────────────────────
// IBM Plex Sans — a developer-tool typeface (neutral, engineered, not the
// trendy-AI geometric look and deliberately not Inter). One family across
// display and body; weight carries the hierarchy. Load weights in App.tsx.

export const fonts = {
  display:     "IBMPlexSans_700Bold",
  body:        "IBMPlexSans_400Regular",
  bodyMedium:  "IBMPlexSans_500Medium",
  bodySemi:    "IBMPlexSans_600SemiBold",
  bodyBold:    "IBMPlexSans_700Bold",
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
