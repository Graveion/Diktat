import { useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  RefreshControl,
  Modal,
  Pressable,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import Animated, { FadeIn, FadeInUp, FadeOut, ZoomIn, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, fonts, radii, space } from "../theme";
import { INSTALL_COMMAND } from "../constants";
import type { Machine } from "../hooks/useMachines";
import { ScanScreen } from "./ScanScreen";

type Props = {
  machines: Machine[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onSelect: (machine: Machine) => void;
  onClaim: (nonce: string) => Promise<{ ok: boolean; machineId?: string; error?: string }>;
  onUnpair: (id: string) => Promise<void>;
  onSignOut: () => void;
  onDeleteAccount: () => Promise<void>;
  /** Enter demo mode without pairing a Mac (used for App Store review). */
  onTryDemo?: () => void;
};

function relativeTime(iso: string | null): string {
  if (!iso) return "never connected";
  const diff = Date.now() - Date.parse(iso);
  if (diff < 60_000) return "online now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function MachinesScreen({
  machines,
  loading,
  error,
  onRefresh,
  onSelect,
  onClaim,
  onUnpair,
  onSignOut,
  onDeleteAccount,
  onTryDemo,
}: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [offlineMachine, setOfflineMachine] = useState<Machine | null>(null);
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  // Once the just-paired machine appears in the list, select it (connect).
  useEffect(() => {
    if (!targetId) return;
    const m = machines.find((x) => x.id === targetId);
    if (m) {
      setTargetId(null);
      setClaiming(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onSelect(m);
    }
  }, [machines, targetId, onSelect]);

  const handleScanned = async (nonce: string) => {
    setScanning(false);
    setClaiming(true);
    setScanError(null);
    const res = await onClaim(nonce);
    if (!res.ok) {
      setClaiming(false);
      setScanError(res.error ?? "Pairing failed");
      return;
    }
    setTargetId(res.machineId ?? null); // auto-select once it appears
  };

  const confirmUnpair = (m: Machine) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    Alert.alert("Unpair machine", `Remove "${m.name}"? You'll need to pair it again.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Unpair", style: "destructive", onPress: () => onUnpair(m.id) },
    ]);
  };

  const confirmDeleteAccount = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    Alert.alert(
      "Delete account",
      "This permanently deletes your account, unpairs all your machines, and erases your data. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            setSettingsOpen(false);
            try {
              await onDeleteAccount();
            } catch (e: any) {
              setDeleting(false);
              Alert.alert("Couldn't delete account", e?.message ?? "Please try again.");
            }
          },
        },
      ],
    );
  };

  const handleMachinePress = (m: Machine) => {
    const online = m.lastSeenAt && Date.now() - Date.parse(m.lastSeenAt) < 120_000;
    if (online) {
      onSelect(m);
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      setOfflineMachine(m);
    }
  };

  if (scanning) {
    return <ScanScreen onScanned={handleScanned} onCancel={() => setScanning(false)} />;
  }

  const neverConnected = (m: Machine) => !m.lastSeenAt;

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 18 }]}>
        <Text style={styles.title}>Your machines</Text>
        <TouchableOpacity onPress={() => setSettingsOpen(true)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Settings">
          <Ionicons name="settings-outline" size={22} color={colors.textSub} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={doRefresh} tintColor={colors.accent} />
        }
      >
        {loading && machines.length === 0 ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
        ) : machines.length === 0 ? (
          <Animated.View entering={reducedMotion ? undefined : FadeIn.duration(400)} style={styles.empty}>
            <Text style={styles.emptyTitle}>Connect your Mac</Text>

            <View style={styles.step}>
              <Text style={styles.stepNum}>1</Text>
              <View style={styles.stepBody}>
                <Text style={styles.stepText}>Run this on your Mac to install the daemon</Text>
                <View style={styles.installCmd}>
                  <Text style={styles.installCmdText} selectable>{INSTALL_COMMAND}</Text>
                </View>
              </View>
            </View>

            <View style={styles.step}>
              <Text style={styles.stepNum}>2</Text>
              <View style={styles.stepBody}>
                <Text style={styles.stepText}>
                  Run <Text style={styles.mono}>diktat pair</Text> in your terminal
                </Text>
              </View>
            </View>

            <View style={styles.step}>
              <Text style={styles.stepNum}>3</Text>
              <View style={styles.stepBody}>
                <Text style={styles.stepText}>Tap below and scan the QR it shows</Text>
              </View>
            </View>
          </Animated.View>
        ) : (
          machines.map((m, i) => {
            const online = m.lastSeenAt && Date.now() - Date.parse(m.lastSeenAt) < 120_000;
            return (
              <Animated.View key={m.id} entering={reducedMotion ? undefined : FadeInUp.delay(i * 60).duration(400)}>
                <TouchableOpacity
                  style={styles.machineCard}
                  onPress={() => handleMachinePress(m)}
                  onLongPress={() => confirmUnpair(m)}
                  accessibilityRole="button"
                  accessibilityLabel={`${m.name}, ${online ? "online" : relativeTime(m.lastSeenAt)}`}
                  accessibilityHint={online ? "Connects to this machine. Long-press to unpair." : "Daemon not running. Tap for help."}
                >
                  <Animated.View
                    key={online ? "online" : "offline"}
                    entering={reducedMotion ? undefined : ZoomIn.springify().damping(12)}
                    style={[
                      styles.dot,
                      { backgroundColor: online ? colors.success : colors.textMuted },
                      online && { shadowColor: colors.success, shadowRadius: 6, shadowOpacity: 0.9, shadowOffset: { width: 0, height: 0 } },
                    ]}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.machineName}>{m.name}</Text>
                    <Text style={styles.machineMeta}>{relativeTime(m.lastSeenAt)}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              </Animated.View>
            );
          })
        )}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {scanError ? <Text style={styles.errorText}>{scanError}</Text> : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => { setScanError(null); setScanning(true); }}
          disabled={claiming}
          accessibilityRole="button"
          accessibilityLabel="Pair a machine"
        >
          {claiming ? (
            <ActivityIndicator color={colors.onAccent} size="small" />
          ) : (
            <>
              <Ionicons name="qr-code-outline" size={17} color={colors.onAccent} />
              <Text style={styles.addBtnText}>Pair a machine</Text>
            </>
          )}
        </TouchableOpacity>

        {onTryDemo && machines.length === 0 ? (
          <TouchableOpacity onPress={onTryDemo} hitSlop={8} testID="try-demo-btn" accessibilityRole="button" accessibilityLabel="Try demo">
            <Text style={styles.tryDemo}>Try the demo →</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* ── Settings sheet ─────────────────────────────────────────────── */}
      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <Pressable style={styles.overlay} onPress={() => setSettingsOpen(false)}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Account</Text>

            <TouchableOpacity style={styles.sheetRow} onPress={() => { setSettingsOpen(false); onSignOut(); }} accessibilityRole="button">
              <Ionicons name="log-out-outline" size={20} color={colors.textSub} />
              <Text style={styles.sheetRowText}>Sign out</Text>
            </TouchableOpacity>

            <View style={styles.sheetDivider} />

            <TouchableOpacity style={styles.sheetRow} onPress={confirmDeleteAccount} disabled={deleting} accessibilityRole="button">
              {deleting ? (
                <ActivityIndicator color={colors.error} size="small" />
              ) : (
                <Ionicons name="trash-outline" size={20} color={colors.error} />
              )}
              <Text style={[styles.sheetRowText, { color: colors.error }]}>Delete account</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Offline machine sheet ──────────────────────────────────────── */}
      <Modal visible={!!offlineMachine} transparent animationType="fade" onRequestClose={() => setOfflineMachine(null)}>
        <Pressable style={styles.overlay} onPress={() => setOfflineMachine(null)}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
            <View style={styles.sheetHandle} />

            <View style={styles.offlineIcon}>
              <Ionicons name="desktop-outline" size={28} color={colors.textMuted} />
            </View>

            <Text style={styles.sheetTitle}>{offlineMachine?.name ?? "Mac"}</Text>
            <Text style={styles.offlineBody}>
              {neverConnected(offlineMachine!) ? (
                "This Mac has never connected. Complete pairing by running:"
              ) : (
                "The daemon isn't running on this Mac. Start it with:"
              )}
            </Text>

            <View style={styles.installCmd}>
              <Text style={styles.installCmdText} selectable>
                {neverConnected(offlineMachine!) ? "diktat pair" : "diktat start"}
              </Text>
            </View>

            <TouchableOpacity
              style={styles.offlineConnectBtn}
              onPress={() => { setOfflineMachine(null); if (offlineMachine) onSelect(offlineMachine); }}
              accessibilityRole="button"
            >
              <Text style={styles.offlineConnectText}>Try connecting anyway</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setOfflineMachine(null)} hitSlop={12} accessibilityRole="button" style={{ marginTop: 4 }}>
              <Text style={styles.offlineDismiss}>Dismiss</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  title: { fontFamily: fonts.display, fontSize: 28, color: colors.text, letterSpacing: -0.5 },

  list: { paddingHorizontal: space.lg, paddingBottom: 24, gap: 10 },

  machineCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 12,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  machineName: { fontFamily: fonts.bodySemi, fontSize: 16, color: colors.text },
  machineMeta: { fontFamily: fonts.body, fontSize: 12, color: colors.textSub, marginTop: 2 },

  empty: { marginTop: 40, paddingHorizontal: 8, gap: 18 },
  emptyTitle: { fontFamily: fonts.bodySemi, fontSize: 18, color: colors.text, marginBottom: 4, textAlign: "center" },
  step: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  stepNum: {
    fontFamily: fonts.mono, fontSize: 13, color: colors.accent,
    width: 24, height: 24, lineHeight: 22, textAlign: "center",
    borderWidth: 1, borderColor: colors.accentDim, borderRadius: radii.full,
    overflow: "hidden",
  },
  stepBody: { flex: 1, gap: 8, paddingTop: 2 },
  stepText: { fontFamily: fonts.body, fontSize: 14, color: colors.textSub, lineHeight: 20 },
  installCmd: {
    backgroundColor: colors.codeBg, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, paddingHorizontal: 12, paddingVertical: 10,
  },
  installCmdText: { fontFamily: fonts.mono, fontSize: 12, color: colors.codeText, lineHeight: 18 },
  mono: { fontFamily: fonts.mono, color: colors.accentBright },

  footer: { paddingHorizontal: space.lg, gap: 8 },
  addBtn: {
    flexDirection: "row", justifyContent: "center", gap: 8,
    backgroundColor: colors.accent,
    borderRadius: radii.md, padding: 17, alignItems: "center",
  },
  addBtnText: { fontFamily: fonts.bodySemi, color: colors.onAccent, fontSize: 16 },
  tryDemo: { fontFamily: fonts.bodySemi, fontSize: 13, color: colors.accent, textAlign: "center", paddingVertical: 8 },

  errorText: { fontFamily: fonts.body, fontSize: 13, color: colors.error, textAlign: "center", marginTop: 8 },

  // ── Shared sheet styles ────────────────────────────────────────────────────
  overlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    paddingHorizontal: space.lg, paddingTop: 12,
    gap: 4,
  },
  sheetHandle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: "center", marginBottom: 16,
  },
  sheetTitle: {
    fontFamily: fonts.bodySemi, fontSize: 17, color: colors.text,
    marginBottom: 8,
  },
  sheetRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 14,
  },
  sheetRowText: { fontFamily: fonts.body, fontSize: 16, color: colors.textSub },
  sheetDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 2 },

  // ── Offline sheet ──────────────────────────────────────────────────────────
  offlineIcon: { alignSelf: "center", marginBottom: 4 },
  offlineBody: {
    fontFamily: fonts.body, fontSize: 14, color: colors.textSub,
    lineHeight: 20, marginBottom: 10,
  },
  offlineConnectBtn: {
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, padding: 14, alignItems: "center",
    marginTop: 12,
  },
  offlineConnectText: { fontFamily: fonts.bodySemi, fontSize: 15, color: colors.textSub },
  offlineDismiss: { fontFamily: fonts.body, fontSize: 14, color: colors.textMuted, textAlign: "center", paddingVertical: 8 },
});
