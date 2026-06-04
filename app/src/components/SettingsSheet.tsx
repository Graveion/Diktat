import { Modal, Pressable, TouchableOpacity, View, Text, StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import { colors, fonts } from "../theme";
import { MicMode, MIC_LABELS, Settings } from "../utils/settings";
import { APP_VERSION, UPDATE_LABEL } from "../../App";

type Props = {
  visible: boolean;
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  onClose: () => void;
};

const MIC_MODES: MicMode[] = ["toggle", "hold"];

export function SettingsSheet({ visible, settings, onUpdate, onClose }: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} accessible={false} onPress={onClose}>
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
          <Text style={styles.title}>Settings</Text>

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

          <TouchableOpacity testID="settings-done-button" accessibilityRole="button" style={styles.done} onPress={onClose} activeOpacity={0.85}>
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>

          <Text style={styles.versionFooter}>v{APP_VERSION} · {UPDATE_LABEL}</Text>
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
});
