import { useState, useEffect, useRef, useCallback, Component } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useFonts,
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
import { useDiktat, type DiktatSession, type RelayDescriptor } from "./src/hooks/useDiktat";
import { useMockDiktat } from "./src/hooks/useMockDiktat";
import { usePushToken } from "./src/hooks/usePushToken";
import { useAuth, type AuthApi } from "./src/hooks/useAuth";
import { useMachines, type Machine } from "./src/hooks/useMachines";
import { useEntitlements } from "./src/hooks/useEntitlements";
import { Banner } from "./src/components/Banner";
import { SignInScreen } from "./src/screens/SignInScreen";
import { MachinesScreen } from "./src/screens/MachinesScreen";
import { PaywallScreen } from "./src/screens/PaywallScreen";
import { RELAY_URL } from "./src/store/supabase";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import { DebugScreen } from "./src/screens/DebugScreen";
import { info } from "./src/utils/logger";
import { saveCrash } from "./src/utils/crash";
import { track } from "./src/utils/analytics";

// ─── Mock mode ────────────────────────────────────────────────────────────────
// Only active in local dev builds (`npx expo start`). Never ships in OTA.
// The app starts "connected" with a single fabricated demo session so ChatScreen
// can be exercised without a running daemon.
const MOCK_MODE = __DEV__;

type Screen = "machines" | "sessions" | "chat" | "debug";

