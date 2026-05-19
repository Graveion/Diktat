import { useState, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Linking, ScrollView,
} from "react-native";
import * as Network from "expo-network";
import { loadConfig, saveConfig } from "../store/config";
import { ScanScreen } from "./ScanScreen";

type Props = {
  onConnect: (host: string, port: number) => void;
  connectionState: string;
};

export function ConnectScreen({ onConnect, connectionState }: Props) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9000");
  const [scanning, setScanning] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [tailscaleActive, setTailscaleActive] = useState<boolean | null>(null);

  useEffect(() => {
    loadConfig().then((c) => {
      if (c.host) setHost(c.host);
      setPort(String(c.port));
    });
    checkTailscale();
  }, []);

  const checkTailscale = async () => {
    try {
      const ip = await Network.getIpAddressAsync();
      setTailscaleActive(ip.startsWith("100."));
    } catch {
      setTailscaleActive(false);
    }
  };

  const handleConnect = async () => {
    await saveConfig({ host, port: parseInt(port) });
    onConnect(host, parseInt(port));
  };

  const handleScanned = async (scannedHost: string, scannedPort: number) => {
    setScanning(false);
    setHost(scannedHost);
    setPort(String(scannedPort));
    await saveConfig({ host: scannedHost, port: scannedPort });
    onConnect(scannedHost, scannedPort);
  };

  if (scanning) {
    return <ScanScreen onScanned={handleScanned} onCancel={() => setScanning(false)} />;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Diktat</Text>
      <Text style={styles.subtitle}>Voice-driven coding assistant</Text>

      {tailscaleActive === false && (
        <TouchableOpacity
          style={styles.tailscaleWarning}
          onPress={() => Linking.openURL("tailscale://")}
        >
          <Text style={styles.tailscaleWarningText}>
            ⚠ Tailscale not detected on this device.{"\n"}
            <Text style={styles.tailscaleWarningLink}>Tap to open Tailscale →</Text>
          </Text>
        </TouchableOpacity>
      )}

      {tailscaleActive === true && (
        <View style={styles.tailscaleOk}>
          <Text style={styles.tailscaleOkText}>● Tailscale active</Text>
        </View>
      )}

      <TouchableOpacity style={styles.scanButton} onPress={() => setScanning(true)}>
        <Text style={styles.scanButtonText}>⊞ Scan QR code from terminal</Text>
      </TouchableOpacity>

      <Text style={styles.orDivider}>or enter manually</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Daemon address</Text>
        <TextInput
          style={styles.input}
          value={host}
          onChangeText={setHost}
          placeholder="100.x.x.x"
          placeholderTextColor="#555"
          autoCapitalize="none"
          keyboardType="numeric"
        />
        <TextInput
          style={styles.input}
          value={port}
          onChangeText={setPort}
          placeholder="9000"
          placeholderTextColor="#555"
          keyboardType="numeric"
        />

        <TouchableOpacity
          style={[styles.button, (!host || connectionState === "connecting") && styles.buttonDisabled]}
          onPress={handleConnect}
          disabled={!host || connectionState === "connecting"}
        >
          {connectionState === "connecting"
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.buttonText}>Connect</Text>
          }
        </TouchableOpacity>

        {connectionState === "error" && (
          <Text style={styles.error}>
            Connection failed. Make sure Tailscale is running on both devices and the daemon is started.
          </Text>
        )}
      </View>

      <TouchableOpacity onPress={() => setShowSetup(!showSetup)} style={styles.setupToggle}>
        <Text style={styles.setupToggleText}>
          {showSetup ? "▲ Hide setup guide" : "▼ First time? Setup guide"}
        </Text>
      </TouchableOpacity>

      {showSetup && (
        <View style={styles.card}>
          <SetupStep
            number="1"
            title="Install Tailscale on your phone"
            description="Tailscale creates a secure private network between your devices."
            action="Get Tailscale"
            onAction={() => Linking.openURL("https://tailscale.com/download")}
          />
          <SetupStep
            number="2"
            title="Log in with your Tailscale account"
            description="Use the same account as your laptop."
          />
          <SetupStep
            number="3"
            title="Start the daemon on your laptop"
            description="In the Diktat folder run ./daemon.sh start — it prints a QR code."
          />
          <SetupStep
            number="4"
            title="Scan the QR code"
            description="Tap the Scan button above and point your camera at the terminal."
          />
        </View>
      )}
    </ScrollView>
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
  container: { flex: 1, backgroundColor: "#111" },
  content: { padding: 24, paddingTop: 80 },
  title: { fontSize: 36, fontWeight: "bold", color: "#fff", marginBottom: 6 },
  subtitle: { fontSize: 16, color: "#666", marginBottom: 24 },
  tailscaleWarning: {
    backgroundColor: "#2a1a00", borderRadius: 10, padding: 14,
    marginBottom: 16, borderWidth: 1, borderColor: "#f90",
  },
  tailscaleWarningText: { color: "#f90", fontSize: 14, lineHeight: 20 },
  tailscaleWarningLink: { textDecorationLine: "underline" },
  tailscaleOk: { marginBottom: 16 },
  tailscaleOkText: { color: "#4caf50", fontSize: 14 },
  scanButton: {
    backgroundColor: "#1e1e1e", borderRadius: 10, padding: 16,
    alignItems: "center", marginBottom: 12,
    borderWidth: 1, borderColor: "#333",
  },
  scanButtonText: { color: "#4f8ef7", fontSize: 16, fontWeight: "600" },
  orDivider: { color: "#444", textAlign: "center", marginBottom: 12, fontSize: 13 },
  card: { backgroundColor: "#1a1a1a", borderRadius: 12, padding: 16, marginBottom: 16 },
  label: { color: "#888", fontSize: 13, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 },
  input: {
    backgroundColor: "#222", color: "#fff", borderRadius: 8,
    padding: 14, marginBottom: 10, fontSize: 16,
  },
  button: { backgroundColor: "#4f8ef7", borderRadius: 8, padding: 16, alignItems: "center", marginTop: 4 },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  error: { color: "#f87", marginTop: 12, fontSize: 14, lineHeight: 20 },
  setupToggle: { alignItems: "center", marginBottom: 12 },
  setupToggleText: { color: "#555", fontSize: 14 },
});

const stepStyles = StyleSheet.create({
  container: { flexDirection: "row", marginBottom: 20 },
  number: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: "#4f8ef7",
    justifyContent: "center", alignItems: "center", marginRight: 12, marginTop: 2, flexShrink: 0,
  },
  numberText: { color: "#fff", fontWeight: "bold", fontSize: 14 },
  content: { flex: 1 },
  title: { color: "#fff", fontWeight: "600", fontSize: 15, marginBottom: 4 },
  description: { color: "#888", fontSize: 14, lineHeight: 20 },
  action: { color: "#4f8ef7", marginTop: 6, fontSize: 14 },
});
