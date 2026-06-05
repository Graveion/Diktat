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
  id: "9f3c1a7042e8",
  cli: "cursor",
  project: "/Users/you/code/storefront",
  projectLabel: "storefront",
  firstMessage: "Add rate limiting to the checkout endpoint",
  lastActiveAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(), // 12 min ago
  source: "cursor",
};

// Dedicated fixture session for exercising the reconnecting banner in UI tests.
// Resuming it leaves the hook in a reconnecting state instead of loading history.
export const MOCK_RECONNECTING_SESSION_ID = "c4b2e85130a9";
const MOCK_RECONNECTING_SESSION: DiktatSession = {
  id: MOCK_RECONNECTING_SESSION_ID,
  cli: "cursor",
  project: "/Users/you/code/landing-page",
  projectLabel: "landing-page",
  firstMessage: "Fix the mobile nav overflow on small screens",
  lastActiveAt: new Date(Date.now() - 1000 * 60 * 3).toISOString(), // 3 min ago
  source: "cursor",
};

export function useMockDiktat(_host?: string, _port?: number) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DiktatMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const resumeSession = useCallback((session: DiktatSession) => {
    setActiveSessionId(session.id);
    // The dedicated reconnecting fixture parks in the reconnecting state
    // (banner + Retry) rather than loading history.
    if (session.id === MOCK_RECONNECTING_SESSION_ID) {
      setReconnecting(true);
      setMessages([]);
      setHistoryLoading(false);
      return;
    }
    setReconnecting(false);
    setHistoryLoading(true);
    // Simulate a short history-load delay, just like the real hook
    setTimeout(() => {
      setMessages(MOCK_MESSAGES);
      setHistoryLoading(false);
    }, 400);
  }, []);

  const spawnSession = useCallback((_cli: string, _project: string, _mode?: string) => {
    // Create a NEW empty session and make it active with no messages,
    // so the empty-state placeholder is reachable.
    setActiveSessionId(`mock-session-${Date.now()}`);
    setMessages([]);
    setHistoryLoading(false);
  }, []);

  const sendMessage = useCallback((text: string) => {
    setMessages((prev) => [...prev, { role: "user", text }]);
  }, []);

  const leaveSession = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
    setHistoryLoading(false);
    setReconnecting(false);
  }, []);

  // Retry on the reconnecting banner clears the reconnecting state and loads history.
  const connect = useCallback(() => {
    setReconnecting(false);
    setHistoryLoading(true);
    setTimeout(() => {
      setMessages(MOCK_MESSAGES);
      setHistoryLoading(false);
    }, 400);
  }, []);

  return {
    state: "connected" as const,
    reconnecting,
    errorMessage: null,
    clis: ["cursor", "claude"],
    projects: ["/Users/you/code/storefront"],
    sessions: [MOCK_SESSION, MOCK_RECONNECTING_SESSION],
    activeSessionId,
    messages,
    streaming: false,
    currentTool: null,
    historyLoading,
    connect,
    disconnect: () => {},
    spawnSession,
    resumeSession,
    sendMessage,
    leaveSession,
    cancelMessage: () => {},
    registerPushToken: () => {},
    clearError: () => {},
  };
}
