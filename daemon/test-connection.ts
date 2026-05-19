import { getTailscaleIP } from "./tailscale";
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

const exit = (code = 0) => { rl.close(); ws?.close(); process.exit(code); };
process.on("SIGINT", () => { console.log("\nBye."); exit(0); });

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
    const { clis, projects, sessions, claudeSessions } = msg;

    // Pick CLI
    console.log("Available CLIs:");
    clis.forEach((c: string, i: number) => console.log(`  ${i + 1}. ${c}`));
    const cliIdx = parseInt(await ask("Select CLI (number): ")) - 1;
    const cli = clis[cliIdx] ?? clis[0];

    // Combine daemon sessions + native Claude sessions
    const allSessions = [
      ...sessions.map((s: any) => ({ ...s, source: "daemon" })),
      ...claudeSessions.map((s: any) => ({ ...s, source: "claude", cli: "claude" })),
    ];

    let sessionId: string | null = null;
    let isClaudeSession = false;

    if (allSessions.length > 0) {
      console.log("\nSessions:");
      console.log("  0. Start new session");
      allSessions.forEach((s: any, i: number) => {
        const label = s.source === "claude"
          ? `[${s.projectLabel}] ${s.firstMessage.slice(0, 60)}…`
          : `[${s.cli}] ${s.project}`;
        console.log(`  ${i + 1}. ${label} — ${new Date(s.lastActiveAt).toLocaleString()}`);
      });
      const choice = parseInt(await ask("Select session (0 for new): "));
      if (choice > 0 && allSessions[choice - 1]) {
        const picked = allSessions[choice - 1];
        sessionId = picked.id;
        isClaudeSession = picked.source === "claude";
      }
    }

    if (sessionId) {
      const picked = allSessions.find((s: any) => s.id === sessionId);
      ws.send(JSON.stringify({ type: "resume", sessionId, isClaudeSession, project: picked?.project }));
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
  if (text.trim().toLowerCase() === "/exit") exit(0);
  ws.send(JSON.stringify({ type: "input", sessionId, text }));
}