// ─── Crash boundary ──────────────────────────────────────────────────────────
class CrashBoundary extends Component<{ children: React.ReactNode }, { crashed: boolean; error: string }> {
  state = { crashed: false, error: "" };
  static getDerivedStateFromError(e: Error) {
    return { crashed: true, error: e?.message ?? String(e) };
  }
  componentDidCatch(e: Error) {
    // Persisted locally; surfaced to us when the user submits feedback (the
    // "include diagnostics" toggle attaches this). No remote vendor needed.
    saveCrash(`[CRASH ${new Date().toISOString()}] ${e?.message}\n${e?.stack ?? ""}`);
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

function AppWithRealDiktat({ auth, onTryDemo }: { auth: AuthApi; onTryDemo: () => void }) {
  const [relay, setRelay] = useState<RelayDescriptor | undefined>(undefined);
  const diktat = useDiktat(relay);

  // Connect once a relay descriptor is set (relayRef updates this render, so
  // connect() then dials the relay leg). Disconnect when it clears.
  useEffect(() => {
    if (relay) diktat.connect();
  }, [relay]);

  const connectToMachine = useCallback(
    (m: Machine) => {
      const token = auth.session?.access_token ?? "";
      setRelay({ relayUrl: RELAY_URL, machineId: m.id, accountToken: token });
    },
    [auth.session],
  );

  const leaveMachine = useCallback(() => {
    diktat.disconnect();
    setRelay(undefined);
  }, [diktat]);

  return (
    <AppInner diktat={diktat} auth={auth} connectToMachine={connectToMachine} leaveMachine={leaveMachine} onTryDemo={onTryDemo} />
  );
}

function AppWithMockDiktat({ auth, onExitDemo }: { auth: AuthApi; onExitDemo?: () => void }) {
  const diktat = useMockDiktat();
  // Demo / dev mock: already "connected", starts directly on sessions screen.
  return (
    <AppInner diktat={diktat} auth={auth} connectToMachine={() => {}} leaveMachine={() => {}} demoMode onExitDemo={onExitDemo} />
  );
}

function Splash() {
  return (
    <View style={{ flex: 1, backgroundColor: "#07060a", justifyContent: "center", alignItems: "center" }}>
      <ActivityIndicator color="#a78bfa" />
    </View>
  );
}

// Eager OTA pull: check for a newer bundle on every cold launch and apply it
// immediately. Default expo-updates behaviour downloads in the background and
// applies on the NEXT launch, which makes "did the latest OTA reach my phone?"
// annoyingly ambiguous. Lives at the root (not behind sign-in) so signed-out
// users receive updates too.
function useEagerOtaUpdate() {
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
}

function App() {
  // Fonts + auth are resolved here so the sign-in gate and the app both render
  // with the loaded fonts. Login is required for the whole app (local + relay).
  const [fontsLoaded] = useFonts({
    Outfit_400Regular, Outfit_500Medium, Outfit_600SemiBold, Outfit_700Bold,
    SpaceGrotesk_700Bold,
  });
  const auth = useAuth();
  const [demoMode, setDemoMode] = useState(false);
  useEagerOtaUpdate();

  if (!fontsLoaded || auth.loading) return <Splash />;

  if (!auth.session) {
    return (
      <>
        <StatusBar style="light" />
        <SignInScreen
          appleAvailable={auth.appleAvailable}
          error={auth.error}
          onApple={auth.signInWithApple}
          onGoogle={auth.signInWithGoogle}
        />
      </>
    );
  }

  if (MOCK_MODE || demoMode) {
    return <AppWithMockDiktat auth={auth} onExitDemo={demoMode ? () => setDemoMode(false) : undefined} />;
  }
  return <AppWithRealDiktat auth={auth} onTryDemo={() => setDemoMode(true)} />;
}

function AppInner({ diktat, auth, connectToMachine, leaveMachine, demoMode = false, onTryDemo, onExitDemo }: {
  diktat: ReturnType<typeof useDiktat> | ReturnType<typeof useMockDiktat>;
  auth: AuthApi;
  connectToMachine: (m: Machine) => void;
  leaveMachine: () => void;
  demoMode?: boolean;
  onTryDemo?: () => void;
  onExitDemo?: () => void;
}) {
  const [screen, setScreen] = useState<Screen>(demoMode ? "sessions" : "machines");
  const [activeSession, setActiveSession] = useState<DiktatSession | null>(null);
  const [selectedMachine, setSelectedMachine] = useState<Machine | null>(null);
  const [paywallVisible, setPaywallVisible] = useState(false);
  useEffect(() => { if (paywallVisible) track("paywall_shown"); }, [paywallVisible]);

  const machines = useMachines();
  const ent = useEntitlements();
  const pushToken = usePushToken();
  const insets = useSafeAreaInsets();
  const prevScreen = useRef<Screen>("machines");

  useEffect(() => {
    if (pushToken) diktat.registerPushToken(pushToken);
  }, [pushToken]);

  const handleSelectMachine = useCallback(async (m: Machine) => {
    // Gate BEFORE connecting. The relay refuses the client leg for an expired
    // trial by rejecting the WS upgrade, which the app can't distinguish from a
    // network drop — so it would silently loop and never reach a screen with
    // the paywall. Checking here surfaces the paywall (and its redeem field).
    if (!demoMode && !(await ent.gateAccess())) {
      setPaywallVisible(true);
      return;
    }
    info("NAV", `machines → connecting (machine ${m.id})`);
    setSelectedMachine(m);
    connectToMachine(m);
  }, [connectToMachine, demoMode, ent]);

  useEffect(() => {
    // Advance to sessions once the selected machine's relay leg is connected.
    if (diktat.state === "connected" && selectedMachine && screen === "machines") {
      info("NAV", "machines → sessions (machine connected)");
      setScreen("sessions");
    }
  }, [diktat.state, screen, selectedMachine]);

  useEffect(() => {
    if (diktat.activeSessionId) setScreen("chat");
    // If session was invalidated (e.g. daemon restarted) while in chat, go back to sessions
    if (!diktat.activeSessionId && screen === "chat") setScreen("sessions");
  }, [diktat.activeSessionId]);

  // Deep-link from push notification tap. Guards: demo mode ignores pushes
  // entirely (they'd navigate the mock), and "session not found" only falls
  // back to the sessions list when a machine is actually connected — the push
  // may be for a different machine, and a fresh cold start has none connected.
  const handlePushResponse = useCallback((response: Notifications.NotificationResponse) => {
    if (demoMode) return;
    const sessionId = response.notification.request.content.data?.sessionId as string | undefined;
    if (!sessionId) return;
    const target = diktat.sessions.find((s) => s.id === sessionId);
    if (target) {
      // Same entitlement gate as a manual resume — pushes shouldn't bypass it.
      ent.gateAccess().then((ok) => {
        if (!ok) { setPaywallVisible(true); return; }
        info("NAV", `push tap → chat (session ${sessionId})`);
        setActiveSession(target);
        diktat.resumeSession(target);
        setScreen("chat");
      });
    } else if (screen !== "chat" && selectedMachine) {
      setScreen("sessions");
    }
  }, [demoMode, diktat.sessions, screen, selectedMachine, ent]);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(handlePushResponse);
    return () => sub.remove();
  }, [handlePushResponse]);

