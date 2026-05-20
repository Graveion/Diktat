import { useEffect, useRef, useState, useCallback } from "react";

export type DiktatSession = {
  id: string;
  cli: string;
  project: string;
  projectLabel?: string;
  firstMessage?: string;
  lastActiveAt: string;
  source: "daemon" | "claude" | "cursor";
};

export type DiktatMessage = {
  role: "user" | "assistant";
  text: string;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 30000;

export function useDiktat(host: string, port: number) {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(RECONNECT_DELAY_MS);
  const intentionalDisconnect = useRef(false);
  const lastHost = useRef(host);
  const lastPort = useRef(port);

  const [state, setState] = useState<ConnectionState>("disconnected");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [clis, setClis] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [sessions, setSessions] = useState<DiktatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DiktatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);

  const connect = useCallback((overrideHost?: string, overridePort?: number) => {
    const h = overrideHost ?? lastHost.current;
    const p = overridePort ?? lastPort.current;
    if (!h) return;
    if (overrideHost) lastHost.current = overrideHost;
    if (overridePort) lastPort.current = overridePort;

    intentionalDisconnect.current = false;
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }

    ws.current?.close();
    ws.current = null;
    setState("connecting");
    setErrorMessage(null);
    const socket = new WebSocket(`ws://${h}:${p}`);
    ws.current = socket;

    socket.onopen = () => {
      if (ws.current !== socket) return;
      reconnectDelay.current = RECONNECT_DELAY_MS;
      setState("connected");
    };

    socket.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === "connected") {
        setState("connected");
        setClis(msg.clis ?? []);
        setProjects(msg.projects ?? []);
        const daemonSessions: any[] = (msg.sessions ?? []).map((s: any) => ({ ...s, source: "daemon" }));
        const claudeSessions: any[] = (msg.claudeSessions ?? []).map((s: any) => ({ ...s, source: "claude", cli: "claude" }));
        const cursorSessions: any[] = (msg.cursorSessions ?? []).map((s: any) => ({ ...s, source: "cursor", cli: "cursor" }));
        const nativeIds = new Set([...claudeSessions, ...cursorSessions].map((s) => s.id));
        const filteredDaemon = daemonSessions.filter((s) => !s.cliSessionId || !nativeIds.has(s.cliSessionId));
        setSessions([...claudeSessions, ...cursorSessions, ...filteredDaemon]);
      }

      if (msg.type === "spawned" || msg.type === "resumed") {
        setActiveSessionId(msg.session.id);
        setMessages([]);
        setStreaming(false);
      }

      if (msg.type === "history") {
        setMessages(msg.messages ?? []);
      }

      if (msg.type === "output") {
        setStreaming(true);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { role: "assistant", text: last.text + msg.text }];
          }
          return [...prev, { role: "assistant", text: msg.text }];
        });
      }

      if (msg.type === "exit") {
        setStreaming(false);
      }

      if (msg.type === "error") {
        setErrorMessage(msg.message ?? "An error occurred");
      }
    };

    socket.onerror = () => {
      if (ws.current !== socket) return;
      setState("error");
      setErrorMessage("Could not reach daemon. Check Tailscale is running.");
    };

    socket.onclose = () => {
      if (ws.current !== socket) return;
      if (intentionalDisconnect.current) {
        setState("disconnected");
        return;
      }
      setState("disconnected");
      // Auto-reconnect with backoff
      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
      reconnectTimer.current = setTimeout(() => connect(), delay);
    };
  }, []);

  const disconnect = useCallback(() => {
    intentionalDisconnect.current = true;
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    ws.current?.close();
    setState("disconnected");
    setErrorMessage(null);
  }, []);

  const spawnSession = useCallback((cli: string, project: string) => {
    ws.current?.send(JSON.stringify({ type: "spawn", cli, project }));
  }, []);

  const resumeSession = useCallback((session: DiktatSession) => {
    ws.current?.send(JSON.stringify({
      type: "resume",
      sessionId: session.id,
      isClaudeSession: session.source === "claude",
      isCursorSession: session.source === "cursor",
      project: session.project,
    }));
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (!activeSessionId) return;
    setMessages((prev) => [...prev, { role: "user", text }]);
    ws.current?.send(JSON.stringify({ type: "input", sessionId: activeSessionId, text }));
    setStreaming(true);
  }, [activeSessionId]);

  const clearError = useCallback(() => setErrorMessage(null), []);

  useEffect(() => {
    return () => {
      intentionalDisconnect.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws.current?.close();
    };
  }, []);

  return {
    state, errorMessage, clis, projects, sessions, activeSessionId,
    messages, streaming, connect, disconnect,
    spawnSession, resumeSession, sendMessage, clearError,
  };
}
