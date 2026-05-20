import { useState, useEffect } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useDiktat, type DiktatSession } from "./src/hooks/useDiktat";
import { usePushToken } from "./src/hooks/usePushToken";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import { loadConfig } from "./src/store/config";

type Screen = "connect" | "sessions" | "chat";

export default function App() {
  const [screen, setScreen] = useState<Screen>("connect");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(9000);
  const [activeSession, setActiveSession] = useState<DiktatSession | null>(null);

  const diktat = useDiktat(host, port);
  const pushToken = usePushToken();

  useEffect(() => {
    if (pushToken) diktat.registerPushToken(pushToken);
  }, [pushToken]);

  useEffect(() => {
    loadConfig().then((c) => {
      if (c.host) { setHost(c.host); setPort(c.port); }
    });
  }, []);

  useEffect(() => {
    if (diktat.state === "connected") setScreen("sessions");
    if (diktat.state === "disconnected" || diktat.state === "error") {
      // Only drop back to connect if we're not in a session
      if (screen !== "chat" && screen !== "sessions") setScreen("connect");
    }
  }, [diktat.state]);

  useEffect(() => {
    if (diktat.activeSessionId) setScreen("chat");
  }, [diktat.activeSessionId]);

  const handleConnect = (h: string, p: number) => {
    setHost(h);
    setPort(p);
    diktat.connect(h, p);
  };

  useEffect(() => {
    if (host) diktat.connect(host, port);
  }, []);

  const handleResume = (session: DiktatSession) => {
    setActiveSession(session);
    diktat.resumeSession(session);
  };

  const handleNew = (cli: string, project: string) => {
    setActiveSession(null);
    diktat.spawnSession(cli, project);
  };

  return (
    <>
      <StatusBar style="light" />
      {diktat.errorMessage ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{diktat.errorMessage}</Text>
          <TouchableOpacity onPress={diktat.clearError}>
            <Text style={styles.errorDismiss}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {screen === "connect" || !host ? (
        <ConnectScreen
          onConnect={handleConnect}
          connectionState={diktat.state}
        />
      ) : screen === "sessions" ? (
        <SessionsScreen
          sessions={diktat.sessions}
          clis={diktat.clis}
          projects={diktat.projects}
          connectedHost={host}
          onResume={handleResume}
          onNew={handleNew}
          onDisconnect={() => { diktat.disconnect(); setScreen("connect"); }}
        />
      ) : (
        <ChatScreen
          messages={diktat.messages}
          streaming={diktat.streaming}
          reconnecting={diktat.reconnecting}
          activeSessionId={diktat.activeSessionId}
          onSend={diktat.sendMessage}
          onCancel={diktat.cancelMessage}
          onBack={() => { diktat.leaveSession(); setScreen("sessions"); }}
          sessionLabel={activeSession?.projectLabel ?? activeSession?.project?.split("/").pop()}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  errorBanner: {
    position: "absolute", top: 0, left: 0, right: 0, zIndex: 100,
    backgroundColor: "#5a1a1a", paddingTop: 52, paddingBottom: 12,
    paddingHorizontal: 16, flexDirection: "row", alignItems: "center",
  },
  errorText: { flex: 1, color: "#ffaaaa", fontSize: 14, lineHeight: 20 },
  errorDismiss: { color: "#ff8888", fontSize: 18, paddingLeft: 12 },
});