  // Cold-start tap: when the app is *launched by* a push, the listener above
  // mounts too late to see it. Replay the launch response once.
  const coldStartPushHandled = useRef(false);
  useEffect(() => {
    if (coldStartPushHandled.current) return;
    coldStartPushHandled.current = true;
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) handlePushResponse(response);
    }).catch(() => {});
  }, [handlePushResponse]);

  const handleResume = async (session: DiktatSession) => {
    if (!(await ent.gateAccess())) { setPaywallVisible(true); return; }
    info("NAV", `sessions → chat (resume session ${session.id} source=${session.source})`);
    setActiveSession(session);
    diktat.resumeSession(session);
  };

  const handleNew = async (cli: string, project: string, model?: string, permissionMode?: "plan" | "auto" | "full") => {
    if (!(await ent.gateAccess())) { setPaywallVisible(true); return; }
    info("NAV", `sessions → chat (new session cli=${cli} project=${project}${model ? ` model=${model}` : ""}${permissionMode ? ` perm=${permissionMode}` : ""})`);
    setActiveSession(null);
    diktat.spawnSession(cli, project, model, permissionMode);
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
        <Banner
          variant="error"
          text={diktat.errorMessage}
          actionLabel="Dismiss"
          onAction={diktat.clearError}
          topInset={insets.top}
        />
      ) : null}

      {demoMode ? (
        <Banner
          variant="success"
          text="Demo mode — no Mac required"
          actionLabel={onExitDemo ? "Exit" : undefined}
          onAction={onExitDemo}
          topInset={diktat.errorMessage ? 0 : insets.top}
          testID="demo-banner"
        />
      ) : null}

      {!demoMode && ent.ready && !ent.isPro && !ent.compActive && ent.freeSecondsRemaining > 0 && ent.freeSecondsRemaining < 3600 ? (
        <Banner
          variant="accent"
          text={`Free trial · ${Math.ceil(ent.freeSecondsRemaining / 60)} min left — tap to upgrade`}
          onPress={() => setPaywallVisible(true)}
          topInset={diktat.errorMessage ? 0 : insets.top}
        />
      ) : null}

      {screen === "debug" ? (
        <DebugScreen onBack={() => setScreen(prevScreen.current === "debug" ? (selectedMachine ? "sessions" : "machines") : prevScreen.current)} />
      ) : screen === "machines" ? (
        <MachinesScreen
          machines={machines.machines}
          loading={machines.loading}
          error={machines.error}
          onRefresh={machines.refresh}
          onSelect={handleSelectMachine}
          onClaim={machines.claimQrPairing}
          onUnpair={machines.unpair}
          onSignOut={auth.signOut}
          onDeleteAccount={auth.deleteAccount}
          onTryDemo={onTryDemo}
        />
      ) : screen === "sessions" ? (
        <SessionsScreen
          sessions={diktat.sessions}
          clis={diktat.clis}
          agents={diktat.agents}
          projects={diktat.projects}
          connectedHost={selectedMachine?.name ?? ""}
          connectionState={diktat.state}
          loading={diktat.state === "connecting"}
          onResume={handleResume}
          onNew={handleNew}
          onDisconnect={() => { leaveMachine(); setSelectedMachine(null); setScreen("machines"); }}
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
          onRetryConnect={diktat.connect}
          sessionLabel={activeSession?.projectLabel ?? activeSession?.project?.split("/").pop()}
          sessionCli={activeSession?.cli ?? undefined}
          agents={diktat.agents}
        />
      )}

      {paywallVisible ? (
        <View style={styles.paywallOverlay}>
          <PaywallScreen
            packages={ent.packages}
            onPurchase={ent.purchase}
            onRestore={ent.restore}
            onRedeem={ent.redeemCode}
            onClose={() => setPaywallVisible(false)}
            onUnlocked={() => { track("paywall_converted"); setPaywallVisible(false); }}
          />
        </View>
      ) : null}
    </View>
  );
}

export default function AppWithBoundary() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <CrashBoundary><App /></CrashBoundary>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  paywallOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 10 },
});
