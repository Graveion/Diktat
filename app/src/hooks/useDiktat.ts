import { useEffect, useRef, useState, useCallback } from "react";

export type DiktatSession = {
  id: string;
  cli: string;
  project: string;
  projectLabel?: string;
  firstMessage?: string;
  lastActiveAt: string;
  source: "daemon" | "claude";
};

export type DiktatMessage = {
  role: "user" | "assistant";
  text: string;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export function useDiktat(host: string, port: number) {
  const ws = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ConnectionState>("disconnected");
  const [clis, setClis] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [sessions, setSessions] = useState<DiktatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DiktatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);

  const connect = useCallback(() => {
    if (!host) return;
    setState("connecting");
    const socket = new WebSocket(`ws://${host}:${port}`);
    ws.current = socket;

    socket.onopen = () => setState("connecting");

    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === "connected") {
        setState("connected");
        setClis(msg.clis ?? []);
        setProjects(msg.projects ?? []);
        const daemonSessions = (msg.sessions ?? []).map((s: any) => ({ ...s, source: "daemon" }));
        const claudeSessions = (msg.claudeSessions ?? []).map((s: any) => ({ ...s, source: "claude", cli: "claude" }));
        setSessions([...daemonSessions, ...claudeSessions]);
      }

      if (msg.type === "spawned" || msg.type === "resumed") {
        setActiveSessionId(msg.session.id);
        setMessages([]);
        setStreaming(false);
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
        console.error("Daemon error:", msg.message);
      }
    };

    socket.onerror = () => setState("error");
    socket.onclose = () => setState("disconnected");
  }, [host, port]);

  const disconnect = useCallback(() => {
    ws.current?.close();
    setState("disconnected");
  }, []);

  const spawnSession = useCallback((cli: string, project: string) => {
    ws.current?.send(JSON.stringify({ type: "spawn", cli, project }));
  }, []);

  const resumeSession = useCallback((session: DiktatSession) => {
    ws.current?.send(JSON.stringify({
      type: "resume",
      sessionId: session.id,
      isClaudeSession: session.source === "claude",
      project: session.project,
    }));
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (!activeSessionId) return;
    setMessages((prev) => [...prev, { role: "user", text }]);
    ws.current?.send(JSON.stringify({ type: "input", sessionId: activeSessionId, text }));
    setStreaming(true);
  }, [activeSessionId]);

  useEffect(() => {
    return () => ws.current?.close();
  }, []);

  return {
    state, clis, projects, sessions, activeSessionId,
    messages, streaming, connect, disconnect,
    spawnSession, resumeSession, sendMessage,
  };
}
