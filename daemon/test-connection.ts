import { getTailscaleIP } from "./tailscale";

const tailscaleIP = getTailscaleIP();

if (!tailscaleIP) {
  console.error("No Tailscale interface found. Is Tailscale running?");
  process.exit(1);
}

const port = process.argv[2] ?? "9000";
const url = `ws://${tailscaleIP}:${port}`;

console.log(`Connecting to ${url}`);

const ws = new WebSocket(url);

ws.onopen = () => {
  console.log("Connected to daemon");
  ws.send(JSON.stringify({ type: "ping", message: "hello" }));
};

ws.onmessage = (event) => {
  console.log("Received:", event.data);
  ws.close();
  process.exit(0);
};

ws.onerror = () => {
  console.error("Connection failed - is the daemon running?");
  process.exit(1);
};
