import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig } from "./config";
import { getTailscaleIP } from "./tailscale";
import { detectCLIs } from "./cli-detector";
import { Session } from "./session";
import { listSessions } from "./session-store";
import { listClaudeSessions, claudeSessionExists, readHistory } from "./claude-sessions";
import { listCursorSessions, readCursorHistory } from "./cursor-sessions";
import { cursorShellPermissionGranted, grantCursorShellPermission } from "./cursor-shell-permissions";

const config = loadConfig();
const tailscaleIP = getTailscaleIP();

if (!tailscaleIP) {
  console.error("No Tailscale interface found. Is Tailscale running?");
  process.exit(1);
}

const availableCLIs = await detectCLIs();

// On first startup (no cli-config.json yet), auto-create it with Shell(*).
// If the file already exists we leave it alone — the user may have custom entries.
// They can add Shell(*) themselves or re-run `diktat setup`.
if (availableCLIs["cursor"] && !cursorShellPermissionGranted()) {
  const configPath = join(homedir(), ".cursor", "cli-config.json");
  if (!existsSync(configPath)) {
    grantCursorShellPermission();
    console.log("[cursor] Created ~/.cursor/cli-config.json with Shell(*) permission");
  } else {
    console.warn("[cursor] Shell(*) not set in ~/.cursor/cli-config.json — cursor sessions may have limited shell access. Run `diktat setup` to configure.");
  }
}

const activeSessions = new Map<string, Session>();
const clientPushTokens = new WeakMap<object, string>();

async function handleMessage(ws: any, msg: any): Promise<void> {
  if (msg.type === "spawn") {
    if (!availableCLIs[msg.cli]) {
      ws.send(JSON.stringify({ type: "error", message: `CLI not available: ${msg.cli}` }));
      return;
    }
    if (!config.projects.includes(msg.project)) {
      ws.send(JSON.stringify({ type: "error", message: `Project not in allowed list: ${msg.project}` }));
      return;
    }
    const session = Session.create(ws, msg.cli, availableCLIs[msg.cli]!, msg.project, msg.mode);
    activeSessions.set(session.id, session);
    ws.send(JSON.stringify({ type: "spawned", session: session.summary }));
    return;
  }

  if (msg.type === "resume") {
    const session = msg.isClaudeSession
      ? Session.fromClaudeSession(ws, msg.sessionId, msg.project ?? process.cwd(), availableCLIs["claude"] ?? "claude")
      : msg.isCursorSession
        ? Session.fromCursorSession(ws, msg.sessionId, msg.project ?? process.cwd(), availableCLIs["cursor"] ?? "agent")
        : Session.resume(ws, msg.sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: `Session not found: ${msg.sessionId}` }));
      return;
    }
    activeSessions.set(session.id, session);
    ws.send(JSON.stringify({ type: "resumed", session: session.summary }));
    // Read history async — don't block the event loop on large JSONL files
    const historyId = msg.isClaudeSession ? msg.sessionId : session.summary.cliSessionId;
    if (historyId) {
      setImmediate(async () => {
        try {
          const history = msg.isCursorSession
            ? readCursorHistory(historyId)
            : readHistory(historyId);
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
    const session = activeSessions.get(msg.sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: `No active session: ${msg.sessionId}` }));
      return;
    }
    const pushToken = clientPushTokens.get(ws as object);
    try {
      await session.send(msg.text, pushToken);
    } catch (e) {
      console.error("Error in session.send:", e);
      try { ws.send(JSON.stringify({ type: "error", message: `Session error: ${(e as Error).message}` })); } catch {}
    }
    return;
  }

  if (msg.type === "cancel") {
    const session = activeSessions.get(msg.sessionId);
    if (session) {
      session.cancel();
      ws.send(JSON.stringify({ type: "exit", code: -1 }));
    }
    return;
  }

  if (msg.type === "register_push") {
    if (msg.token) clientPushTokens.set(ws as object, msg.token);
    return;
  }

  if (msg.type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
    return;
  }
}

const server = Bun.serve({
  port: config.port,
  hostname: tailscaleIP,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("Diktat daemon running", { status: 200 });
  },
  websocket: {
    idleTimeout: 960,
    open(ws) {
      console.log(`[${new Date().toISOString()}] [WS] Client connected`);
      try {
        ws.send(JSON.stringify({
          type: "connected",
          clis: Object.keys(availableCLIs),
          projects: config.projects,
          sessions: listSessions().filter((s) => !s.cliSessionId || claudeSessionExists(s.cliSessionId)),
          claudeSessions: listClaudeSessions(),
          cursorSessions: listCursorSessions(),
        }));
      } catch (e) {
        console.error("Error building connected message:", e);
        ws.send(JSON.stringify({
          type: "connected",
          clis: Object.keys(availableCLIs),
          projects: config.projects,
          sessions: [],
          claudeSessions: [],
          cursorSessions: [],
        }));
      }
    },
    message(ws, data) {
      let msg: any;
      try {
        msg = JSON.parse(data as string);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
        return;
      }
      handleMessage(ws, msg).catch((e) => {
        console.error("Unhandled error in message handler:", e);
        try { ws.send(JSON.stringify({ type: "error", message: "Internal error" })); } catch {}
      });
    },
    close(ws) {
      console.log(`[${new Date().toISOString()}] [WS] Client disconnected`);
    },
  },
});

console.log(`\n── Diktat daemon ready ──────────────────`);
console.log(`  CLIs:     ${Object.keys(availableCLIs).join(", ") || "none found"}`);
console.log(`  Projects: ${config.projects.join(", ") || "none configured"}`);
console.log(`  Address:  ws://${tailscaleIP}:${config.port}`);
console.log(`  Run 'diktat qr' to show connection QR`);
console.log(`─────────────────────────────────────────\n`);
