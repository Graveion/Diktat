import { getTailscaleIP } from "./tailscale";
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

const tailscaleIP = getTailscaleIP();
if (!tailscaleIP) {
  console.error("No Tailscale interface found.");
  process.exit(1);
}

const port = process.argv[2] ?? "9000";
const ws = new WebSocket(`ws://${tailscaleIP}:${port}`);

ws.onopen = () => console.log(`Connected to ws://${tailscaleIP}:${port}\n`);

ws.onerror = () => {
  console.error("Connection failed — is the daemon running?");
  process.exit(1);
};

ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === "connected") {
    const { clis, projects, sessions } = msg;

    // Pick CLI
    console.log("Available CLIs:");
    clis.forEach((c: string, i: number) => console.log(`  ${i + 1}. ${c}`));
    const cliIdx = parseInt(await ask("Select CLI (number): ")) - 1;
    const cli = clis[cliIdx] ?? clis[0];

    // Pick session or new
    let sessionId: string | null = null;

    if (sessions.length > 0) {
      console.log("\nExisting sessions:");
      console.log("  0. Start new session");
      sessions.forEach((s: any, i: number) =>
        console.log(`  ${i + 1}. [${s.cli}] ${s.project} — ${new Date(s.lastActiveAt).toLocaleString()}`)
      );
      const sessionChoice = parseInt(await ask("Select session (0 for new): "));
      if (sessionChoice > 0 && sessions[sessionChoice - 1]) {
        sessionId = sessions[sessionChoice - 1].id;
      }
    }

    if (sessionId) {
      ws.send(JSON.stringify({ type: "resume", sessionId }));
    } else {
      console.log("\nAvailable projects:");
      projects.forEach((p: string, i: number) => console.log(`  ${i + 1}. ${p}`));
      const projIdx = parseInt(await ask("Select project (number): ")) - 1;
      const project = projects[projIdx] ?? projects[0];
      ws.send(JSON.stringify({ type: "spawn", cli, project }));
    }
    return;
  }

  if (msg.type === "spawned" || msg.type === "resumed") {
    const session = msg.session;
    console.log(`\n${msg.type === "resumed" ? "Resumed" : "Started"} session: ${session.id}`);
    console.log(`CLI: ${session.cli} | Project: ${session.project}\n`);
    await promptAndSend(session.id);
    return;
  }

  if (msg.type === "output") {
    process.stdout.write(msg.text);
    return;
  }

  if (msg.type === "exit") {
    console.log(`\n[exit code ${msg.code}]\n`);
    await promptAndSend(currentSessionId!);
    return;
  }

  if (msg.type === "error") {
    console.error(`Error: ${msg.message}`);
    process.exit(1);
  }
};

let currentSessionId: string | null = null;

async function promptAndSend(sessionId: string) {
  currentSessionId = sessionId;
  const text = await ask("You: ");
  if (text.trim().toLowerCase() === "/exit") {
    console.log("Bye.");
    rl.close();
    ws.close();
    process.exit(0);
  }
  ws.send(JSON.stringify({ type: "input", sessionId, text }));
}
