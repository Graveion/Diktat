import { useEffect, useState } from "react";
import { Modal, View, Text, TouchableOpacity, StyleSheet, Linking, ActivityIndicator } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import type { AuthPrompt } from "../hooks/useDiktat";
import { colors, fonts, radii, space } from "../theme";

type Props = {
  /** The active device-code re-auth prompt, or null when nothing is in flight. */
  prompt: AuthPrompt | null;
  /** CLI display name (e.g. "GitHub Copilot"); falls back to the CLI id. */
  cliLabel?: string;
  onDismiss: () => void;
};

/**
 * Bottom sheet shown when a coding-agent CLI's provider auth has expired and the
 * daemon has started a device-code login. The user opens the verification URL on
 * this (or any) device and enters the short code; the daemon polls and, on
 * success, dismisses this sheet and resumes the pending turn. No secret is ever
 * entered here — sign-in happens on the provider's own web page.
 */
export function ReauthSheet({ prompt, cliLabel, onDismiss }: Props) {
  const [copied, setCopied] = useState(false);
  // Reset the "copied" affordance whenever a fresh prompt appears.
  useEffect(() => setCopied(false), [prompt?.sessionId, prompt?.userCode]);

  if (!prompt) return null;
  const name = cliLabel || prompt.cli;
  const failed = prompt.state === "failed";

  const openUrl = () => {
    Linking.openURL(prompt.verificationUrl).catch(() => {});
  };
  const copyCode = () => {
    if (!prompt.userCode) return;
    Clipboard.setStringAsync(prompt.userCode);
    setCopied(true);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="reauth-sheet">
          <View style={styles.headerRow}>
            <Ionicons
              name={failed ? "alert-circle" : "key"}
              size={18}
              color={failed ? colors.error : colors.accent}
            />
            <Text style={styles.title}>Re-authenticate {name}</Text>
            <TouchableOpacity onPress={onDismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel="Dismiss">
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {failed ? (
            <Text style={styles.body}>
              {prompt.message || "Sign-in didn't complete."} You can try again, or run the login on the Mac.
            </Text>
          ) : (
            <Text style={styles.body}>
              {prompt.instructions ||
                `Open the verification page and sign in to re-authenticate ${name}.`}
            </Text>
          )}

          {prompt.userCode && !failed ? (
            <TouchableOpacity
              style={styles.codeBox}
              onPress={copyCode}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Copy code ${prompt.userCode}`}
              testID="reauth-code"
            >
              <Text style={styles.code}>{prompt.userCode}</Text>
              <View style={styles.copyHint}>
                <Ionicons name={copied ? "checkmark" : "copy-outline"} size={14} color={colors.textSub} />
                <Text style={styles.copyHintText}>{copied ? "copied" : "copy"}</Text>
              </View>
            </TouchableOpacity>
          ) : null}

          {!failed ? (
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={openUrl}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Open the verification page"
              testID="reauth-open"
            >
              <Ionicons name="open-outline" size={16} color={colors.onAccent} />
              <Text style={styles.primaryBtnText}>Open verification page</Text>
            </TouchableOpacity>
          ) : null}

          <View style={styles.statusRow}>
            {prompt.state === "pending" ? (
              <>
                <ActivityIndicator size="small" color={colors.textMuted} />
                <Text style={styles.statusText}>Waiting for you to finish in the browser…</Text>
              </>
            ) : failed ? (
              <Text style={[styles.statusText, { color: colors.error }]}>Sign-in failed</Text>
            ) : (
              <Text style={[styles.statusText, { color: colors.success }]}>Signed in</Text>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    padding: space.lg,
    paddingBottom: space.xl,
    borderTopWidth: 1,
    borderColor: colors.border,
    gap: space.md,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  title: { flex: 1, fontFamily: fonts.bodySemi, fontSize: 16, color: colors.text },
  body: { fontFamily: fonts.body, fontSize: 14, lineHeight: 21, color: colors.textSub },
  codeBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.input,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  code: { fontFamily: fonts.mono, fontSize: 24, letterSpacing: 4, color: colors.text },
  copyHint: { flexDirection: "row", alignItems: "center", gap: 4 },
  copyHintText: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.textSub },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: space.md,
  },
  primaryBtnText: { fontFamily: fonts.bodySemi, fontSize: 15, color: colors.onAccent },
  statusRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 20 },
  statusText: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted },
});
