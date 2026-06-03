import { Session } from "./session";
import { readHistory } from "./claude-sessions";
import { readCursorHistory } from "./cursor-sessions";

/**
 * Everything the message router needs, injected so it can be tested in
 * isolation from the Bun.serve bootstrap (config/CLI detection/tailscale).
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
}

export interface SessionFactory {
  create(ws: any, cli: string, cliPath: string, project: string, mode?: string): Session;
  resume(ws: any, sessionId: string): Session | null;
  fromClaudeSession(ws: any, sessionId: string, project: string, cliPath: string): Session;
  fromCursorSession(ws: any, sessionId: string, project: string, cliPath: string): Session;
}

const defaultSessionFactory: SessionFactory = {
  create: (ws, cli, cliPath, project, mode) => Session.create(ws, cli, cliPath, project, mode),
  resume: (ws, id) => Session.resume(ws, id),
  fromClaudeSession: (ws, id, project, cliPath) => Session.fromClaudeSession(ws, id, project, cliPath),
  fromCursorSession: (ws, id, project, cliPath) => Session.fromCursorSession(ws, id, project, cliPath),
};

/**
 * Route a single already-parsed client message. Returns nothing — all output
 * goes through `ws.send`. This is the testable core of the websocket handler.
 */
export async function handleClientMessage(ctx: MessageContext, ws: any, msg: any): Promise<void> {
  const factory = ctx.sessionFactory ?? defaultSessionFactory;
  const readClaude = ctx.readClaudeHistory ?? readHistory;
  const readCursor = ctx.readCursorHistory ?? readCursorHistory;

  if (msg.type === "spawn") {
    if (!ctx.availableCLIs[msg.cli]) {
      ws.send(JSON.stringify({ type: "error", message: `CLI not available: ${msg.cli}` }));
      return;
    }
    if (!ctx.projects.includes(msg.project)) {
      ws.send(JSON.stringify({ type: "error", message: `Project not in allowed list: ${msg.project}` }));
      return;
    }
    const session = factory.create(ws, msg.cli, ctx.availableCLIs[msg.cli]!, msg.project, msg.mode);
    ctx.activeSessions.set(session.id, session);
    ws.send(JSON.stringify({ type: "spawned", session: session.summary }));
    return;
  }

  if (msg.type === "resume") {
    const session = msg.isClaudeSession
      ? factory.fromClaudeSession(ws, msg.sessionId, msg.project ?? process.cwd(), ctx.availableCLIs["claude"] ?? "claude")
      : msg.isCursorSession
        ? factory.fromCursorSession(ws, msg.sessionId, msg.project ?? process.cwd(), ctx.availableCLIs["cursor"] ?? "agent")
        : factory.resume(ws, msg.sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: `Session not found: ${msg.sessionId}` }));
      return;
    }
    ctx.activeSessions.set(session.id, session);
    ws.send(JSON.stringify({ type: "resumed", session: session.summary }));
    // Read history async — don't block the event loop on large JSONL files
    const historyId = msg.isClaudeSession ? msg.sessionId : session.summary.cliSessionId;
    if (historyId) {
      setImmediate(async () => {
        try {
          const history = msg.isCursorSession ? readCursor(historyId) : readClaude(historyId);
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
    const session = ctx.activeSessions.get(msg.sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: `No active session: ${msg.sessionId}` }));
      return;
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
