import { useState, useEffect, useRef } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Linking, ScrollView,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  FadeIn, FadeInDown, FadeInUp, useSharedValue, useAnimatedStyle,
  withRepeat, withTiming, withSequence, Easing,
} from "react-native-reanimated";
import { loadConfig, saveConfig, loadRecentHosts, saveRecentHost, SavedHost } from "../store/config";
import { ScanScreen } from "./ScanScreen";
import { APP_VERSION, UPDATE_LABEL } from "../../App";
import { colors, fonts } from "../theme";

type Props = {
  onConnect: (host: string, port: number) => void;
  connectionState: string;
};

// Pulsing orb behind the wordmark
function AmbientOrb() {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(0.15);

  useEffect(() => {
    scale.value = withRepeat(
      withSequence(
        withTiming(1.15, { duration: 3000, easing: Easing.inOut(Easing.sin) }),
        withTiming(1,    { duration: 3000, easing: Easing.inOut(Easing.sin) }),
      ),
      -1, false
    );
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.22, { duration: 3000, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.10, { duration: 3000, easing: Easing.inOut(Easing.sin) }),
      ),
      -1, false
    );
  }, []);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={[orbStyles.orb, style]}>
      <LinearGradient
        colors={["#7c3aed", "#4c1d95", "transparent"]}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0.5 }}
        end={{ x: 1, y: 1 }}
      />
    </Animated.View>
  );
}

export function ConnectScreen({ onConnect, connectionState }: Props) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9000");
  const [scanning, setScanning] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [recentHosts, setRecentHosts] = useState<SavedHost[]>([]);

  useEffect(() => {
    loadConfig().then((c) => {
      if (c.host) setHost(c.host);
      setPort(String(c.port));
    });
    loadRecentHosts().then(setRecentHosts);
  }, []);

  const handleConnect = async () => {
    await saveConfig({ host, port: parseInt(port) });
    await saveRecentHost(host, parseInt(port));
    loadRecentHosts().then(setRecentHosts);
    onConnect(host, parseInt(port));
  };

  const handleScanned = async (scannedHost: string, scannedPort: number) => {
    setScanning(false);
    setHost(scannedHost);
    setPort(String(scannedPort));
    await saveConfig({ host: scannedHost, port: scannedPort });
    await saveRecentHost(scannedHost, scannedPort);
    loadRecentHosts().then(setRecentHosts);
    onConnect(scannedHost, scannedPort);
  };

  const handleRecentHostTap = async (saved: SavedHost) => {
    await saveRecentHost(saved.host, saved.port);
    loadRecentHosts().then(setRecentHosts);
    onConnect(saved.host, saved.port);
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
        end={{ x: 0.5, y: 0.6 }}
      />

      {/* Hero */}
      <View style={styles.hero}>
        <AmbientOrb />

        <Animated.Text entering={FadeIn.delay(80).duration(900)} style={styles.wordmark}>
          diktat
        </Animated.Text>
        <Animated.Text entering={FadeIn.delay(240).duration(700)} style={styles.tagline}>
          voice-driven coding
        </Animated.Text>
        <Animated.Text entering={FadeIn.delay(380).duration(600)} style={styles.version}>
          {APP_VERSION} · {UPDATE_LABEL}
        </Animated.Text>
      </View>

      {/* Recent hosts */}
      {recentHosts.length > 0 && (
        <Animated.ScrollView
          entering={FadeInUp.delay(500).duration(500)}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.recentRow}
          contentContainerStyle={styles.recentContent}
        >
          {recentHosts.map((saved, i) => {
            const lastOctet = saved.host.split(".").pop() ?? saved.host;
            return (
              <TouchableOpacity
                key={saved.host}
                style={styles.recentChip}
                onPress={() => handleRecentHostTap(saved)}
              >
                <Text style={styles.recentChipText}>·{lastOctet}</Text>
              </TouchableOpacity>
            );
          })}
        </Animated.ScrollView>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        {connectionState === "error" && (
          <Animated.View entering={FadeInDown.duration(300)}>
            <TouchableOpacity
              style={styles.errorBanner}
              onPress={() => Linking.openURL("tailscale://")}
            >
              <Text style={styles.errorText}>
                Connection failed — check Tailscale.{" "}
                <Text style={styles.errorLink}>Open →</Text>
              </Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        <Animated.View entering={FadeInUp.delay(420).duration(500)}>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setScanning(true)}>
            <LinearGradient
              colors={[colors.accent, "#7c3aed"]}
              style={StyleSheet.absoluteFill}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            />
            <Text style={styles.primaryBtnText}>⊞  Scan QR code</Text>
          </TouchableOpacity>
        </Animated.View>

        <Animated.View entering={FadeInUp.delay(520).duration(500)}>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setShowManual(!showManual)}>
            <Text style={styles.secondaryBtnText}>Enter address manually</Text>
          </TouchableOpacity>
        </Animated.View>

        {showManual && (
          <Animated.View entering={FadeInDown.duration(300)} style={styles.manualCard}>
            <TextInput
              style={styles.input}
              value={host}
              onChangeText={setHost}
              placeholder="100.x.x.x"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              keyboardType="numeric"
            />
            <TextInput
              style={styles.input}
              value={port}
              onChangeText={setPort}
              placeholder="9000"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
            />
            <TouchableOpacity
              style={[styles.connectBtn, (!host || connectionState === "connecting") && styles.connectBtnDisabled]}
              onPress={handleConnect}
              disabled={!host || connectionState === "connecting"}
            >
              {connectionState === "connecting"
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.connectBtnText}>Connect</Text>}
            </TouchableOpacity>
          </Animated.View>
        )}

        <Animated.View entering={FadeInUp.delay(620).duration(500)}>
          <TouchableOpacity onPress={() => setShowSetup(!showSetup)} style={styles.setupToggle}>
            <Text style={styles.setupToggleText}>
              {showSetup ? "▲ Hide setup guide" : "▼ First time? Setup guide"}
            </Text>
          </TouchableOpacity>
        </Animated.View>

        {showSetup && (
          <Animated.View entering={FadeInDown.duration(300)} style={styles.setupCard}>
            <SetupStep n="1" title="Install Tailscale"
              desc="Creates a secure private network between your devices."
              action="Get Tailscale" onAction={() => Linking.openURL("https://tailscale.com/download")} />
            <SetupStep n="2" title="Log in to Tailscale"
              desc="Use the same account as your laptop." />
            <SetupStep n="3" title="Start the daemon"
              desc="Run `diktat start` in a terminal — it prints a QR code." />
            <SetupStep n="4" title="Scan the QR code"
              desc="Tap Scan above and point your camera at the terminal." />
          </Animated.View>
        )}
      </View>
    </View>
  );
}

