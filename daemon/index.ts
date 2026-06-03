import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig } from "./config";
import { getTailscaleIP } from "./tailscale";
import { detectCLIs } from "./cli-detector";
import { Session } from "./session";
import { listSessions } from "./session-store";
import { listClaudeSessions, claudeSessionExists } from "./claude-sessions";
import { listCursorSessions } from "./cursor-sessions";
import { cursorShellPermissionGranted, grantCursorShellPermission } from "./cursor-shell-permissions";
import { handleClientMessage, type MessageContext } from "./message-handler";

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

const messageContext: MessageContext = {
  availableCLIs,
  projects: config.projects,
  activeSessions,
  clientPushTokens,
};

function handleMessage(ws: any, msg: any): Promise<void> {
  return handleClientMessage(messageContext, ws, msg);
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
