import { useEffect, useRef, useState, useCallback } from "react";
import { info, warn, error as logError } from "../utils/logger";

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
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 30000;

export function useDiktat(host: string, port: number) {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(RECONNECT_DELAY_MS);
  const intentionalDisconnect = useRef(false);
  const discardOutput = useRef(false);
  const lastHost = useRef(host);
  const lastPort = useRef(port);
  const pushTokenRef = useRef<string | null>(null);

  const [state, setState] = useState<ConnectionState>("disconnected");
  const [reconnecting, setReconnecting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [clis, setClis] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [sessions, setSessions] = useState<DiktatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DiktatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [currentTool, setCurrentTool] = useState<string | null>(null);

  const connect = useCallback((overrideHost?: string, overridePort?: number) => {
    const h = overrideHost ?? lastHost.current;
    const p = overridePort ?? lastPort.current;
    if (!h) { warn("WS", "connect() called with no host — skipping"); return; }
    if (overrideHost) lastHost.current = overrideHost;
    if (overridePort) lastPort.current = overridePort;

    intentionalDisconnect.current = false;
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }

    ws.current?.close();
    ws.current = null;
    setState("connecting");
    setErrorMessage(null);
    info("WS", `Connecting to ws://${h}:${p}`);
    const socket = new WebSocket(`ws://${h}:${p}`);
    ws.current = socket;

    socket.onopen = () => {
      if (ws.current !== socket) { info("WS", "onopen: stale socket — ignoring"); return; }
      reconnectDelay.current = RECONNECT_DELAY_MS;
      setReconnecting(false);
      setState("connected");
      info("WS", `Connected to ws://${h}:${p}`);
      if (pushTokenRef.current) {
        socket.send(JSON.stringify({ type: "register_push", token: pushTokenRef.current }));
        info("PUSH", "Registered push token with daemon");
      }
    };

    socket.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch (err) {
        logError("MSG", `Failed to parse message: ${e.data?.slice?.(0, 100)}`);
        return;
      }

      if (msg.type === "connected") {
        setState("connected");
        setClis(msg.clis ?? []);
        setProjects(msg.projects ?? []);
        const daemonSessions: any[] = (msg.sessions ?? []).map((s: any) => ({ ...s, source: "daemon" }));
        const claudeSessions: any[] = (msg.claudeSessions ?? []).map((s: any) => ({ ...s, source: "claude", cli: "claude" }));
        const cursorSessions: any[] = (msg.cursorSessions ?? []).map((s: any) => ({ ...s, source: "cursor", cli: "cursor" }));
        const nativeIds = new Set([...claudeSessions, ...cursorSessions].map((s) => s.id));
        const filteredDaemon = daemonSessions.filter((s) => !s.cliSessionId || !nativeIds.has(s.cliSessionId));
        const all = [...claudeSessions, ...cursorSessions, ...filteredDaemon];
        setSessions(all);
        info("MSG", `connected: clis=[${(msg.clis ?? []).join(",")}] sessions=${all.length} (claude=${claudeSessions.length} cursor=${cursorSessions.length} daemon=${filteredDaemon.length})`);
        return;
      }

      if (msg.type === "spawned" || msg.type === "resumed") {
        discardOutput.current = false;
        setActiveSessionId(msg.session.id);
        setMessages([]);
        setStreaming(false);
        info("SESSION", `${msg.type}: sessionId=${msg.session.id} cli=${msg.session.cli} project=${msg.session.project}`);
        return;
      }

      if (msg.type === "history") {
        const msgs = msg.messages ?? [];
        setMessages(msgs);
        info("SESSION", `history: ${msgs.length} messages loaded`);
        return;
      }

      if (msg.type === "tool_use") {
        if (!discardOutput.current) setCurrentTool(msg.name ?? null);
        info("MSG", `tool_use: ${msg.name}`);
        return;
      }

      if (msg.type === "output") {
        if (discardOutput.current) {
          info("MSG", "output: discarded (stale session)");
          return;
        }
        setCurrentTool(null);
        setStreaming(true);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { role: "assistant", text: last.text + msg.text }];
          }
          return [...prev, { role: "assistant", text: msg.text }];
        });
        return;
      }

      if (msg.type === "exit") {
        setStreaming(false);
        setCurrentTool(null);
        info("SESSION", `exit: code=${msg.code}`);
        return;
      }

      if (msg.type === "error") {
        logError("MSG", `daemon error: ${msg.message}`);
        setErrorMessage(msg.message ?? "An error occurred");
        if (msg.message?.includes("No active session")) {
          warn("SESSION", "Active session invalidated (daemon may have restarted)");
          setActiveSessionId(null);
          setStreaming(false);
          setCurrentTool(null);
        }
        return;
      }

      info("MSG", `unhandled message type: ${msg.type}`);
    };

    socket.onerror = (e) => {
      if (ws.current !== socket) return;
      logError("WS", `WebSocket error on ws://${h}:${p}`);
      setState("error");
      setErrorMessage("Could not reach daemon. Check Tailscale is running.");
    };

    socket.onclose = (e) => {
      if (ws.current !== socket) { info("WS", "onclose: stale socket — ignoring"); return; }
      info("WS", `Disconnected (code=${e.code} reason="${e.reason}" wasClean=${e.wasClean} intentional=${intentionalDisconnect.current})`);
      setState("disconnected");
      if (intentionalDisconnect.current) {
        setReconnecting(false);
        return;
      }
      setReconnecting(true);
      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
      info("WS", `Scheduling reconnect in ${delay}ms`);
      reconnectTimer.current = setTimeout(() => connect(), delay);
    };
  }, []);

  const disconnect = useCallback(() => {
    info("WS", "disconnect() called intentionally");
    intentionalDisconnect.current = true;
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    ws.current?.close();
    setState("disconnected");
    setReconnecting(false);
    setErrorMessage(null);
  }, []);

  const leaveSession = useCallback(() => {
    info("SESSION", "leaveSession() — discarding further output from current session");
    discardOutput.current = true;
    setActiveSessionId(null);
    setMessages([]);
    setStreaming(false);
    setCurrentTool(null);
  }, []);

  const cancelMessage = useCallback((sessionId: string) => {
    info("SESSION", `cancel: sessionId=${sessionId}`);
    ws.current?.send(JSON.stringify({ type: "cancel", sessionId }));
    setStreaming(false);
  }, []);

  const spawnSession = useCallback((cli: string, project: string) => {
    info("SESSION", `spawn: cli=${cli} project=${project}`);
    ws.current?.send(JSON.stringify({ type: "spawn", cli, project }));
  }, []);

  const resumeSession = useCallback((session: DiktatSession) => {
    info("SESSION", `resume: id=${session.id} source=${session.source} cli=${session.cli} project=${session.project}`);
    ws.current?.send(JSON.stringify({
      type: "resume",
      sessionId: session.id,
      isClaudeSession: session.source === "claude",
      isCursorSession: session.source === "cursor",
      project: session.project,
    }));
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (!activeSessionId) { warn("SESSION", "sendMessage called with no activeSessionId"); return; }
    info("SESSION", `input: sessionId=${activeSessionId} text="${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
    setMessages((prev) => [...prev, { role: "user", text }]);
    ws.current?.send(JSON.stringify({ type: "input", sessionId: activeSessionId, text }));
    setStreaming(true);
  }, [activeSessionId]);

  const registerPushToken = useCallback((token: string) => {
    pushTokenRef.current = token;
    info("PUSH", `Push token registered: ${token.slice(0, 30)}…`);
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: "register_push", token }));
    }
  }, []);

  const clearError = useCallback(() => setErrorMessage(null), []);

  useEffect(() => {
    return () => {
      intentionalDisconnect.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws.current?.close();
    };
  }, []);

  return {
    state, reconnecting, errorMessage, clis, projects, sessions, activeSessionId,
    messages, streaming, currentTool, connect, disconnect,
    spawnSession, resumeSession, sendMessage, leaveSession, cancelMessage,
    registerPushToken, clearError,
  };
}
