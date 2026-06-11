import { useState } from "react";
import { Modal, Pressable, TouchableOpacity, View, Text, TextInput, StyleSheet, Linking, ActivityIndicator } from "react-native";
import * as Haptics from "expo-haptics";
import { colors, fonts } from "../theme";
import { MicMode, MIC_LABELS, Settings } from "../utils/settings";
import { submitFeedback, type FeedbackKind } from "../utils/feedback";
import { openStoreReview } from "../utils/review";
import { PRIVACY_URL, SUPPORT_URL } from "../constants";
import { APP_VERSION, UPDATE_LABEL } from "../constants";

type Props = {
  visible: boolean;
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  onClose: () => void;
};

const MIC_MODES: MicMode[] = ["toggle", "hold"];
const FEEDBACK_KINDS: { id: FeedbackKind; label: string }[] = [
  { id: "idea", label: "💡 Idea" },
  { id: "bug", label: "🐞 Bug" },
  { id: "praise", label: "❤️ Praise" },
];

export function SettingsSheet({ visible, settings, onUpdate, onClose }: Props) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [kind, setKind] = useState<FeedbackKind>("idea");
  const [message, setMessage] = useState("");
  const [includeCrash, setIncludeCrash] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const resetFeedback = () => {
    setFeedbackOpen(false);
    setMessage("");
    setKind("idea");
    setIncludeCrash(false);
    setSent(false);
    setSubmitting(false);
  };

  const handleClose = () => {
    resetFeedback();
    onClose();
  };

  const sendFeedback = async () => {
    if (!message.trim() || submitting) return;
    setSubmitting(true);
    Haptics.selectionAsync();
    const ok = await submitFeedback({ message, kind, includeCrash: kind === "bug" && includeCrash });
    setSubmitting(false);
    if (ok) {
      setSent(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(resetFeedback, 1200);
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <Pressable style={styles.overlay} accessible={false} onPress={handleClose}>
        {/*
          Plain View (not a TouchableOpacity): on iOS a touchable becomes an
          accessibility container that merges all its children into one node,
          which made VoiceOver and Maestro see the whole sheet as a single
          element. onStartShouldSetResponder claims the touch so taps on the
          sheet's dead areas don't fall through to the overlay's dismiss.
        */}
        <View
          style={styles.sheet}
          onStartShouldSetResponder={() => true}
        >
          <View style={styles.handle} />
          <Text style={styles.title}>{feedbackOpen ? "Send feedback" : "Settings"}</Text>

          {feedbackOpen ? (
            <>
              {sent ? (
                <Text style={styles.sentMsg}>Thanks — sent! 🙌</Text>
              ) : (
                <>
                  <View style={styles.kindRow}>
                    {FEEDBACK_KINDS.map((k) => (
                      <TouchableOpacity
                        key={k.id}
                        testID={`feedback-kind-${k.id}`}
                        style={[styles.kindChip, kind === k.id && styles.kindChipActive]}
                        onPress={() => { Haptics.selectionAsync(); setKind(k.id); }}
                        activeOpacity={0.8}
                      >
                        <Text style={[styles.kindText, kind === k.id && styles.kindTextActive]}>{k.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput
                    testID="feedback-input"
                    style={styles.feedbackInput}
                    value={message}
                    onChangeText={setMessage}
                    placeholder={kind === "bug" ? "What went wrong?" : "Tell us what you think…"}
                    placeholderTextColor={colors.textMuted}
                    multiline
                    autoFocus
                  />
                  {kind === "bug" ? (
                    <TouchableOpacity
                      style={styles.diagRow}
                      onPress={() => { Haptics.selectionAsync(); setIncludeCrash((v) => !v); }}
                      activeOpacity={0.8}
                    >
                      <View style={[styles.checkbox, includeCrash && styles.checkboxOn]}>
                        {includeCrash ? <Text style={styles.checkboxTick}>✓</Text> : null}
                      </View>
                      <Text style={styles.diagText}>Attach diagnostics (last crash log)</Text>
                    </TouchableOpacity>
                  ) : null}
                  <View style={styles.feedbackActions}>
                    <TouchableOpacity testID="feedback-back" style={styles.cancelBtn} onPress={resetFeedback} activeOpacity={0.85}>
                      <Text style={styles.cancelText}>Back</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID="feedback-submit"
                      style={[styles.done, styles.submitBtn, (!message.trim() || submitting) && styles.submitDisabled]}
                      onPress={sendFeedback}
                      disabled={!message.trim() || submitting}
                      activeOpacity={0.85}
                    >
                      {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.doneText}>Send</Text>}
                    </TouchableOpacity>
                  </View>
                </>
              )}
              <Text style={styles.versionFooter}>v{APP_VERSION} · {UPDATE_LABEL}</Text>
            </>
          ) : (
          <>
          <Text style={styles.sectionLabel}>Microphone</Text>
          <Text style={styles.sectionHint}>How the mic button works during dictation.</Text>
          <View style={styles.options}>
            {MIC_MODES.map((m) => {
              const active = settings.micMode === m;
              return (
                <TouchableOpacity
                  key={m}
                  testID={`micmode-${m}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={MIC_LABELS[m]}
                  style={[styles.option, active && styles.optionActive]}
                  onPress={() => {
                    Haptics.selectionAsync();
                    onUpdate({ micMode: m });
                  }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.radio, active && styles.radioActive]}>
                    {active ? <View style={styles.radioInner} /> : null}
                  </View>
                  <Text style={[styles.optionText, active && styles.optionTextActive]}>
                    {MIC_LABELS[m]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={[styles.sectionLabel, styles.supportHeader]}>Feedback &amp; Support</Text>
          <View style={styles.linkList}>
            <TouchableOpacity testID="open-feedback" style={styles.linkRow} onPress={() => { Haptics.selectionAsync(); setFeedbackOpen(true); }} activeOpacity={0.7}>
              <Text style={styles.linkText}>Send feedback</Text>
              <Text style={styles.linkChevron}>›</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="rate-app" style={styles.linkRow} onPress={() => { Haptics.selectionAsync(); openStoreReview(); }} activeOpacity={0.7}>
              <Text style={styles.linkText}>Rate Diktat</Text>
              <Text style={styles.linkChevron}>›</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="open-support" style={styles.linkRow} onPress={() => Linking.openURL(SUPPORT_URL)} activeOpacity={0.7}>
              <Text style={styles.linkText}>Help &amp; support</Text>
              <Text style={styles.linkChevron}>↗</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="open-privacy" style={styles.linkRow} onPress={() => Linking.openURL(PRIVACY_URL)} activeOpacity={0.7}>
              <Text style={styles.linkText}>Privacy policy</Text>
              <Text style={styles.linkChevron}>↗</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity testID="settings-done-button" accessibilityRole="button" style={styles.done} onPress={handleClose} activeOpacity={0.85}>
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>

          <Text style={styles.versionFooter}>v{APP_VERSION} · {UPDATE_LABEL}</Text>
          </>
          )}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 40,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 16,
  },
  title: {
    fontFamily: fonts.display,
    color: colors.text,
    fontSize: 20,
    marginBottom: 22,
  },
  sectionLabel: {
    fontFamily: fonts.bodySemi,
    color: colors.text,
    fontSize: 14,
    marginBottom: 4,
  },
  sectionHint: {
    fontFamily: fonts.body,
    color: colors.textSub,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 14,
  },
  options: { gap: 6, marginBottom: 18 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optionActive: {
    backgroundColor: colors.accentFaint,
    borderColor: colors.accentDim,
  },
  radio: {
    width: 18, height: 18, borderRadius: 9,
    borderWidth: 2, borderColor: colors.border,
    justifyContent: "center", alignItems: "center",
  },
  radioActive: { borderColor: colors.accent },
  radioInner: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: colors.accent,
  },
  optionText: {
    fontFamily: fonts.body,
    color: colors.textSub,
    fontSize: 14,
    flex: 1,
  },
  optionTextActive: {
    fontFamily: fonts.bodyMedium,
    color: colors.text,
  },
  done: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
  },
  doneText: {
    fontFamily: fonts.bodySemi,
    color: "#fff",
    fontSize: 15,
  },
  versionFooter: {
    fontFamily: fonts.body,
    color: colors.textMuted,
    fontSize: 11,
    textAlign: "center",
    marginTop: 14,
  },

  // Feedback & Support
  supportHeader: { marginTop: 4 },
  linkList: { gap: 6, marginBottom: 18 },
  linkRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingVertical: 13, paddingHorizontal: 14,
    borderRadius: 12, backgroundColor: colors.bg,
    borderWidth: 1, borderColor: colors.border,
  },
  linkText: { fontFamily: fonts.body, color: colors.text, fontSize: 14 },
  linkChevron: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 18 },

  // Feedback form
  kindRow: { flexDirection: "row", gap: 8, marginBottom: 14 },
  kindChip: {
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
  },
  kindChipActive: { backgroundColor: colors.accentFaint, borderColor: colors.accentDim },
  kindText: { fontFamily: fonts.body, color: colors.textSub, fontSize: 13 },
  kindTextActive: { fontFamily: fonts.bodyMedium, color: colors.text },
  feedbackInput: {
    minHeight: 110, maxHeight: 200,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: 12, padding: 14, textAlignVertical: "top",
    fontFamily: fonts.body, color: colors.text, fontSize: 14, marginBottom: 14,
  },
  diagRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 16 },
  checkbox: {
    width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: colors.border,
    justifyContent: "center", alignItems: "center",
  },
  checkboxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkboxTick: { color: "#fff", fontSize: 12, fontFamily: fonts.bodySemi },
  diagText: { fontFamily: fonts.body, color: colors.textSub, fontSize: 13, flex: 1 },
  feedbackActions: { flexDirection: "row", gap: 10 },
  cancelBtn: {
    flex: 1, borderRadius: 12, paddingVertical: 13, alignItems: "center",
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
  },
  cancelText: { fontFamily: fonts.bodySemi, color: colors.textSub, fontSize: 15 },
  submitBtn: { flex: 1, marginTop: 0 },
  submitDisabled: { opacity: 0.4 },
  sentMsg: {
    fontFamily: fonts.bodySemi, color: colors.accent, fontSize: 16,
    textAlign: "center", paddingVertical: 40,
  },
});
