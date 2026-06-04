import { existsSync, readFileSync, writeFileSync } from "fs";
import { hostname } from "os";

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
  const args = parsePairArgs(process.argv.slice(2));
  if (!args.code) {
    console.error("Usage: bun pair.ts <code> [--relay <wss-url>] [--name <machine name>]");
    process.exit(1);
  }

  const existing: Record<string, unknown> = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
    : {};

  const relayUrl =
    args.relayUrl ?? (existing.relayUrl as string | undefined) ?? process.env.DIKTAT_RELAY_URL;
  if (!relayUrl) {
    console.error("No relay URL. Pass --relay <wss-url> or set DIKTAT_RELAY_URL.");
    process.exit(1);
  }

  const machineId = (existing.machineId as string | undefined) ?? crypto.randomUUID();
  const name = args.name ?? hostname();

  console.log(`Pairing machine "${name}" (${machineId}) with ${relayUrl}…`);

  let res: Response;
  try {
    res = await fetch(`${relayHttpBase(relayUrl)}/pair/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: args.code, machineId, name }),
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

  const config = buildPairedConfig(existing, {
    relayUrl,
    machineId,
    daemonToken: body.daemonToken,
  });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  console.log(`\n✓ Paired. Wrote relay config to daemon/config.json`);
  console.log(`  Machine: ${name} (${machineId})`);
  console.log(`\n  Run 'bun start' to connect via the relay.\n`);
}

// Only run when invoked directly, not when imported by tests.
if (import.meta.main) {
  main();
}
