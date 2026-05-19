import { useState, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Linking, ScrollView,
} from "react-native";
import { loadConfig, saveConfig } from "../store/config";

type Props = {
  onConnect: (host: string, port: number) => void;
  connectionState: string;
};

export function ConnectScreen({ onConnect, connectionState }: Props) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9000");
  const [showSetup, setShowSetup] = useState(false);

  useEffect(() => {
    loadConfig().then((c) => {
      if (c.host) setHost(c.host);
      setPort(String(c.port));
    });
  }, []);

  const handleConnect = async () => {
    await saveConfig({ host, port: parseInt(port) });
    onConnect(host, parseInt(port));
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Diktat</Text>
      <Text style={styles.subtitle}>Voice-driven coding assistant</Text>

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
            Connection failed. Make sure Tailscale is running and the daemon is started.
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
            title="Run the daemon on your laptop"
            description="In the Diktat repo, run ./daemon.sh start. It will print the Tailscale IP to use above."
          />
          <SetupStep
            number="4"
            title="Enter the IP above and connect"
            description="The daemon prints its address when it starts, e.g. 100.x.x.x:9000."
          />
        </View>
      )}
    </ScrollView>
  );
}

function SetupStep({
  number, title, description, action, onAction,
}: {
  number: string;
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
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
  subtitle: { fontSize: 16, color: "#666", marginBottom: 32 },
  card: {
    backgroundColor: "#1a1a1a", borderRadius: 12,
    padding: 16, marginBottom: 16,
  },
  label: { color: "#888", fontSize: 13, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 },
  input: {
    backgroundColor: "#222", color: "#fff", borderRadius: 8,
    padding: 14, marginBottom: 10, fontSize: 16,
  },
  button: {
    backgroundColor: "#4f8ef7", borderRadius: 8,
    padding: 16, alignItems: "center", marginTop: 4,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  error: { color: "#f87", marginTop: 12, fontSize: 14, lineHeight: 20 },
  setupToggle: { alignItems: "center", marginBottom: 12 },
  setupToggleText: { color: "#555", fontSize: 14 },
});

const stepStyles = StyleSheet.create({
  container: { flexDirection: "row", marginBottom: 20 },
  number: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: "#4f8ef7", justifyContent: "center",
    alignItems: "center", marginRight: 12, marginTop: 2, flexShrink: 0,
  },
  numberText: { color: "#fff", fontWeight: "bold", fontSize: 14 },
  content: { flex: 1 },
  title: { color: "#fff", fontWeight: "600", fontSize: 15, marginBottom: 4 },
  description: { color: "#888", fontSize: 14, lineHeight: 20 },
  action: { color: "#4f8ef7", marginTop: 6, fontSize: 14 },
});
