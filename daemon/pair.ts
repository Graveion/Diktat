import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { hostname } from "os";
import qrcode from "qrcode-terminal";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `diktat pair <code>` — redeem a pairing code shown in the phone app for a
 * per-machine daemon token, and write a relay-mode config.json.
 *
 * Usage:
 *   bun pair.ts <code> [--relay <wss-url>] [--name <machine name>]
 *
 * The relay URL is taken from --relay, else an existing config.json, else
 * $DIKTAT_RELAY_URL. The machineId is reused from config.json if present
 * (so re-pairing keeps the same identity), otherwise a fresh UUID is minted.
 */

const CONFIG_PATH = "./config.json";

// Hosted relay. Overridable via --relay or $DIKTAT_RELAY_URL (e.g. a dev tunnel).
const DEFAULT_RELAY_URL = "wss://diktat-relay.fly.dev";

export interface PairArgs {
  code: string;
  relayUrl?: string;
  name?: string;
}

/** Parse argv (already sliced past `node script`). */
export function parsePairArgs(argv: string[]): PairArgs {
  let code = "";
  let relayUrl: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--relay") relayUrl = argv[++i];
    else if (a === "--name") name = argv[++i];
    else if (!a.startsWith("--") && !code) code = a;
  }
  return { code, relayUrl, name };
}

/** The pairing endpoint is HTTP; convert a ws/wss relay URL to http/https. */
export function relayHttpBase(relayUrl: string): string {
  return relayUrl
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:")
    .replace(/\/$/, "");
}

/** Merge a successful pairing into the existing config as a relay-mode config. */
export function buildPairedConfig(
  existing: Record<string, unknown>,
  p: { relayUrl: string; machineId: string; daemonToken: string },
): Record<string, unknown> {
  return {
    ...existing,
    port: (existing.port as number) ?? 9000,
    projects: (existing.projects as string[]) ?? [],
    mode: "relay",
    relayUrl: p.relayUrl,
    machineId: p.machineId,
    daemonToken: p.daemonToken,
  };
}

interface PairResponse {
  daemonToken?: string;
  machineId?: string;
  accountId?: string;
  error?: string;
}

async function main() {
  // `diktat pair`         → QR flow (default): show a QR, the app scans it.
  // `diktat pair <code>`  → typed-code redemption (code shown in the app).
  const args = parsePairArgs(process.argv.slice(2));

  const existing: Record<string, unknown> = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
    : {};

  const relayUrl =
    args.relayUrl ??
    (existing.relayUrl as string | undefined) ??
    process.env.DIKTAT_RELAY_URL ??
    DEFAULT_RELAY_URL;

  const machineId = (existing.machineId as string | undefined) ?? crypto.randomUUID();
  const name = args.name ?? hostname();

  const base = relayHttpBase(relayUrl);
  const token = args.code
    ? await pairWithCode(base, args.code, machineId, name)
    : await pairWithQr(base, machineId, name);

  const config = buildPairedConfig(existing, { relayUrl, machineId, daemonToken: token });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600); // mode option only applies on create

  console.log(`\n✓ Paired. Wrote relay config to daemon/config.json`);
  console.log(`  Machine: ${name} (${machineId})`);
  // The `diktat` CLI (re)starts the daemon after this returns; when pair.ts is
  // run directly via `bun pair.ts`, start the daemon yourself with `diktat start`.
}

/** Typed-code fallback: redeem a code the phone displayed. */
async function pairWithCode(base: string, code: string, machineId: string, name: string): Promise<string> {
  console.log(`Pairing "${name}"…`);
  let res: Response;
  try {
    res = await fetch(`${base}/pair/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, machineId, name }),
    });
  } catch (e) {
    console.error(`Could not reach the relay: ${(e as Error).message}`);
    process.exit(1);
  }
  const body = (await res.json().catch(() => ({}))) as PairResponse;
  if (!res.ok || !body.daemonToken) {
    console.error(`Pairing failed (${res.status}): ${body.error ?? "unknown error"}`);
    process.exit(1);
  }
  return body.daemonToken;
}

/** QR flow: register a pending pairing, show a QR, poll until the phone claims it. */
async function pairWithQr(base: string, machineId: string, name: string): Promise<string> {
  let nonce: string;
  try {
    const res = await fetch(`${base}/pair/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, name }),
    });
    const body = (await res.json().catch(() => ({}))) as { nonce?: string; error?: string };
    if (!res.ok || !body.nonce) {
      console.error(`Could not start pairing (${res.status}): ${body.error ?? "unknown error"}`);
      process.exit(1);
    }
    nonce = body.nonce;
  } catch (e) {
    console.error(`Could not reach the relay: ${(e as Error).message}`);
    process.exit(1);
  }

  console.log(`\nIn the Diktat app, tap “Pair a machine” and scan this:\n`);
  qrcode.generate(`diktat://pair?n=${nonce}`, { small: true });
  console.log(`\nWaiting for the app to scan…  (expires in 5 min, Ctrl-C to cancel)\n`);

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const res = await fetch(`${base}/pair/poll?nonce=${encodeURIComponent(nonce)}`);
      const body = (await res.json().catch(() => ({}))) as { status?: string; daemonToken?: string };
      if (body.status === "claimed" && body.daemonToken) return body.daemonToken;
      if (body.status === "expired") {
        console.error("Pairing expired. Run `diktat pair` again.");
        process.exit(1);
      }
    } catch {
      /* transient — keep polling */
    }
  }
  console.error("Timed out waiting for the app. Run `diktat pair` again.");
  process.exit(1);
}

// Only run when invoked directly, not when imported by tests.
if (import.meta.main) {
  main();
}
