import { Session } from "./session";
import { readHistory, listClaudeSessions, claudeSessionExists } from "./claude-sessions";
import { readCursorHistory, listCursorSessions } from "./cursor-sessions";
import { readCodexHistory, listCodexSessions } from "./codex-sessions";
import { readCopilotHistory, listCopilotSessions } from "./copilot-sessions";
import { readKiroHistory, listKiroSessions } from "./kiro-sessions";
import { agentSelectionData } from "./agents";
import { listSessions } from "./session-store";

/**
 * Everything the message router needs, injected so it can be tested in
 * isolation from the bootstrap (config / CLI detection / relay client).
 */
export interface MessageContext {
  /** name → resolved CLI path (e.g. { claude: "/usr/bin/claude" }) */
  availableCLIs: Record<string, string>;
  /** allowed project paths from config */
  projects: string[];
  /** live sessions keyed by session id */
  activeSessions: Map<string, Session>;
  /** per-ws push token store (WeakMap keyed by ws object) */
  clientPushTokens: WeakMap<object, string>;
  /** Session factory — injectable so tests can stub spawning/resuming. */
  sessionFactory?: SessionFactory;
  /** History readers — injectable for tests. Default to the real readers. */
  readClaudeHistory?: typeof readHistory;
  readCursorHistory?: typeof readCursorHistory;
  readCodexHistory?: typeof readCodexHistory;
  readCopilotHistory?: typeof readCopilotHistory;
  readKiroHistory?: typeof readKiroHistory;
}

/**
 * Build the `connected` handshake payload sent to a freshly attached client.
 * Shared by both transports: local Bun.serve open() and relay client_attached.
 * Mirrors the original index.ts open() body (including its error fallback) so
 * local-mode output is byte-for-byte identical.
 */
export function buildConnectedPayload(ctx: MessageContext): Record<string, unknown> {
  const base = {
    type: "connected" as const,
    clis: Object.keys(ctx.availableCLIs),
    projects: ctx.projects,
    // Per-CLI model + permission options for the app's dropdowns.
    agents: agentSelectionData(),
  };
  try {
    return {
      ...base,
      // The stale-resume check only applies to Claude sessions (their id maps to
      // a Claude session file). Cursor/Copilot daemon sessions own their id, so
      // never drop them here.
      sessions: listSessions().filter((s) => s.cli !== "claude" || !s.cliSessionId || claudeSessionExists(s.cliSessionId)),
      claudeSessions: listClaudeSessions(),
      cursorSessions: listCursorSessions(),
      codexSessions: listCodexSessions(),
      copilotSessions: listCopilotSessions(),
      kiroSessions: listKiroSessions(),
    };
  } catch (e) {
    console.error("Error building connected message:", e);
    return { ...base, sessions: [], claudeSessions: [], cursorSessions: [], codexSessions: [], copilotSessions: [], kiroSessions: [] };
  }
}

// Phone-supplied session ids flow into filesystem path joins in the history
// readers. All real ids are UUIDs (Claude/Cursor/Codex/Copilot/Kiro), but allow
// the slightly wider [A-Za-z0-9._-] charset; never path separators or "..".
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;
export function isValidSessionId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    SAFE_SESSION_ID.test(id) &&
    !id.includes("..") &&
    !id.includes("/") &&
    !id.includes("\\")
  );
}

export interface SessionFactory {
  create(ws: any, cli: string, cliPath: string, project: string, model?: string, permissionMode?: "plan" | "auto" | "full"): Session;
  resume(ws: any, sessionId: string): Session | null;
  fromClaudeSession(ws: any, sessionId: string, project: string, cliPath: string): Session;
  fromCursorSession(ws: any, sessionId: string, project: string, cliPath: string): Session;
  fromCodexSession(ws: any, sessionId: string, project: string, cliPath: string): Session;
  fromCopilotSession(ws: any, sessionId: string, project: string, cliPath: string): Session;
  fromKiroSession(ws: any, project: string, cliPath: string): Session;
}

const defaultSessionFactory: SessionFactory = {
  create: (ws, cli, cliPath, project, model, permissionMode) => Session.create(ws, cli, cliPath, project, model, permissionMode),
  resume: (ws, id) => Session.resume(ws, id),
  fromClaudeSession: (ws, id, project, cliPath) => Session.fromClaudeSession(ws, id, project, cliPath),
  fromCursorSession: (ws, id, project, cliPath) => Session.fromCursorSession(ws, id, project, cliPath),
  fromCodexSession: (ws, id, project, cliPath) => Session.fromCodexSession(ws, id, project, cliPath),
  fromCopilotSession: (ws, id, project, cliPath) => Session.fromCopilotSession(ws, id, project, cliPath),
  fromKiroSession: (ws, project, cliPath) => Session.fromKiroSession(ws, project, cliPath),
};

/**
 * Route a single already-parsed client message. Returns nothing — all output
 * goes through `ws.send`. This is the testable core of the websocket handler.
 */
