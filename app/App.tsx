import { useState, useEffect, useRef, useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useDiktat, type DiktatSession } from "./src/hooks/useDiktat";
import { usePushToken } from "./src/hooks/usePushToken";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import { DebugScreen } from "./src/screens/DebugScreen";
import { loadConfig } from "./src/store/config";
import { info } from "./src/utils/logger";

type Screen = "connect" | "sessions" | "chat" | "debug";

export const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";

// Shows which OTA update is running: "dev" in Expo Go, a short hash in production
export const UPDATE_LABEL: string = (() => {
  if (__DEV__) return "dev";
  const id = Updates.updateId;         // UUID of the currently-running OTA update
  const at = Updates.createdAt;        // Date it was published
  if (!id) return "embedded";
  const short = id.slice(0, 8);
  const time = at ? at.toISOString().slice(0, 16).replace("T", " ") : "";
  return `${short}${time ? " · " + time : ""}`;
})();

export default function App() {
  const [screen, setScreen] = useState<Screen>("connect");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(9000);
  const [activeSession, setActiveSession] = useState<DiktatSession | null>(null);

  const diktat = useDiktat(host, port);
  const pushToken = usePushToken();
  const prevScreen = useRef<Screen>("connect");

  useEffect(() => {
    if (pushToken) diktat.registerPushToken(pushToken);
  }, [pushToken]);

  useEffect(() => {
    loadConfig().then((c) => {
      if (c.host) { setHost(c.host); setPort(c.port); }
    });
  }, []);

  useEffect(() => {
    // Only advance to sessions from the connect screen — never override chat
    if (diktat.state === "connected" && screen === "connect") {
      info("NAV", "connect → sessions (daemon connected)");
      setScreen("sessions");
    }
    if (diktat.state === "disconnected" || diktat.state === "error") {
      if (screen !== "chat" && screen !== "sessions" && screen !== "debug") {
        info("NAV", `${screen} → connect (state=${diktat.state})`);
        setScreen("connect");
      }
    }
  }, [diktat.state, screen]);

  useEffect(() => {
    if (diktat.activeSessionId) setScreen("chat");
    // If session was invalidated (e.g. daemon restarted) while in chat, go back to sessions
    if (!diktat.activeSessionId && screen === "chat") setScreen("sessions");
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
    info("NAV", `sessions → chat (resume session ${session.id} source=${session.source})`);
    setActiveSession(session);
    diktat.resumeSession(session);
  };

  const handleNew = (cli: string, project: string) => {
    info("NAV", `sessions → chat (new session cli=${cli} project=${project})`);
    setActiveSession(null);
    diktat.spawnSession(cli, project);
  };

  const openDebug = useCallback(() => {
    info("NAV", `debug screen opened (from ${screen})`);
    prevScreen.current = screen;
    setScreen("debug");
  }, [screen]);

  return (
    // onStartShouldSetResponderCapture runs top-down (capture phase) before any
    // child component can steal the touch — reliable for a global 3-finger shortcut
    <View
      style={styles.root}
      onStartShouldSetResponderCapture={(e) => e.nativeEvent.touches.length >= 3}
      onResponderGrant={(e) => { if (e.nativeEvent.touches.length >= 3) openDebug(); }}
    >
      <StatusBar style="light" />
      {diktat.errorMessage ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{diktat.errorMessage}</Text>
          <TouchableOpacity onPress={diktat.clearError}>
            <Text style={styles.errorDismiss}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {screen === "debug" ? (
        <DebugScreen onBack={() => setScreen(prevScreen.current === "debug" ? (host ? "sessions" : "connect") : prevScreen.current)} />
      ) : screen === "connect" || !host ? (
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
          loading={diktat.state === "connecting"}
          onResume={handleResume}
          onNew={handleNew}
          onDisconnect={() => { diktat.disconnect(); setScreen("connect"); }}
        />
      ) : (
        <ChatScreen
          messages={diktat.messages}
          streaming={diktat.streaming}
          currentTool={diktat.currentTool}
          reconnecting={diktat.reconnecting}
          activeSessionId={diktat.activeSessionId}
          onSend={diktat.sendMessage}
          onCancel={diktat.cancelMessage}
          onBack={() => { diktat.leaveSession(); setScreen("sessions"); }}
          sessionLabel={activeSession?.projectLabel ?? activeSession?.project?.split("/").pop()}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  errorBanner: {
    backgroundColor: "#5a1a1a", paddingTop: 56, paddingBottom: 12,
    paddingHorizontal: 16, flexDirection: "row", alignItems: "center",
  },
  errorText: { flex: 1, color: "#ffaaaa", fontSize: 14, lineHeight: 20 },
  errorDismiss: { color: "#ff8888", fontSize: 18, paddingLeft: 12 },
});
