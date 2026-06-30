/**
 * Drop-in replacement for useDiktat that never opens a WebSocket.
 * Starts already "connected", exposes one mock session, and loads
 * MOCK_MESSAGES when that session is resumed.
 *
 * Swap in by setting MOCK_MODE = true in App.tsx.
 */
import { useState, useCallback, useRef, useEffect } from "react";
import type { DiktatSession, DiktatMessage } from "./useDiktat";
import { MOCK_MESSAGES } from "../utils/mockMessages";

// Canned "agent reply" played after the user sends a message in MOCK_MODE, so
// the demo shows the full type → wait → respond flow (typing indicator, a tool
// action, then the result). Times are cumulative ms from send.
const MOCK_REPLY: Array<{ at: number; message: DiktatMessage }> = [
  {
    at: 800,
    message: { role: "assistant", text: "On it — I'll read the limiter, add a focused test, then run the suite." },
  },
  {
    // A read: no diff/preview, so its chip injects the file path into the
    // composer when tapped — the "pull a referenced file into your message" move.
    at: 1700,
    message: {
      role: "tool",
      text: "",
      toolName: "Read:rateLimiter.ts",
      toolPath: "/Users/you/code/storefront/src/middleware/rateLimiter.ts",
    },
  },
  {
    at: 2700,
    message: {
      role: "tool",
      text: "",
      toolName: "Edit:rateLimiter.test.ts",
      toolPath: "/Users/you/code/storefront/src/middleware/rateLimiter.test.ts",
      toolDiff:
        "+ it(\"rejects the 61st request inside the window\", () => {\n+   const limit = rateLimiter({ perMinute: 60 });\n+   for (let i = 0; i < 60; i++) expect(call(limit).status).toBe(200);\n+   expect(call(limit).status).toBe(429);\n+ });",
      toolResult: "The file has been edited successfully.",
      toolTruncated: false,
      toolResultTruncated: false,
      toolFullSize: 420,
    },
  },
  {
    at: 3700,
    message: {
      role: "tool",
      text: "",
      toolName: "Bash:npm test",
      toolCommand: "npm test -- checkout",
      toolResult:
        "  checkout\n    ✓ rejects the 61st request in a window (429)\n    ✓ sends a Retry-After header\n    ✓ refills the bucket after the window\n\n  Tests: 25 passed, 25 total",
      toolTruncated: false,
      toolResultTruncated: false,
      toolFullSize: 610,
    },
  },
  {
    at: 4700,
    message: {
      role: "assistant",
      text: "Done — **25/25 passing** ✅. The new test confirms the 61st request in a window gets a `429`.",
    },
  },
];

const MOCK_PERMISSION_MODES = [
  { id: "plan" as const, label: "Plan · read-only" },
  { id: "auto" as const, label: "Auto-accept edits" },
  { id: "full" as const, label: "Full access" },
];

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

// Extra fixtures so the sessions list tells the multi-CLI story — one card per
// agent, every badge colour represented. Used for the App Store frames.
const MOCK_EXTRA_SESSIONS: DiktatSession[] = [
  {
    id: "a1d4f9027c63",
    cli: "claude",
    project: "/Users/you/code/auth-service",
    projectLabel: "auth-service",
    firstMessage: "Refactor the token refresh flow so expired sessions re-auth silently",
    lastActiveAt: new Date(Date.now() - 1000 * 60 * 4).toISOString(), // 4 min ago
    source: "claude",
  },
  {
    id: "b7e2c10984af",
    cli: "codex",
    project: "/Users/you/code/data-pipeline",
    projectLabel: "data-pipeline",
    firstMessage: "Add integration tests for the ingestion worker",
    lastActiveAt: new Date(Date.now() - 1000 * 60 * 26).toISOString(), // 26 min ago
    source: "codex",
  },
  {
    id: "c3a8d5621e07",
    cli: "copilot",
    project: "/Users/you/code/design-system",
    projectLabel: "design-system",
    firstMessage: "Migrate the settings screen to the new color tokens",
    lastActiveAt: new Date(Date.now() - 1000 * 60 * 62).toISOString(), // ~1 h ago
    source: "copilot",
  },
  {
    id: "d9f1b4730a52",
    cli: "kiro",
    project: "/Users/you/code/platform-infra",
    projectLabel: "platform-infra",
    firstMessage: "Add a health-check endpoint and wire it into the load balancer",
    lastActiveAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(), // 3 h ago
    source: "kiro",
  },
];