export async function handleClientMessage(ctx: MessageContext, ws: any, msg: any): Promise<void> {
  const factory = ctx.sessionFactory ?? defaultSessionFactory;
  const readClaude = ctx.readClaudeHistory ?? readHistory;
  const readCursor = ctx.readCursorHistory ?? readCursorHistory;
  const readCodex = ctx.readCodexHistory ?? readCodexHistory;
  const readCopilot = ctx.readCopilotHistory ?? readCopilotHistory;
  const readKiro = ctx.readKiroHistory ?? readKiroHistory;

  if (msg.type === "spawn") {
    if (!ctx.availableCLIs[msg.cli]) {
      ws.send(JSON.stringify({ type: "error", message: `CLI not available: ${msg.cli}` }));
      return;
    }
    if (!ctx.projects.includes(msg.project)) {
      ws.send(JSON.stringify({ type: "error", message: `Project not in allowed list: ${msg.project}` }));
      return;
    }
    const session = factory.create(ws, msg.cli, ctx.availableCLIs[msg.cli]!, msg.project, msg.model, msg.permissionMode);
    ctx.activeSessions.set(session.id, session);
    ws.send(JSON.stringify({ type: "spawned", session: session.summary }));
    return;
  }

  if (msg.type === "resume") {
    if (!isValidSessionId(msg.sessionId)) {
      ws.send(JSON.stringify({ type: "error", message: `Session not found: ${msg.sessionId}` }));
      return;
    }
    const session = msg.isClaudeSession
      ? factory.fromClaudeSession(ws, msg.sessionId, msg.project ?? process.cwd(), ctx.availableCLIs["claude"] ?? "claude")
      : msg.isCursorSession
        ? factory.fromCursorSession(ws, msg.sessionId, msg.project ?? process.cwd(), ctx.availableCLIs["cursor"] ?? "agent")
        : msg.isCodexSession
          ? factory.fromCodexSession(ws, msg.sessionId, msg.project ?? process.cwd(), ctx.availableCLIs["codex"] ?? "codex")
          : msg.isCopilotSession
            ? factory.fromCopilotSession(ws, msg.sessionId, msg.project ?? process.cwd(), ctx.availableCLIs["copilot"] ?? "copilot")
            : msg.isKiroSession
              ? factory.fromKiroSession(ws, msg.project ?? process.cwd(), ctx.availableCLIs["kiro"] ?? "kiro-cli")
              : factory.resume(ws, msg.sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: `Session not found: ${msg.sessionId}` }));
      return;
    }
    ctx.activeSessions.set(session.id, session);
    ws.send(JSON.stringify({ type: "resumed", session: session.summary }));
    // Read history async — don't block the event loop on large files.
    // Claude/Codex/Copilot/Kiro history is keyed by the native session id
    // (msg.sessionId); Cursor by the daemon session's captured cliSessionId.
    const historyId =
      msg.isClaudeSession || msg.isCodexSession || msg.isCopilotSession || msg.isKiroSession
        ? msg.sessionId
        : session.summary.cliSessionId;
    if (historyId) {
      setImmediate(async () => {
        try {
          const history = msg.isCursorSession
            ? readCursor(historyId)
            : msg.isCodexSession
              ? readCodex(historyId)
              : msg.isCopilotSession
                ? readCopilot(historyId)
                : msg.isKiroSession
                  ? readKiro(historyId)
                  : readClaude(historyId);
          if (history.length > 0) {
            ws.send(JSON.stringify({ type: "history", messages: history }));
          }
        } catch (e) {
          console.error("Error loading history:", e);
        }
      });
    }
    return;
  }

  if (msg.type === "input") {
    if (!isValidSessionId(msg.sessionId)) {
      ws.send(JSON.stringify({ type: "error", message: `No active session: ${msg.sessionId}` }));
      return;
    }
    const session = ctx.activeSessions.get(msg.sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: `No active session: ${msg.sessionId}` }));
      return;
    }
    // Per-turn model / permission overrides from the composer dropdowns.
    if (msg.model !== undefined || msg.permissionMode) {
      session.applyOptions({ model: msg.model, permissionMode: msg.permissionMode });
    }
    const pushToken = ctx.clientPushTokens.get(ws as object);
    try {
      await session.send(msg.text, pushToken);
    } catch (e) {
      console.error("Error in session.send:", e);
      try { ws.send(JSON.stringify({ type: "error", message: `Session error: ${(e as Error).message}` })); } catch {}
    }
    return;
  }

  if (msg.type === "cancel") {
    if (!isValidSessionId(msg.sessionId)) return;
    const session = ctx.activeSessions.get(msg.sessionId);
    if (session) {
      session.cancel();
      ws.send(JSON.stringify({ type: "exit", code: -1 }));
    }
    return;
  }

  if (msg.type === "register_push") {
    if (msg.token) ctx.clientPushTokens.set(ws as object, msg.token);
    return;
  }

  if (msg.type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
    return;
  }
}
