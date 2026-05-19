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
let sessionId: string | null = null;

ws.onopen = () => console.log("Connected");

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  console.log("←", JSON.stringify(msg));

  if (msg.type === "connected") {
    console.log(`Available CLIs: ${msg.clis.join(", ")}`);
    console.log(`Projects: ${msg.projects.join(", ")}`);
    if (msg.clis.includes("claude") && msg.projects.length > 0) {
      ws.send(JSON.stringify({ type: "spawn", cli: "claude", project: msg.projects[0] }));
    } else {
      console.log("No CLI or project available to test with");
      ws.close();
    }
    return;
  }

  if (msg.type === "spawned") {
    sessionId = msg.sessionId;
    console.log(`Session spawned: ${sessionId}`);
    ws.send(JSON.stringify({ type: "input", sessionId, text: "say hello in one word" }));
    return;
  }

  if (msg.type === "exit") {
    console.log(`Process exited with code ${msg.code}`);
    ws.close();
    process.exit(0);
  }
};

ws.onerror = () => {
  console.error("Connection failed - is the daemon running?");
  process.exit(1);
};
