/**
 * Drop-in replacement for useDiktat that never opens a WebSocket.
 * Starts already "connected", exposes one mock session, and loads
 * MOCK_MESSAGES when that session is resumed.
 *
 * Swap in by setting MOCK_MODE = true in App.tsx.
 */
import { useState, useCallback, useRef } from "react";
import type { DiktatSession, DiktatMessage } from "./useDiktat";
import { MOCK_MESSAGES } from "../utils/mockMessages";

const MOCK_SESSION: DiktatSession = {
  id: "mock-session-001",
  cli: "cursor",
  project: "/Users/timothy.green/personal/Pacer",
  projectLabel: "Pacer",
  firstMessage: "Are there any other candidates for the refactor",
  lastActiveAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(), // 12 min ago
  source: "cursor",
};

export function useMockDiktat(_host?: string, _port?: number) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DiktatMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const resumeSession = useCallback((session: DiktatSession) => {
    setHistoryLoading(true);
    setActiveSessionId(session.id);
    // Simulate a short history-load delay, just like the real hook
    setTimeout(() => {
      setMessages(MOCK_MESSAGES);
      setHistoryLoading(false);
    }, 400);
  }, []);

  const leaveSession = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
    setHistoryLoading(false);
  }, []);

  return {
    state: "connected" as const,
    reconnecting: false,
    errorMessage: null,
    clis: ["cursor", "claude"],
    projects: ["/Users/timothy.green/personal/Pacer"],
    sessions: [MOCK_SESSION],
    activeSessionId,
    messages,
    streaming: false,
    currentTool: null,
    historyLoading,
    connect: () => {},
    disconnect: () => {},
    spawnSession: () => {},
    resumeSession,
    sendMessage: () => {},
    leaveSession,
    cancelMessage: () => {},
    registerPushToken: () => {},
    clearError: () => {},
  };
}
