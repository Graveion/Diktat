import { loadConfig } from "./config";
import { getTailscaleIP } from "./tailscale";
import { detectCLIs } from "./cli-detector";
import { Session } from "./session";
import { listSessions } from "./session-store";
import { listClaudeSessions } from "./claude-sessions";
import qrcode from "qrcode-terminal";

const config = loadConfig();
const tailscaleIP = getTailscaleIP();

if (!tailscaleIP) {
  console.error("No Tailscale interface found. Is Tailscale running?");
  process.exit(1);
}

const availableCLIs = await detectCLIs();

const activeSessions = new Map<string, Session>();

const server = Bun.serve({
  port: config.port,
  hostname: tailscaleIP,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("Diktat daemon running", { status: 200 });
  },
  websocket: {
    open(ws) {
      console.log("Client connected");
      ws.send(JSON.stringify({
        type: "connected",
        clis: Object.keys(availableCLIs),
        projects: config.projects,
        sessions: listSessions(),
        claudeSessions: listClaudeSessions(),
      }));
    },
    message(ws, data) {
      const msg = JSON.parse(data as string);

      if (msg.type === "spawn") {
        if (!availableCLIs[msg.cli]) {
          ws.send(JSON.stringify({ type: "error", message: `CLI not available: ${msg.cli}` }));
          return;
        }
        if (!config.projects.includes(msg.project)) {
          ws.send(JSON.stringify({ type: "error", message: `Project not in allowed list: ${msg.project}` }));
          return;
        }
        const session = Session.create(ws, msg.cli, msg.project);
        activeSessions.set(session.id, session);
        ws.send(JSON.stringify({ type: "spawned", session: session.summary }));
        return;
      }

      if (msg.type === "resume") {
        const session = msg.isClaudeSession
          ? Session.fromClaudeSession(ws, msg.sessionId, msg.project ?? process.cwd())
          : Session.resume(ws, msg.sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: `Session not found: ${msg.sessionId}` }));
          return;
        }
        activeSessions.set(session.id, session);
        ws.send(JSON.stringify({ type: "resumed", session: session.summary }));
        return;
      }

      if (msg.type === "input") {
        const session = activeSessions.get(msg.sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: `No active session: ${msg.sessionId}` }));
          return;
        }
        session.send(msg.text);
        return;
      }
    },
    close(ws) {
      console.log("Client disconnected");
    },
  },
});

const connectionUrl = `diktat://${tailscaleIP}:${config.port}`;

console.log(`\n── Diktat daemon ready ──────────────────`);
console.log(`  CLIs:     ${Object.keys(availableCLIs).join(", ") || "none found"}`);
console.log(`  Projects: ${config.projects.join(", ") || "none configured"}`);
console.log(`  Address:  ws://${tailscaleIP}:${config.port}`);
console.log(`─────────────────────────────────────────\n`);
console.log(`Scan to connect with Diktat app:\n`);
qrcode.generate(connectionUrl, { small: true });
console.log(`  ${connectionUrl}\n`);
