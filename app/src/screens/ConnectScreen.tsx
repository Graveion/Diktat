import { useState, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Linking, ScrollView,
} from "react-native";
import { loadConfig, saveConfig, loadRecentHosts, saveRecentHost, SavedHost } from "../store/config";
import { ScanScreen } from "./ScanScreen";
import { APP_VERSION, UPDATE_LABEL } from "../../App";

type Props = {
  onConnect: (host: string, port: number) => void;
  connectionState: string;
};

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
      {/* Hero section — vertically centred in top half */}
      <View style={styles.hero}>
        <Text style={styles.wordmark}>diktat</Text>
        <Text style={styles.tagline}>Voice-driven coding assistant</Text>
        <Text style={styles.version}>v{APP_VERSION}  ·  {UPDATE_LABEL}</Text>
      </View>

      {/* Recent hosts */}
      {recentHosts.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.recentRow}
          contentContainerStyle={styles.recentRowContent}
        >
          {recentHosts.map((saved) => {
            const lastOctet = saved.host.split(".").pop() ?? saved.host;
            return (
              <TouchableOpacity
                key={saved.host}
                style={styles.recentChip}
                onPress={() => handleRecentHostTap(saved)}
              >
                <Text style={styles.recentChipText}>·{lastOctet}:{saved.port}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        {connectionState === "error" && (
          <TouchableOpacity
            style={styles.errorBanner}
            onPress={() => Linking.openURL("tailscale://")}
          >
            <Text style={styles.errorText}>
              Connection failed — check Tailscale is running on both devices.{" "}
              <Text style={styles.errorLink}>Open Tailscale →</Text>
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.primaryButton} onPress={() => setScanning(true)}>
          <Text style={styles.primaryButtonText}>⊞  Scan QR code</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={() => setShowManual(!showManual)}>
          <Text style={styles.secondaryButtonText}>Enter address manually</Text>
        </TouchableOpacity>

        {showManual && (
          <View style={styles.manualCard}>
            <TextInput
              style={styles.input}
              value={host}
              onChangeText={setHost}
              placeholder="100.x.x.x"
              placeholderTextColor="#444"
              autoCapitalize="none"
              keyboardType="numeric"
            />
            <TextInput
              style={styles.input}
              value={port}
              onChangeText={setPort}
              placeholder="9000"
              placeholderTextColor="#444"
              keyboardType="numeric"
            />
            <TouchableOpacity
              style={[styles.connectButton, (!host || connectionState === "connecting") && styles.connectButtonDisabled]}
              onPress={handleConnect}
              disabled={!host || connectionState === "connecting"}
            >
              {connectionState === "connecting"
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.connectButtonText}>Connect</Text>
              }
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity onPress={() => setShowSetup(!showSetup)} style={styles.setupToggle}>
          <Text style={styles.setupToggleText}>
            {showSetup ? "▲ Hide setup guide" : "▼ First time? Setup guide"}
          </Text>
        </TouchableOpacity>

        {showSetup && (
          <View style={styles.setupCard}>
            <SetupStep number="1" title="Install Tailscale on your phone"
              description="Tailscale creates a secure private network between your devices."
              action="Get Tailscale" onAction={() => Linking.openURL("https://tailscale.com/download")} />
            <SetupStep number="2" title="Log in with your Tailscale account"
              description="Use the same account as your laptop." />
            <SetupStep number="3" title="Start the daemon on your laptop"
              description="Run `diktat start` in a terminal — it prints a QR code." />
            <SetupStep number="4" title="Scan the QR code"
              description="Tap Scan QR code above and point your camera at the terminal." />
          </View>
        )}
      </View>
    </View>
  );
}

function SetupStep({ number, title, description, action, onAction }: {
  number: string; title: string; description: string; action?: string; onAction?: () => void;
}) {
  return (
    <View style={stepStyles.container}>
      <View style={stepStyles.number}>
        <Text style={stepStyles.numberText}>{number}</Text>
      </View>
      <View style={stepStyles.content}>
        <Text style={stepStyles.title}>{title}</Text>
        <Text style={stepStyles.description}>{description}</Text>
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
  container: { flex: 1, backgroundColor: "#0d0d0d" },

  hero: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 20,
  },
  wordmark: {
    fontSize: 52,
    fontWeight: "700",
    color: "#fff",
    letterSpacing: -1,
    marginBottom: 10,
  },
  tagline: {
    fontSize: 15,
    color: "#555",
    letterSpacing: 0.2,
    marginBottom: 8,
  },
  version: {
    fontSize: 11,
    color: "#333",
    letterSpacing: 0.5,
  },

  recentRow: {
    flexGrow: 0,
    marginBottom: 12,
  },
  recentRowContent: {
    paddingHorizontal: 24,
    gap: 8,
  },
  recentChip: {
    backgroundColor: "#1a1a1a",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#2a2a2a",
  },
  recentChipText: {
    color: "#4f8ef7",
    fontSize: 13,
    fontWeight: "500",
    fontFamily: "monospace",
  },

  actions: {
    paddingHorizontal: 24,
    paddingBottom: 48,
    gap: 10,
  },

  errorBanner: {
    backgroundColor: "#1f1000",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#f90",
    marginBottom: 4,
  },
  errorText: { color: "#f90", fontSize: 13, lineHeight: 18 },
  errorLink: { textDecorationLine: "underline" },

  primaryButton: {
    backgroundColor: "#4f8ef7",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  primaryButtonText: { color: "#fff", fontSize: 17, fontWeight: "600" },

  secondaryButton: {
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#2a2a2a",
  },
  secondaryButtonText: { color: "#888", fontSize: 15 },

  manualCard: {
    backgroundColor: "#161616",
    borderRadius: 12,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: "#222",
  },
  input: {
    backgroundColor: "#1e1e1e",
    color: "#fff",
    borderRadius: 8,
    padding: 13,
    fontSize: 15,
  },
  connectButton: {
    backgroundColor: "#4f8ef7",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginTop: 2,
  },
  connectButtonDisabled: { opacity: 0.4 },
  connectButtonText: { color: "#fff", fontSize: 15, fontWeight: "600" },

  setupToggle: { alignItems: "center", paddingVertical: 4 },
  setupToggleText: { color: "#3a3a3a", fontSize: 13 },

  setupCard: {
    backgroundColor: "#161616",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#222",
  },
});

const stepStyles = StyleSheet.create({
  container: { flexDirection: "row", marginBottom: 20 },
  number: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: "#1a3a6a",
    justifyContent: "center", alignItems: "center", marginRight: 12, marginTop: 2, flexShrink: 0,
  },
  numberText: { color: "#4f8ef7", fontWeight: "bold", fontSize: 13 },
  content: { flex: 1 },
  title: { color: "#ccc", fontWeight: "600", fontSize: 14, marginBottom: 3 },
  description: { color: "#555", fontSize: 13, lineHeight: 18 },
  action: { color: "#4f8ef7", marginTop: 5, fontSize: 13 },
});
