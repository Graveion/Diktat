import { useState, useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { useDiktat, type DiktatSession } from "./src/hooks/useDiktat";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import { loadConfig } from "./src/store/config";

type Screen = "connect" | "sessions" | "chat";

export default function App() {
  const [screen, setScreen] = useState<Screen>("connect");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(9000);

  const diktat = useDiktat(host, port);

  useEffect(() => {
    loadConfig().then((c) => {
      if (c.host) { setHost(c.host); setPort(c.port); }
    });
  }, []);

  useEffect(() => {
    if (diktat.state === "connected") setScreen("sessions");
    if (diktat.state === "disconnected" || diktat.state === "error") setScreen("connect");
  }, [diktat.state]);

  useEffect(() => {
    if (diktat.activeSessionId) setScreen("chat");
  }, [diktat.activeSessionId]);

  const handleConnect = (h: string, p: number) => {
    setHost(h);
    setPort(p);
  };

  useEffect(() => {
    if (host) diktat.connect();
  }, [host]);

  const handleResume = (session: DiktatSession) => {
    diktat.resumeSession(session);
  };

  const handleNew = (cli: string, project: string) => {
    diktat.spawnSession(cli, project);
  };

  if (screen === "connect" || !host) {
    return (
      <>
        <StatusBar style="light" />
        <ConnectScreen
          onConnect={handleConnect}
          connectionState={diktat.state}
        />
      </>
    );
  }

  if (screen === "sessions") {
    return (
      <>
        <StatusBar style="light" />
        <SessionsScreen
          sessions={diktat.sessions}
          clis={diktat.clis}
          projects={diktat.projects}
          onResume={handleResume}
          onNew={handleNew}
          onDisconnect={() => { diktat.disconnect(); setScreen("connect"); }}
        />
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <ChatScreen
        messages={diktat.messages}
        streaming={diktat.streaming}
        onSend={diktat.sendMessage}
        onBack={() => setScreen("sessions")}
      />
    </>
  );
}
