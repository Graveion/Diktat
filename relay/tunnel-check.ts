/**
 * Validates the PUBLIC relay path: a phone connecting over the internet
 * (through a cloudflared tunnel) → relay → daemon agent leg.
 *
 * Assumes the relay is already running locally on RELAY_LOCAL and a tunnel
 * exposes it at RELAY_PUBLIC. Uses the SAFE fake daemon (no real Shell) so we
 * never expose a real Shell(*) daemon to the internet during a test.
 *
 *   RELAY_LOCAL=ws://localhost:9099 RELAY_PUBLIC=wss://xxx.trycloudflare.com \
 *     bun relay/tunnel-check.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { startRelayClient } from "../daemon/relay-client.ts";
import type { MessageContext } from "../daemon/message-handler.ts";

const RELAY_LOCAL = process.env.RELAY_LOCAL ?? "ws://localhost:9099";
const RELAY_PUBLIC = process.env.RELAY_PUBLIC; // wss://...trycloudflare.com
const MACHINE = "dev-mac";

if (!RELAY_PUBLIC) { console.error("Set RELAY_PUBLIC=wss://… (the tunnel URL)"); process.exit(2); }

const cfg = JSON.parse(readFileSync(join(import.meta.dir, "relay-config.json"), "utf-8"));
const daemonToken = cfg.machines[MACHINE].daemonToken;
const accountToken = Object.keys(cfg.accountTokens)[0];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };

async function main() {
  // Fake daemon dials the relay agent leg over localhost (same machine in dev).
  const ctx: MessageContext = {
    availableCLIs: {} as any, projects: ["/tmp"],
    activeSessions: new Map() as any, clientPushTokens: new WeakMap() as any,
  };
  const daemon = startRelayClient({
    ctx, relayUrl: RELAY_LOCAL, machineId: MACHINE, daemonToken, enablePing: false,
  });
  await sleep(700);

  // Phone connects over the PUBLIC tunnel URL. (Guarded above with process.exit.)
  const url = `${RELAY_PUBLIC!.replace(/\/$/, "")}/client?machineId=${MACHINE}`;
  console.log(`  phone → ${url}`);
  const frames: any[] = [];
  let opened = false;
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${accountToken}` } } as any);
  ws.onopen = () => { opened = true; };
  ws.onmessage = (e: any) => { try { frames.push(JSON.parse(e.data)); } catch {} };

  const waitFor = async (pred: (f: any) => boolean, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (frames.some(pred)) return true; await sleep(50); }
    return false;
  };

  check("phone connects over the public tunnel", await waitFor(() => opened || frames.length > 0) || opened);
  check("receives `connected` payload through the tunnel", await waitFor((f) => f.type === "connected"));
  ws.send(JSON.stringify({ type: "ping" }));
  check("ping round-trips to pong over the tunnel", await waitFor((f) => f.type === "pong"));

  try { ws.close(); } catch {}
  daemon.stop();
  console.log(`\nTunnel check: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
