/**
 * End-to-end relay smoke test (Tier 0).
 *
 * Wires the REAL relay broker (subprocess) + the REAL daemon relay-client
 * (in-process) + a fake phone WebSocket, and asserts the full path:
 *   - daemon agent-leg registers,
 *   - phone client-leg authenticates + ownership-checks + pairs,
 *   - the daemon's `connected` payload reaches the phone (verbatim, daemon→phone),
 *   - a phone `ping` round-trips to `pong` (verbatim, phone→daemon→handler→phone),
 *   - a phone that does NOT own the machine is rejected,
 *   - dropping the daemon pushes `machine_offline` to the phone.
 *
 * Run:  bun relay/smoke.ts     (from repo root, or `bun smoke.ts` from relay/)
 * Not a *.test.ts so it stays out of the unit `bun test` run.
 */
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startRelayClient } from "../daemon/relay-client.ts";
import type { MessageContext } from "../daemon/message-handler.ts";

const PORT = 9099;
const RELAY_URL = `ws://localhost:${PORT}`;
const MACHINE = "machine-A";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fake phone: connect to the client leg with a bearer account token.
function phone(machineId: string, accountToken: string) {
  const url = `${RELAY_URL}/client?machineId=${encodeURIComponent(machineId)}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${accountToken}` } } as any);
  const frames: any[] = [];
  let opened = false;
  let closedCode: number | null = null;
  ws.onopen = () => { opened = true; };
  ws.onmessage = (e: any) => { try { frames.push(JSON.parse(e.data)); } catch {} };
  ws.onclose = (e: any) => { closedCode = e?.code ?? -1; };
  ws.onerror = () => {};
  return {
    ws, frames,
    get opened() { return opened; },
    get closedCode() { return closedCode; },
    waitFor: async (pred: (f: any) => boolean, ms = 2000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (frames.some(pred)) return true;
        await sleep(25);
      }
      return false;
    },
  };
}

async function main() {
  // 1) Temp relay registry: machine-A owned by acct-1.
  const dir = mkdtempSync(join(tmpdir(), "diktat-smoke-"));
  const cfgPath = join(dir, "relay-config.json");
  writeFileSync(cfgPath, JSON.stringify({
    machines: { [MACHINE]: { daemonToken: "dtoken-A", accountId: "acct-1" } },
    accountTokens: { "atoken-1": "acct-1", "atoken-2": "acct-2" },
  }));

  // 2) Start the real relay broker as a subprocess.
  const relayProc = Bun.spawn(["bun", "index.ts"], {
    cwd: import.meta.dir,
    env: { ...process.env, PORT: String(PORT), DIKTAT_RELAY_CONFIG: cfgPath },
    stdout: "pipe", stderr: "pipe",
  });
  await sleep(800); // let it bind

  // 3) Start the real daemon relay-client (agent leg) in-process.
  const ctx: MessageContext = {
    availableCLIs: {} as any,
    projects: ["/tmp"],
    activeSessions: new Map() as any,
    clientPushTokens: new WeakMap() as any,
  };
  const daemon = startRelayClient({
    ctx, relayUrl: RELAY_URL, machineId: MACHINE, daemonToken: "dtoken-A",
    enablePing: false,
  });
  await sleep(500); // let the agent leg register

  try {
    // 4) Phone (owner) connects → should pair and receive `connected`.
    const p = phone(MACHINE, "atoken-1");
    const gotConnected = await p.waitFor((f) => f.type === "connected");
    check("owner phone pairs and receives `connected` payload", gotConnected);
    check("`connected` carries expected fields", p.frames.some((f) =>
      f.type === "connected" && Array.isArray(f.projects) && Array.isArray(f.sessions)));

    // 5) ping → pong round-trip (verbatim both directions through the daemon).
    p.ws.send(JSON.stringify({ type: "ping" }));
    const gotPong = await p.waitFor((f) => f.type === "pong");
    check("phone ping round-trips to pong through the daemon", gotPong);

    // 6) Non-owner phone (acct-2) → must NOT pair (ownership 4403 / failed upgrade).
    const intruder = phone(MACHINE, "atoken-2");
    await sleep(800);
    const intruderConnected = intruder.frames.some((f) => f.type === "connected");
    check("non-owner phone is rejected (no `connected`)", !intruderConnected && !intruder.opened,
      `(opened=${intruder.opened}, frames=${intruder.frames.length})`);
    try { intruder.ws.close(); } catch {}

    // 7) Drop the daemon → owner phone should get machine_offline.
    daemon.stop();
    const gotOffline = await p.waitFor((f) => f._relay === true && f.type === "machine_offline", 3000);
    check("phone receives machine_offline when daemon drops", gotOffline);

    try { p.ws.close(); } catch {}
  } finally {
    daemon.stop();
    relayProc.kill();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nRelay smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
