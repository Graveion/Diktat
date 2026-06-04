import { useEffect, useRef, useState } from "react";
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
import type { Machine, PairingCode } from "../hooks/useMachines";

type Props = {
  machines: Machine[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onSelect: (machine: Machine) => void;
  onCreateCode: () => Promise<PairingCode>;
  onUnpair: (id: string) => Promise<void>;
  onSignOut: () => void;
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
  onCreateCode,
  onUnpair,
  onSignOut,
}: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const baselineIds = useRef<Set<string>>(new Set());

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  // While a pairing code is shown, poll for the new machine to appear, then
  // auto-select it (pairing succeeded on the Mac).
  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => {
      onRefresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [code, onRefresh]);

  useEffect(() => {
    if (!code) return;
    const fresh = machines.find((m) => !baselineIds.current.has(m.id));
    if (fresh) {
      setCode(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onSelect(fresh);
    }
  }, [machines, code, onSelect]);

  const startPairing = async () => {
    setPairing(true);
    setCodeError(null);
    baselineIds.current = new Set(machines.map((m) => m.id));
    try {
      const c = await onCreateCode();
      setCode(c);
    } catch (e: any) {
      setCodeError(e?.message ?? "Could not create a pairing code");
    } finally {
      setPairing(false);
    }
  };

  const confirmUnpair = (m: Machine) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    Alert.alert("Unpair machine", `Remove "${m.name}"? You'll need to pair it again.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Unpair", style: "destructive", onPress: () => onUnpair(m.id) },
    ]);
  };

  // ── Pairing-code sheet ──────────────────────────────────────────────────
  if (code) {
    return (
      <View style={styles.container}>
        <LinearGradient
          colors={["#120d1f", colors.bg, colors.bg]}
          style={StyleSheet.absoluteFill}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 0.6 }}
        />
        <View style={styles.codeWrap}>
          <Text style={styles.codeTitle}>Pair a machine</Text>
          <Text style={styles.codeSub}>On the Mac you want to control, open Terminal and run:</Text>

          <View style={styles.codeBox}>
            <Text style={styles.codeCmd}>
              diktat pair <Text style={styles.codeValue}>{code.code}</Text>
            </Text>
          </View>

          <Text style={styles.codeHint}>
            Don't have it yet? Install the Diktat daemon on your Mac first, then run the
            command above.
          </Text>

          <View style={styles.waitingRow}>
            <ActivityIndicator color={colors.accent} size="small" />
            <Text style={styles.waitingText}>Waiting for your Mac to connect…</Text>
          </View>

          <TouchableOpacity style={styles.cancelBtn} onPress={() => setCode(null)}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Machines list ────────────────────────────────────────────────────────
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
              Pair the Mac running your coding sessions to get started.
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
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity style={styles.addBtn} onPress={startPairing} disabled={pairing}>
          <LinearGradient
            colors={[colors.accent, "#7c3aed"]}
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          />
          {pairing ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.addBtnText}>+  Pair a machine</Text>
          )}
        </TouchableOpacity>
        {codeError ? <Text style={styles.errorText}>{codeError}</Text> : null}
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
  emptyDesc: { fontFamily: fonts.body, fontSize: 14, color: colors.textSub, textAlign: "center", lineHeight: 20 },

  footer: { paddingHorizontal: space.lg, paddingBottom: 40, gap: 8 },
  addBtn: {
    borderRadius: radii.md,
    padding: 17,
    alignItems: "center",
    overflow: "hidden",
  },
  addBtnText: { fontFamily: fonts.bodySemi, color: "#fff", fontSize: 16 },

  errorText: { fontFamily: fonts.body, fontSize: 13, color: colors.error, textAlign: "center", marginTop: 8 },

  // Pairing-code sheet
  codeWrap: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: space.lg },
  codeTitle: { fontFamily: fonts.display, fontSize: 26, color: colors.text, marginBottom: 8 },
  codeSub: { fontFamily: fonts.body, fontSize: 14, color: colors.textSub, textAlign: "center", marginBottom: 24 },
  codeBox: {
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
    borderWidth: 1,
    borderColor: colors.accentDim,
    alignItems: "center",
    width: "100%",
  },
  codeCmd: { fontFamily: fonts.mono, fontSize: 20, color: colors.textSub },
  codeValue: {
    fontFamily: fonts.mono,
    fontSize: 20,
    color: colors.accentBright,
    letterSpacing: 2,
    fontWeight: "700",
  },
  codeHint: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textMuted,
    textAlign: "center",
    lineHeight: 17,
    marginTop: 14,
  },

  waitingRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 28 },
  waitingText: { fontFamily: fonts.body, fontSize: 14, color: colors.textSub },

  cancelBtn: { marginTop: 32, padding: 12 },
  cancelText: { fontFamily: fonts.bodyMedium, fontSize: 15, color: colors.textSub },
});
