import { loadConfig } from "./config";
import { getTailscaleIP } from "./tailscale";
import { detectCLIs } from "./cli-detector";
import { Session } from "./session";

const config = loadConfig();
const tailscaleIP = getTailscaleIP();

if (!tailscaleIP) {
  console.error("No Tailscale interface found. Is Tailscale running?");
  process.exit(1);
}

const availableCLIs = await detectCLIs();
console.log(`Available CLIs: ${Object.keys(availableCLIs).join(", ") || "none found"}`);

const sessions = new Map<string, Session>();

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
      ws.send(JSON.stringify({ type: "connected", clis: Object.keys(availableCLIs), projects: config.projects }));
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
        const id = crypto.randomUUID();
        sessions.set(id, new Session(ws, msg.cli, msg.project));
        ws.send(JSON.stringify({ type: "spawned", sessionId: id }));
        return;
      }

      if (msg.type === "input") {
        const session = sessions.get(msg.sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: `No session: ${msg.sessionId}` }));
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

console.log(`Diktat daemon listening on ws://${tailscaleIP}:${config.port}`);
console.log(`Projects: ${config.projects.join(", ") || "none configured"}`);