function SetupStep({ n, title, desc, action, onAction }: {
  n: string; title: string; desc: string; action?: string; onAction?: () => void;
}) {
  return (
    <View style={stepStyles.row}>
      <View style={stepStyles.num}>
        <Text style={stepStyles.numText}>{n}</Text>
      </View>
      <View style={stepStyles.content}>
        <Text style={stepStyles.title}>{title}</Text>
        <Text style={stepStyles.desc}>{desc}</Text>
        {action && onAction && (
          <TouchableOpacity onPress={onAction}>
            <Text style={stepStyles.action}>{action} →</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  hero: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 24,
  },
  wordmark: {
    fontFamily: fonts.displayXBold,
    fontSize: 64,
    color: colors.text,
    letterSpacing: -2,
    marginBottom: 10,
  },
  tagline: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.textMuted,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  version: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.textFaint,
    letterSpacing: 0.5,
  },

  recentRow: { flexGrow: 0, marginBottom: 12 },
  recentContent: { paddingHorizontal: 20, gap: 8, flexDirection: "row" },
  recentChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: colors.card,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  recentChipText: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.accent },

  actions: { paddingHorizontal: 20, paddingBottom: 48, gap: 10 },

  errorBanner: {
    backgroundColor: "#1f0a0a",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#7f1d1d",
    marginBottom: 4,
  },
  errorText: { fontFamily: fonts.body, color: colors.error, fontSize: 13, lineHeight: 18 },
  errorLink: { textDecorationLine: "underline" },

  primaryBtn: {
    borderRadius: 14,
    padding: 17,
    alignItems: "center",
    overflow: "hidden",
  },
  primaryBtnText: { fontFamily: fonts.bodySemi, color: "#fff", fontSize: 16 },

  secondaryBtn: {
    borderRadius: 14,
    padding: 16,
    alignItems: "center",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryBtnText: { fontFamily: fonts.body, color: colors.textSub, fontSize: 15 },

  manualCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: {
    backgroundColor: colors.input,
    color: colors.text,
    borderRadius: 10,
    padding: 13,
    fontSize: 15,
    fontFamily: fonts.body,
  },
  connectBtn: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
    marginTop: 2,
  },
  connectBtnDisabled: { opacity: 0.35 },
  connectBtnText: { fontFamily: fonts.bodySemi, color: "#fff", fontSize: 15 },

  setupToggle: { alignItems: "center", paddingVertical: 2 },
  setupToggleText: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 13 },

  setupCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    gap: 2,
    borderWidth: 1,
    borderColor: colors.border,
  },
});

const stepStyles = StyleSheet.create({
  row: { flexDirection: "row", marginBottom: 18 },
  num: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: colors.accentFaint,
    borderWidth: 1, borderColor: colors.accentDim,
    justifyContent: "center", alignItems: "center",
    marginRight: 12, marginTop: 2, flexShrink: 0,
  },
  numText: { fontFamily: fonts.bodyBold, color: colors.accent, fontSize: 12 },
  content: { flex: 1 },
  title: { fontFamily: fonts.bodySemi, color: colors.text, fontSize: 14, marginBottom: 3 },
  desc: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  action: { fontFamily: fonts.bodyMedium, color: colors.accent, marginTop: 5, fontSize: 13 },
});

const orbStyles = StyleSheet.create({
  orb: {
    position: "absolute",
    width: 300,
    height: 300,
    borderRadius: 150,
    overflow: "hidden",
  },
});
