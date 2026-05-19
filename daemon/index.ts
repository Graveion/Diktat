import { loadConfig } from "./config";
import { getTailscaleIP } from "./tailscale";

const config = loadConfig();
const tailscaleIP = getTailscaleIP();

if (!tailscaleIP) {
  console.error("No Tailscale interface found. Is Tailscale running?");
  process.exit(1);
}

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
      ws.send(JSON.stringify({ type: "connected", message: "Diktat daemon ready" }));
    },
    message(ws, data) {
      console.log("Received:", data);
      ws.send(JSON.stringify({ type: "echo", message: data }));
    },
    close() {
      console.log("Client disconnected");
    },
  },
});

console.log(`Diktat daemon listening on ws://${tailscaleIP}:${config.port}`);
console.log(`Projects: ${config.projects.join(", ") || "none configured"}`);
