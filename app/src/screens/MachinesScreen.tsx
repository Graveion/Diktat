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
} from "react-native";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { FadeIn, FadeInUp } from "react-native-reanimated";
import { colors, fonts, radii, space } from "../theme";
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

  if (scanning) {
    return <ScanScreen onScanned={handleScanned} onCancel={() => setScanning(false)} />;
  }

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={["#120d1f", colors.bg, colors.bg]}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.4 }}
      />

      <View style={styles.header}>
        <Text style={styles.title}>Your machines</Text>
        <TouchableOpacity onPress={onSignOut} hitSlop={12}>
          <Text style={styles.signOut}>Sign out</Text>
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
          <Animated.View entering={FadeIn.duration(400)} style={styles.empty}>
            <Text style={styles.emptyTitle}>No machines yet</Text>
            <Text style={styles.emptyDesc}>
              On your Mac run <Text style={styles.mono}>diktat pair</Text>, then tap below to scan
              the QR it shows.
            </Text>
          </Animated.View>
        ) : (
          machines.map((m, i) => {
            const online = m.lastSeenAt && Date.now() - Date.parse(m.lastSeenAt) < 120_000;
            return (
              <Animated.View key={m.id} entering={FadeInUp.delay(i * 60).duration(400)}>
                <TouchableOpacity
                  style={styles.machineCard}
                  onPress={() => onSelect(m)}
                  onLongPress={() => confirmUnpair(m)}
                >
                  <View style={[styles.dot, { backgroundColor: online ? colors.success : colors.textMuted }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.machineName}>{m.name}</Text>
                    <Text style={styles.machineMeta}>{relativeTime(m.lastSeenAt)}</Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              </Animated.View>
            );
          })
        )}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {scanError ? <Text style={styles.errorText}>{scanError}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity style={styles.addBtn} onPress={() => { setScanError(null); setScanning(true); }} disabled={claiming}>
          <LinearGradient
            colors={[colors.accent, "#7c3aed"]}
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          />
          {claiming ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.addBtnText}>⊞  Pair a machine</Text>
          )}
        </TouchableOpacity>

        {onTryDemo ? (
          <TouchableOpacity onPress={onTryDemo} hitSlop={8} testID="try-demo-btn">
            <Text style={styles.tryDemo}>Try Demo  →</Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity onPress={confirmDeleteAccount} disabled={deleting} hitSlop={8}>
          {deleting ? (
            <ActivityIndicator color={colors.error} size="small" style={{ marginTop: 4 }} />
          ) : (
            <Text style={styles.deleteAccount}>Delete account</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 64,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  title: { fontFamily: fonts.display, fontSize: 28, color: colors.text, letterSpacing: -0.5 },
  signOut: { fontFamily: fonts.bodyMedium, fontSize: 14, color: colors.textSub },

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
  chevron: { fontFamily: fonts.body, fontSize: 24, color: colors.textMuted },

  empty: { alignItems: "center", marginTop: 60, paddingHorizontal: 20 },
  emptyTitle: { fontFamily: fonts.bodySemi, fontSize: 18, color: colors.text, marginBottom: 8 },
  emptyDesc: { fontFamily: fonts.body, fontSize: 14, color: colors.textSub, textAlign: "center", lineHeight: 21 },
  mono: { fontFamily: fonts.mono, color: colors.accentBright },

  footer: { paddingHorizontal: space.lg, paddingBottom: 40, gap: 8 },
  addBtn: { borderRadius: radii.md, padding: 17, alignItems: "center", overflow: "hidden" },
  addBtnText: { fontFamily: fonts.bodySemi, color: "#fff", fontSize: 16 },
  tryDemo: { fontFamily: fonts.bodySemi, fontSize: 13, color: colors.accent, textAlign: "center", paddingVertical: 8 },
  deleteAccount: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, textAlign: "center", paddingVertical: 8 },

  errorText: { fontFamily: fonts.body, fontSize: 13, color: colors.error, textAlign: "center", marginTop: 8 },
});
