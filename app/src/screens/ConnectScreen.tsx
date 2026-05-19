import { useState, useEffect } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { loadConfig, saveConfig } from "../store/config";

type Props = {
  onConnect: (host: string, port: number) => void;
  connectionState: string;
};

export function ConnectScreen({ onConnect, connectionState }: Props) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9000");

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
    <View style={styles.container}>
      <Text style={styles.title}>Diktat</Text>
      <Text style={styles.subtitle}>Connect to your daemon</Text>

      <TextInput
        style={styles.input}
        value={host}
        onChangeText={setHost}
        placeholder="Tailscale IP (100.x.x.x)"
        placeholderTextColor="#666"
        autoCapitalize="none"
        keyboardType="numeric"
      />
      <TextInput
        style={styles.input}
        value={port}
        onChangeText={setPort}
        placeholder="Port"
        placeholderTextColor="#666"
        keyboardType="numeric"
      />

      <TouchableOpacity
        style={[styles.button, connectionState === "connecting" && styles.buttonDisabled]}
        onPress={handleConnect}
        disabled={connectionState === "connecting" || !host}
      >
        {connectionState === "connecting" ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Connect</Text>
        )}
      </TouchableOpacity>

      {connectionState === "error" && (
        <Text style={styles.error}>Connection failed. Check the IP and that the daemon is running.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111", justifyContent: "center", padding: 24 },
  title: { fontSize: 32, fontWeight: "bold", color: "#fff", marginBottom: 8 },
  subtitle: { fontSize: 16, color: "#888", marginBottom: 32 },
  input: {
    backgroundColor: "#222", color: "#fff", borderRadius: 8,
    padding: 14, marginBottom: 12, fontSize: 16,
  },
  button: {
    backgroundColor: "#4f8ef7", borderRadius: 8,
    padding: 16, alignItems: "center", marginTop: 8,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  error: { color: "#f87", marginTop: 16, textAlign: "center" },
});
