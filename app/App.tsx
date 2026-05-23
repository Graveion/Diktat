import { useState, useEffect, useRef, useCallback, Component } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import {
  useFonts,
  Syne_700Bold,
  Syne_800ExtraBold,
} from "@expo-google-fonts/syne";
import {
  SpaceGrotesk_700Bold,
} from "@expo-google-fonts/space-grotesk";
import {
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
  Outfit_700Bold,
} from "@expo-google-fonts/outfit";
import * as Notifications from "expo-notifications";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useDiktat, type DiktatSession } from "./src/hooks/useDiktat";
import { useMockDiktat } from "./src/hooks/useMockDiktat";
import { usePushToken } from "./src/hooks/usePushToken";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import { DebugScreen } from "./src/screens/DebugScreen";
import { loadConfig } from "./src/store/config";
import { info } from "./src/utils/logger";

// ─── Mock mode ────────────────────────────────────────────────────────────────
// Only active in local dev builds (`npx expo start`). Never ships in OTA.
// The app starts "connected" with a single mock Pacer session so ChatScreen
// can be exercised without a running daemon.
const MOCK_MODE = __DEV__;

type Screen = "connect" | "sessions" | "chat" | "debug";

// ─── Crash boundary ──────────────────────────────────────────────────────────
const CRASH_KEY = "@diktat/last_crash";

class CrashBoundary extends Component<{ children: React.ReactNode }, { crashed: boolean; error: string }> {
  state = { crashed: false, error: "" };
  static getDerivedStateFromError(e: Error) {
    return { crashed: true, error: e?.message ?? String(e) };
  }
  componentDidCatch(e: Error) {
    const entry = `[CRASH ${new Date().toISOString()}] ${e?.message}\n${e?.stack ?? ""}`;
    AsyncStorage.setItem(CRASH_KEY, entry).catch(() => {});
  }
  render() {
    if (this.state.crashed) {
      return (
        <View style={{ flex: 1, backgroundColor: "#07060a", justifyContent: "center", alignItems: "center", padding: 32 }}>
          <Text style={{ color: "#f87171", fontSize: 18, fontWeight: "bold", marginBottom: 12 }}>Something crashed</Text>
          <Text style={{ color: "#8b85a1", fontSize: 12, fontFamily: "monospace" }}>{this.state.error}</Text>
          <TouchableOpacity onPress={() => this.setState({ crashed: false, error: "" })} style={{ marginTop: 24, padding: 14, backgroundColor: "#252130", borderRadius: 10 }}>
            <Text style={{ color: "#a78bfa" }}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

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

function AppWithRealDiktat() {
  const [host, setHost] = useState("");
  const [port, setPort] = useState(9000);
  const diktat = useDiktat(host, port);
  return <AppInner diktat={diktat} host={host} port={port} setHost={setHost} setPort={setPort} />;
}

function AppWithMockDiktat() {
  const diktat = useMockDiktat();
  // host must be non-empty so the !host guard in AppInner doesn't force ConnectScreen
  return <AppInner diktat={diktat} host="mock" port={9000} setHost={() => {}} setPort={() => {}} />;
}

function App() {
  return MOCK_MODE ? <AppWithMockDiktat /> : <AppWithRealDiktat />;
}

function AppInner({ diktat, host, port, setHost, setPort }: {
  diktat: ReturnType<typeof useDiktat>;
  host: string; port: number;
  setHost: (h: string) => void; setPort: (p: number) => void;
}) {
  const [fontsLoaded] = useFonts({
    Syne_700Bold, Syne_800ExtraBold,
    Outfit_400Regular, Outfit_500Medium, Outfit_600SemiBold, Outfit_700Bold,
    SpaceGrotesk_700Bold,
  });

  const [screen, setScreen] = useState<Screen>("connect");
  const [activeSession, setActiveSession] = useState<DiktatSession | null>(null);

  void port;
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

  // Eager OTA pull: check for a newer bundle on every cold launch and apply
  // it immediately. Default expo-updates behaviour downloads in the background
  // and applies on the NEXT launch, which makes "did the latest OTA reach my
  // phone?" annoyingly ambiguous. This trades ~1s of extra cold-start time
  // for "if there's an update, you're on it after this launch."
  useEffect(() => {
    if (__DEV__) return;
    (async () => {
      try {
        const check = await Updates.checkForUpdateAsync();
        if (!check.isAvailable) return;
        await Updates.fetchUpdateAsync();
        await Updates.reloadAsync();
      } catch (e) {
        info("UPDATE", `OTA check failed: ${(e as Error).message}`);
      }
    })();
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

  // Deep-link from push notification tap
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const sessionId = response.notification.request.content.data?.sessionId as string | undefined;
      if (!sessionId) return;
      const target = diktat.sessions.find((s) => s.id === sessionId);
      if (target) {
        info("NAV", `push tap → chat (session ${sessionId})`);
        setActiveSession(target);
        diktat.resumeSession(target);
        setScreen("chat");
      } else if (screen !== "chat") {
        setScreen("sessions");
      }
    });
    return () => sub.remove();
  }, [diktat.sessions, screen]);

  const handleResume = (session: DiktatSession) => {
    info("NAV", `sessions → chat (resume session ${session.id} source=${session.source})`);
    setActiveSession(session);
    diktat.resumeSession(session);
  };

  const handleNew = (cli: string, project: string, mode?: string) => {
    info("NAV", `sessions → chat (new session cli=${cli} project=${project}${mode ? ` mode=${mode}` : ""})`);
    setActiveSession(null);
    diktat.spawnSession(cli, project, mode);
  };

  const openDebug = useCallback(() => {
    info("NAV", `debug screen opened (from ${screen})`);
    prevScreen.current = screen;
    setScreen("debug");
  }, [screen]);

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: "#07060a", justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator color="#a78bfa" />
      </View>
    );
  }

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
          connectionState={diktat.state}
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
          historyLoading={diktat.historyLoading}
          activeSessionId={diktat.activeSessionId}
          onSend={diktat.sendMessage}
          onCancel={diktat.cancelMessage}
          onBack={() => { diktat.leaveSession(); setScreen("sessions"); }}
          sessionLabel={activeSession?.projectLabel ?? activeSession?.project?.split("/").pop()}
          sessionCli={activeSession?.cli ?? undefined}
        />
      )}
    </View>
  );
}

export default function AppWithBoundary() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <CrashBoundary><App /></CrashBoundary>
    </GestureHandlerRootView>
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