const STD_EFFORTS = [
  { id: "", label: "Default" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];

export function useMockDiktat(_host?: string, _port?: number) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DiktatMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const replyTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearReplyTimers = useCallback(() => {
    replyTimers.current.forEach(clearTimeout);
    replyTimers.current = [];
  }, []);
  useEffect(() => clearReplyTimers, [clearReplyTimers]);

  const resumeSession = useCallback((session: DiktatSession) => {
    clearReplyTimers();
    setStreaming(false);
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
  }, [clearReplyTimers]);

  const spawnSession = useCallback((_cli: string, _project: string, _model?: string, _permissionMode?: "plan" | "auto" | "full") => {
    // Create a NEW empty session and make it active with no messages,
    // so the empty-state placeholder is reachable.
    setActiveSessionId(`mock-session-${Date.now()}`);
    setMessages([]);
    setHistoryLoading(false);
  }, []);

  const sendMessage = useCallback((text: string, _opts?: { model?: string; permissionMode?: "plan" | "auto" | "full" }) => {
    clearReplyTimers();
    setMessages((prev) => [...prev, { role: "user", text }]);
    // Play the canned agent reply: typing indicator first (streaming + last
    // message is the user's), then each scripted part lands on its timer.
    setStreaming(true);
    for (const part of MOCK_REPLY) {
      const t = setTimeout(() => {
        setMessages((prev) => [...prev, part.message]);
      }, part.at);
      replyTimers.current.push(t);
    }
    const done = setTimeout(() => setStreaming(false), MOCK_REPLY[MOCK_REPLY.length - 1].at + 200);
    replyTimers.current.push(done);
  }, [clearReplyTimers]);

  const leaveSession = useCallback(() => {
    clearReplyTimers();
    setStreaming(false);
    setActiveSessionId(null);
    setMessages([]);
    setHistoryLoading(false);
    setReconnecting(false);
  }, [clearReplyTimers]);

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
    clis: ["claude", "cursor", "codex", "copilot", "kiro"],
    agents: {
      claude: { displayName: "Claude Code", models: [{ id: "", label: "Default" }, { id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" }], permissionModes: MOCK_PERMISSION_MODES, efforts: STD_EFFORTS },
      cursor: { displayName: "Cursor", models: [{ id: "", label: "Default" }, { id: "auto", label: "Auto" }], permissionModes: MOCK_PERMISSION_MODES },
      codex: { displayName: "Codex", models: [{ id: "", label: "Default" }, { id: "gpt-5.5", label: "gpt-5.5" }, { id: "gpt-5.5-codex", label: "gpt-5.5-codex" }], permissionModes: MOCK_PERMISSION_MODES },
      copilot: { displayName: "GitHub Copilot", models: [{ id: "", label: "Default" }, { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" }, { id: "gpt-5", label: "GPT-5" }], permissionModes: MOCK_PERMISSION_MODES, efforts: [{ id: "", label: "Default" }, { id: "none", label: "None" }, { id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }] },
      kiro: { displayName: "Kiro", models: [{ id: "", label: "Default" }, { id: "auto", label: "Auto" }], permissionModes: MOCK_PERMISSION_MODES, efforts: STD_EFFORTS },
    },
    projects: ["/Users/you/code/storefront", "/Users/you/code/auth-service", "/Users/you/code/data-pipeline", "/Users/you/code/design-system", "/Users/you/code/platform-infra"],
    sessions: [MOCK_SESSION, MOCK_RECONNECTING_SESSION, ...MOCK_EXTRA_SESSIONS],
    activeSessionId,
    messages,
    streaming,
    currentTool: null,
    historyLoading,
    stats: {
      overall: { runs: 24, edits: 86, linesAdded: 1240, linesRemoved: 410, commandsRun: 53, filesChanged: 38, testsPassed: 12, testsFailed: 3, durationMs: 5_400_000, lastRunAt: undefined },
      perSession: { [MOCK_SESSION.id]: { runs: 6, edits: 21, linesAdded: 318, linesRemoved: 95, commandsRun: 14, filesChanged: 9, testsPassed: 4, testsFailed: 1, durationMs: 1_320_000, lastRunAt: undefined } },
    },
    lastRunSummary: null,
    daemonVersion: null,
    connect,
    disconnect: () => {},
    spawnSession,
    resumeSession,
    sendMessage,
    leaveSession,
    cancelMessage: () => { clearReplyTimers(); setStreaming(false); },
    registerPushToken: () => {},
    clearError: () => {},
  };
}
