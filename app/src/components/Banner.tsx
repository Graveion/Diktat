import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { colors, fonts } from "../theme";

type Variant = "error" | "success" | "accent";

const VARIANT_COLOR: Record<Variant, string> = {
  error: colors.error,
  success: colors.success,
  accent: colors.accent,
};

// 10% tint of the variant color over the canvas — computed once, not per render.
const VARIANT_BG: Record<Variant, string> = {
  error: "rgba(248,113,113,0.10)",
  success: "rgba(52,211,153,0.10)",
  accent: "rgba(167,139,250,0.10)",
};

type Props = {
  variant: Variant;
  text: string;
  /** Tap target for the whole banner (e.g. trial → open paywall). */
  onPress?: () => void;
  /** Trailing action (e.g. "Exit", "✕ dismiss"). */
  actionLabel?: string;
  onAction?: () => void;
  /** Extra top padding so the first banner clears the status bar / notch. */
  topInset?: number;
  testID?: string;
};

/**
 * The one status banner. Error, demo, and trial states all render through
 * this so tint, type, and spacing stay consistent (semantic color at 10%
 * opacity + a solid leading edge, single-line body, optional trailing action).
 */
export function Banner({ variant, text, onPress, actionLabel, onAction, topInset = 0, testID }: Props) {
  const color = VARIANT_COLOR[variant];
  const body = (
    <View style={[styles.row, { backgroundColor: VARIANT_BG[variant], borderLeftColor: color, paddingTop: 7 + topInset }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.text, { color }]} numberOfLines={1}>
        {text}
      </Text>
      {actionLabel && onAction ? (
        <TouchableOpacity onPress={onAction} hitSlop={10} accessibilityRole="button" accessibilityLabel={actionLabel}>
          <Text style={[styles.action, { color }]}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.8} testID={testID} accessibilityRole="button">
        {body}
      </TouchableOpacity>
    );
  }
  return <View testID={testID}>{body}</View>;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 7,
    borderLeftWidth: 2,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { flex: 1, fontFamily: fonts.bodyMedium, fontSize: 12 },
  action: { fontFamily: fonts.bodySemi, fontSize: 12, paddingLeft: 8 },
});
