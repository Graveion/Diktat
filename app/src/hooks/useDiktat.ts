import { useEffect, useRef, useState, useCallback } from "react";
import { info, warn, error as logError } from "../utils/logger";
import { mergeSessions, toolDisplayString, appendOutput } from "../utils/messages";
import { track } from "../utils/analytics";
import { recordSessionAndMaybePrompt } from "../utils/review";
import { supabase } from "../store/supabase";

export type DiktatSession = {
  id: string;
  cli: string;
  project: string;
  projectLabel?: string;
  firstMessage?: string;
  lastActiveAt: string;
  source: "daemon" | "claude" | "cursor" | "codex" | "copilot" | "kiro";
};

export type PermissionModeId = "plan" | "auto" | "full";
export type AgentModel = { id: string; label: string };
export type AgentEffort = { id: string; label: string };
export type AgentSelection = {
  displayName: string;
  models: AgentModel[];
  permissionModes: { id: PermissionModeId; label: string }[];
  efforts?: AgentEffort[]; // empty/absent → CLI has no reasoning-effort control
};
/** Per-CLI model + permission options, from the daemon's `connected` payload. */
export type AgentSelectionMap = Record<string, AgentSelection>;

export type DiktatMessage = {
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  toolPath?: string;
  // Tool enrichment — all optional, populated from daemon when available
  toolId?: string;
  toolDiff?: string;
  toolPreview?: string;
  toolCommand?: string;
  toolResult?: string;
  toolTruncated?: boolean;
  toolResultTruncated?: boolean;
  toolFullSize?: number;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";
export type ConnIssue = "relay-unreachable" | "daemon-offline";

// Authoritative run summary from the daemon (sent on the `exit` frame). Mirrors
// the daemon's RunSummary; richer than the client-side derivation (true
// pass/fail + exact diff counts).
export type RunSummary = {
  filesChanged: string[];
  editCount: number;
  linesAdded: number;
  linesRemoved: number;
  commandsRun: number;
  testStatus: "pass" | "fail" | "none";
  durationMs: number;
  exitCode: number;
};

// Locally-persisted usage aggregates (daemon's run-stats-store).
export type StatsTotals = {
  runs: number;
  edits: number;
  linesAdded: number;
  linesRemoved: number;
  commandsRun: number;
  filesChanged: number;
  testsPassed: number;
  testsFailed: number;
  durationMs: number;
  lastRunAt?: string;
};
export type AggregatedStats = {
  overall: StatsTotals;
  perSession: Record<string, StatsTotals>;
};

// Relay-transport descriptor. When provided, the hook connects via the relay
// broker (wss) instead of dialing the daemon directly (ws://host:port). See
// relay/RELAY.md for the wire contract.
export type RelayDescriptor = {
  relayUrl: string; // wss:// base, e.g. wss://host:9090
  machineId: string;
  accountToken: string;
};

const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 30000;

export function useDiktat(relay?: RelayDescriptor) {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectDelay = useRef(RECONNECT_DELAY_MS);
  const intentionalDisconnect = useRef(false);
  const discardOutput = useRef(false);
  const hasReceivedOutput = useRef(false);
  // True once a socket has successfully opened. Gates the "Reconnecting…" banner
  // so it only appears when an established connection drops — not during the
  // first connect attempt or a machine that was never online.
  const hasConnected = useRef(false);
  const relayRef = useRef<RelayDescriptor | undefined>(relay);
  relayRef.current = relay;
  const pushTokenRef = useRef<string | null>(null);
  const pendingResumeRef = useRef<{ session: DiktatSession } | null>(null);
  const isAutoResumingRef = useRef(false);
  // Set when the daemon couldn't replay the full detached gap (its buffer
  // overflowed) and asks us to reload history instead of preserving the now-
  // stale in-memory transcript on the next auto-resume.
  const forceHistoryReloadRef = useRef(false);
  // Consecutive auth rejections. The descriptor's token can expire mid-session;
  // each redial fetches a fresh one, so a rejection is usually transient. Only
  // give up after several in a row (genuinely revoked session).
  const authFailures = useRef(0);

  const [state, setState] = useState<ConnectionState>("disconnected");
  const [reconnecting, setReconnecting] = useState(false);
  // Classifies *why* we're disconnected so the UI can show the right guidance:
  //   relay-unreachable — the relay socket itself dropped (network/relay down)
  //   daemon-offline    — relay is fine, the Mac's daemon is away (soft)
  // auth-expired is surfaced separately via errorMessage (needs re-sign-in).
  const [connIssue, setConnIssue] = useState<ConnIssue | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [clis, setClis] = useState<string[]>([]);
  const [agents, setAgents] = useState<AgentSelectionMap>({});
  const [projects, setProjects] = useState<string[]>([]);
  const [sessions, setSessions] = useState<DiktatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DiktatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  // True between spawned/resumed and the first history (or output) event.
  // Lets the UI show a loading state instead of the empty-session placeholder.
  const [historyLoading, setHistoryLoading] = useState(false);
  // Older-message paging ("scroll up to load more"). hasMore reflects whether
  // the daemon believes older messages exist; paging guards against overlapping
  // requests. messagesRef gives loadMoreHistory the current count without
  // re-creating the callback on every message.
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyPaging, setHistoryPaging] = useState(false);
  // Ref mirrors so loadMoreHistory can guard synchronously without depending on
  // (and re-binding to) the state values.
  const historyHasMoreRef = useRef(false);
  const historyPagingRef = useRef(false);
  const messagesRef = useRef<DiktatMessage[]>([]);
  const [stats, setStats] = useState<AggregatedStats | null>(null);
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
  // Authoritative summary of the most recent run (from the exit frame). Cleared
  // when a new run starts so the chat's last-run card reflects the latest run.
  const [lastRunSummary, setLastRunSummary] = useState<RunSummary | null>(null);

  // Mirror messages into a ref so loadMoreHistory reads the live count without
  // being re-created (and re-bound in ChatScreen) on every streamed chunk.
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const connect = useCallback(async () => {
    const relayCfg = relayRef.current;
    if (!relayCfg) { warn("WS", "connect() called with no relay descriptor — skipping"); return; }

    intentionalDisconnect.current = false;
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }

    ws.current?.close();
    ws.current = null;
    setState("connecting");
    setErrorMessage(null);
    setConnIssue(null);

    // Supabase access tokens expire (~1h) and the descriptor's copy is frozen
    // at connect-to-machine time, so every dial — especially reconnects — must
    // use the freshest session token. getSession() auto-refreshes if expired.
    let accountToken = relayCfg.accountToken;
    try {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) accountToken = data.session.access_token;
    } catch { /* offline — fall back to the descriptor token */ }
    if (relayRef.current !== relayCfg || intentionalDisconnect.current) return;

    let socket: WebSocket;
    {
      const url = `${relayCfg.relayUrl}/client?machineId=${encodeURIComponent(relayCfg.machineId)}`;
      info("WS", `Connecting via relay to ${url}`);
      // RN-specific: React Native's WebSocket accepts an options object as the
      // 3rd constructor arg to set request headers pre-upgrade. Browsers cannot
      // set WS headers, but this is a native app so it's fine. The broker reads
      // the account token from `Authorization: Bearer <token>` before upgrading.
      // The lib.dom WebSocket type only declares 2 args; RN's runtime accepts a
      // 3rd options object (protocols=undefined, then { headers }). Cast the
      // constructor to reach it without pulling in @types/react-native here.
      const RNWebSocket = WebSocket as unknown as {
        new (url: string, protocols: undefined, options: { headers: Record<string, string> }): WebSocket;
      };
      socket = new RNWebSocket(url, undefined, {
        headers: { Authorization: `Bearer ${accountToken}` },
      });
    }
    ws.current = socket;

    socket.onopen = () => {
      if (ws.current !== socket) { info("WS", "onopen: stale socket — ignoring"); return; }
      reconnectDelay.current = RECONNECT_DELAY_MS;
      authFailures.current = 0;
      hasConnected.current = true;
      setReconnecting(false);
      // Relay transport is back; a daemon-offline issue (if any) is resolved by
      // the machine_online/offline frames that follow, not here.
      setConnIssue((c) => (c === "relay-unreachable" ? null : c));
      setState("connected");
      info("WS", `Connected via relay to machine ${relayCfg.machineId}`);
      if (pushTokenRef.current) {
        socket.send(JSON.stringify({ type: "register_push", token: pushTokenRef.current }));
        info("PUSH", "Registered push token with daemon");
      }
      // Keep-alive ping every 30s to prevent idle timeout
      if (pingTimer.current) clearInterval(pingTimer.current);
      pingTimer.current = setInterval(() => {
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);
    };

    socket.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch (err) {
        logError("MSG", `Failed to parse message: ${e.data?.slice?.(0, 100)}`);
        return;
      }

      // Relay control frames are handled at the transport layer and never reach
      // app-message dispatch. They only appear in relay mode (direct ws never
      // emits them). See relay/RELAY.md §3/§4.
      if (msg._relay === true) {
        switch (msg.type) {
          case "machine_online":
            // Daemon is connected; relay brokering is live. Clear the soft
            // offline ("reconnecting") banner. Do NOT treat as a fresh connect —
            // the daemon will send its own `connected` app frame, which the
            // existing handler processes and auto-resumes from.
            info("RELAY", "machine_online: daemon connected");
            setReconnecting(false);
            setConnIssue(null);
            break;
          case "machine_offline":
            // SOFT state: the relay socket is healthy, only the daemon is away.
            // Show the reconnecting banner but do NOT close/tear down/back off —
            // keep the relay socket and wait for machine_online.
            info("RELAY", "machine_offline: daemon away (soft) — keeping relay socket");
            setReconnecting(true);
            setConnIssue("daemon-offline");
            break;
          case "relay_error": {
            const code = msg.code as string | undefined;
            logError("RELAY", `relay_error: code=${code} message=${msg.message ?? ""}`);
            // Ownership failures are permanent — stay down. Auth failures are
            // usually a token that expired mid-backoff; each redial fetches a
            // fresh one, so retry a couple of times before giving up.
            if (code === "forbidden") {
              intentionalDisconnect.current = true;
            } else if (code === "unauthorized") {
              authFailures.current += 1;
              if (authFailures.current >= 3) {
                intentionalDisconnect.current = true;
                setErrorMessage("Session expired — please sign in again.");
              }
            }
            // "replaced" (and any close that follows) goes through the normal
            // onclose backoff path.
            break;
          }
          default:
            // Other relay frames (e.g. ping) are informational; ignore.
            break;
        }
        return;
      }

      if (msg.type === "connected") {
        setState("connected");
        setConnIssue(null); // fully healthy: relay up + daemon handshaked
        setClis(msg.clis ?? []);
        setAgents(msg.agents ?? {});
        setProjects(msg.projects ?? []);
        const all = mergeSessions({
          sessions: msg.sessions,
          claudeSessions: msg.claudeSessions,
          cursorSessions: msg.cursorSessions,
          codexSessions: msg.codexSessions,
          copilotSessions: msg.copilotSessions,
          kiroSessions: msg.kiroSessions,
        });
        setSessions(all);
        if (msg.stats) setStats(msg.stats as AggregatedStats);
        if (typeof msg.daemonVersion === "string") setDaemonVersion(msg.daemonVersion);
        const countBy = (src: string) => all.filter((s) => s.source === src).length;
        info("MSG", `connected: clis=[${(msg.clis ?? []).join(",")}] sessions=${all.length} (claude=${countBy("claude")} cursor=${countBy("cursor")} codex=${countBy("codex")} copilot=${countBy("copilot")} kiro=${countBy("kiro")} daemon=${countBy("daemon")})`);
        track("app_connected", { clis: (msg.clis ?? []).length, sessions: all.length });
        // Auto-resume session if we reconnected mid-session. Flag this case so
        // the subsequent "resumed" event preserves in-memory messages instead
        // of clearing them (otherwise the just-finished turn vanishes when
        // history loads from JSONL, which may lag the most recent write).
        if (pendingResumeRef.current) {
          const { session } = pendingResumeRef.current;
          info("SESSION", `auto-resuming session ${session.id} after reconnect`);
          isAutoResumingRef.current = true;
          socket.send(JSON.stringify({
            type: "resume",
            sessionId: session.id,
            isClaudeSession: session.source === "claude",
            isCursorSession: session.source === "cursor",
            isCodexSession: session.source === "codex",
            isCopilotSession: session.source === "copilot",
            isKiroSession: session.source === "kiro",
            project: session.project,
          }));
        }
        return;
      }

      // Daemon's detached-output buffer overflowed: the in-memory transcript
      // can't be trusted to be complete, so reload history on the pending
      // auto-resume instead of preserving it.
      if (msg.type === "resync") {
        info("SESSION", "resync requested by daemon (detached buffer overflow)");
        forceHistoryReloadRef.current = true;
        return;
      }

      if (msg.type === "spawned" || msg.type === "resumed") {
        discardOutput.current = false;
        setActiveSessionId(msg.session.id);
        // Register spawned sessions for auto-resume too — without this, a WS
        // drop after spawn leaves the new session unattached on reconnect.
        // (resumeSession already registered resumed ones with the full record.)
        if (msg.type === "spawned") {
          pendingResumeRef.current = { session: { source: "daemon", ...msg.session } };
        }
        if (msg.type === "resumed" && isAutoResumingRef.current && !forceHistoryReloadRef.current) {
          // Reconnect mid-session, gap already replayed by the daemon: keep
          // current in-memory messages and the hasReceivedOutput gate so the
          // trailing history load is skipped.
          isAutoResumingRef.current = false;
          info("SESSION", `resumed (auto, preserving in-memory msgs): sessionId=${msg.session.id}`);
        } else {
          // Fresh resume OR an overflow resync — reload history from scratch.
          isAutoResumingRef.current = false;
          forceHistoryReloadRef.current = false;
          hasReceivedOutput.current = false;
          setMessages([]);
          setStreaming(false);
          setHistoryLoading(true);
          historyHasMoreRef.current = false;
          historyPagingRef.current = false;
          setHistoryHasMore(false);
          setHistoryPaging(false);
          info("SESSION", `${msg.type}: sessionId=${msg.session.id} cli=${msg.session.cli} project=${msg.session.project}`);
        }
        return;
      }

      if (msg.type === "history") {
        const msgs = msg.messages ?? [];
        setHistoryLoading(false);
        // Skip history if output has already started — history loading is async
        // and can race with the user's first message, wiping streamed content.
        if (hasReceivedOutput.current) {
          info("SESSION", `history: skipped (output already started), ${msgs.length} msgs`);
          return;
        }
        setMessages(msgs);
        historyHasMoreRef.current = msg.hasMore === true;
        setHistoryHasMore(msg.hasMore === true);
        info("SESSION", `history: ${msgs.length} messages loaded (hasMore=${msg.hasMore === true})`);
        return;
      }

      if (msg.type === "history_page") {
        const older = (msg.messages ?? []) as DiktatMessage[];
        historyPagingRef.current = false;
        historyHasMoreRef.current = msg.hasMore === true;
        setHistoryPaging(false);
        setHistoryHasMore(msg.hasMore === true);
        // Prepend older messages. Ignore an empty page (nothing older after all).
        if (older.length > 0) setMessages((prev) => [...older, ...prev]);
        info("SESSION", `history_page: +${older.length} older (hasMore=${msg.hasMore === true})`);
        return;
      }

      if (msg.type === "tool_use") {
        if (!discardOutput.current) {
          const toolStr = toolDisplayString(msg.name, msg.path as string | undefined);
          setCurrentTool(toolStr);
          // Persist tool usage into message history
          setMessages((prev) => [
            ...prev,
            {
              role: "tool" as const,
              text: "",
              toolName: toolStr ?? msg.name,
              toolPath: msg.path as string | undefined,
              toolId: msg.id as string | undefined,
              toolDiff: msg.diff as string | undefined,
              toolPreview: msg.preview as string | undefined,
              toolCommand: msg.command as string | undefined,
              toolTruncated: msg.truncated as boolean | undefined,
              toolFullSize: msg.fullSize as number | undefined,
            },
          ]);
        }
        info("MSG", `tool_use: ${msg.name}${msg.path ? ` (${msg.path})` : ""}`);
        return;
      }

      if (msg.type === "tool_result") {
        if (!discardOutput.current && msg.toolUseId) {
          setMessages((prev) => {
            const idx = [...prev].reverse().findIndex(
              (m) => m.role === "tool" && m.toolId === msg.toolUseId,
            );
            if (idx === -1) return prev;
            const realIdx = prev.length - 1 - idx;
            const cur = prev[realIdx];
            if (!cur) return prev;
            const next = prev.slice();
            next[realIdx] = {
              ...cur,
              toolResult: msg.preview as string | undefined,
              toolResultTruncated: msg.truncated as boolean | undefined,
              toolFullSize: cur.toolFullSize ?? (msg.fullSize as number | undefined),
            };
            return next;
          });
        }
        return;
      }

      if (msg.type === "output") {
        if (discardOutput.current) {
          info("MSG", "output: discarded (stale session)");
          return;
        }
        hasReceivedOutput.current = true;
        setHistoryLoading(false);
        setCurrentTool(null);
        setStreaming(true);
        setMessages((prev) => appendOutput(prev, msg.text));
        return;
      }

      if (msg.type === "exit") {
        setStreaming(false);
        setCurrentTool(null);
        if (msg.summary) setLastRunSummary(msg.summary as RunSummary);
        info("SESSION", `exit: code=${msg.code}`);
        if (msg.code === 0) {
          track("session_completed", { code: 0 });
          recordSessionAndMaybePrompt();
        }
        return;
      }

      if (msg.type === "error") {
        logError("MSG", `daemon error: ${msg.message}`);
        setErrorMessage(msg.message ?? "An error occurred");
        // A failed (auto-)resume must clear the flag, or the next manual
        // resume takes the preserve-messages branch and shows stale content.
        isAutoResumingRef.current = false;
        if (msg.message?.includes("No active session")) {
          warn("SESSION", "Active session invalidated (daemon may have restarted)");
          setActiveSessionId(null);
          pendingResumeRef.current = null;
          setStreaming(false);
          setCurrentTool(null);
        }
        return;
      }

      if (msg.type === "pong") return; // keep-alive response, no action needed

      info("MSG", `unhandled message type: ${msg.type}`);
    };

    socket.onerror = () => {
      if (ws.current !== socket) return;
      // Transient transport error — don't show a sticky error banner. onclose
      // follows and drives reconnect; the "Reconnecting…" banner covers it.
      logError("WS", "WebSocket transport error (will reconnect)");
    };

    socket.onclose = (e) => {
      if (ws.current !== socket) { info("WS", "onclose: stale socket — ignoring"); return; }
      info("WS", `Disconnected (code=${e.code} reason="${e.reason}" wasClean=${e.wasClean} intentional=${intentionalDisconnect.current})`);
      if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }
      setState("disconnected");
      if (intentionalDisconnect.current) {
        setReconnecting(false);
        return;
      }
      // Only surface the reconnecting banner if an established connection
      // dropped; stay quiet during the initial connect. The relay socket itself
      // closed, so this is a transport problem (distinct from daemon-offline,
      // where the relay stays up and only machine_offline fires).
      setReconnecting(hasConnected.current);
      if (hasConnected.current) setConnIssue("relay-unreachable");
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
    setConnIssue(null);
    setErrorMessage(null);
  }, []);

  const leaveSession = useCallback(() => {
    info("SESSION", "leaveSession() — discarding further output from current session");
    discardOutput.current = true;
    pendingResumeRef.current = null;
    isAutoResumingRef.current = false;
    setActiveSessionId(null);
    setMessages([]);
    setStreaming(false);
    setCurrentTool(null);
    setHistoryLoading(false);
    historyHasMoreRef.current = false;
    historyPagingRef.current = false;
    setHistoryHasMore(false);
    setHistoryPaging(false);
  }, []);

  const cancelMessage = useCallback((sessionId: string) => {
    info("SESSION", `cancel: sessionId=${sessionId}`);
    ws.current?.send(JSON.stringify({ type: "cancel", sessionId }));
    setStreaming(false);
  }, []);

  const spawnSession = useCallback((cli: string, project: string, model?: string, permissionMode?: PermissionModeId, effort?: string) => {
    info("SESSION", `spawn: cli=${cli} project=${project}${model ? ` model=${model}` : ""}${permissionMode ? ` perm=${permissionMode}` : ""}${effort ? ` effort=${effort}` : ""}`);
    track("session_started", { cli, model: model ?? "", permissionMode: permissionMode ?? "auto" });
    ws.current?.send(JSON.stringify({
      type: "spawn",
      cli,
      project,
      ...(model ? { model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(effort ? { effort } : {}),
    }));
  }, []);

  const resumeSession = useCallback((session: DiktatSession) => {
    info("SESSION", `resume: id=${session.id} source=${session.source} cli=${session.cli} project=${session.project}`);
    track("session_resumed", { source: session.source, cli: session.cli ?? "" });
    pendingResumeRef.current = { session };
    ws.current?.send(JSON.stringify({
      type: "resume",
      sessionId: session.id,
      isClaudeSession: session.source === "claude",
      isCursorSession: session.source === "cursor",
      isCodexSession: session.source === "codex",
      isCopilotSession: session.source === "copilot",
      isKiroSession: session.source === "kiro",
      project: session.project,
    }));
  }, []);

  const sendMessage = useCallback((text: string, opts?: { model?: string; permissionMode?: PermissionModeId }) => {
    if (!activeSessionId) { warn("SESSION", "sendMessage called with no activeSessionId"); return false; }
    // Never show an optimistic bubble for a message the socket can't deliver —
    // during backoff or machine-offline the send would silently vanish.
    if (ws.current?.readyState !== WebSocket.OPEN) {
      warn("SESSION", "sendMessage: socket not open — message not sent");
      setErrorMessage("Not connected — message not sent. Retry when reconnected.");
      return false;
    }
    info("SESSION", `input: sessionId=${activeSessionId} text="${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
    track("message_sent", { ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}) });
    setMessages((prev) => [...prev, { role: "user", text }]);
    setLastRunSummary(null); // new turn — clear the previous run's summary card
    ws.current.send(JSON.stringify({
      type: "input",
      sessionId: activeSessionId,
      text,
      // Per-turn overrides applied before the run (daemon persists them).
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    }));
    setStreaming(true);
    return true;
  }, [activeSessionId]);

  // Fetch the page of messages just before the ones currently shown. The daemon
  // over-fetches from the session-file tail and returns only the older slice.
  // Guarded so overlapping scroll events don't fire duplicate requests.
  const loadMoreHistory = useCallback(() => {
    if (!activeSessionId) return;
    if (!historyHasMoreRef.current || historyPagingRef.current) return;
    if (ws.current?.readyState !== WebSocket.OPEN) return;
    historyPagingRef.current = true;
    setHistoryPaging(true);
    info("SESSION", `load_history: loaded=${messagesRef.current.length}`);
    ws.current.send(JSON.stringify({
      type: "load_history",
      sessionId: activeSessionId,
      loaded: messagesRef.current.length,
    }));
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
      // onclose normally clears the ping timer, but it can never fire if the
      // socket already errored — clear here too or the interval leaks forever.
      if (pingTimer.current) clearInterval(pingTimer.current);
      ws.current?.close();
    };
  }, []);

  return {
    state, reconnecting, connIssue, errorMessage, clis, agents, projects, sessions, activeSessionId,
    messages, streaming, currentTool, historyLoading, stats, lastRunSummary, daemonVersion, connect, disconnect,
    spawnSession, resumeSession, sendMessage, leaveSession, cancelMessage,
    registerPushToken, clearError,
    historyHasMore, historyPaging, loadMoreHistory,
  };
}
