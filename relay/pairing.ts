import { randomBytes } from "node:crypto";
import { sha256hex } from "./supabase-auth.ts";

/**
 * Pairing (RELAY.md §pairing / supabase/README.md).
 *
 * Flow:
 *   1. Phone (signed in) inserts a `pairing_codes` row for itself (Supabase RLS)
 *      and shows the short code.
 *   2. User runs `diktat pair <code>` on the Mac. The daemon POSTs to the relay
 *      `/pair/complete` with { code, machineId, name }.
 *   3. The relay (service role) validates the code, mints a per-machine daemon
 *      token, stores its sha256 in `machines.token_hash`, consumes the code, and
 *      returns the PLAINTEXT token once. The daemon writes it to its config.
 *
 * `/pair/complete` is unauthenticated by design — the daemon has no token yet.
 * The short-lived, single-use code IS the bearer secret. Guards: code must be
 * unconsumed + unexpired, and a machineId already owned by another account can
 * never be re-paired (anti-hijack). Rate-limiting is a Phase-1 TODO.
 */

export interface PairingCodeRow {
  accountId: string;
  expiresAt: string; // ISO timestamp
  consumedAt: string | null;
}

export interface PairingRequest {
  code: string;
  machineId: string;
  name?: string;
}

export type PairingResult =
  | { ok: true; daemonToken: string; machineId: string; accountId: string }
  | { ok: false; status: number; error: string };

/** Injectable IO so the pairing decision is unit-tested without network. */
export interface PairingDeps {
  getPairingCode(code: string): Promise<PairingCodeRow | null>;
  /** Existing machine's owner, or null if the machineId is unknown. */
  getMachineAccount(machineId: string): Promise<string | null>;
  /** Insert-or-update the machine row (id, account, name, token_hash). */
  upsertMachine(row: {
    id: string;
    accountId: string;
    name: string;
    tokenHash: string;
  }): Promise<void>;
  /** Mark the code consumed and bind it to the machine it created. */
  consumePairingCode(code: string, machineId: string): Promise<void>;
  /** Generate a fresh plaintext daemon token. */
  generateToken(): string;
  /** Current time in ms (injectable for tests). */
  now(): number;
}

/** Pure pairing decision over injectable IO. */
export async function completePairing(
  deps: PairingDeps,
  req: PairingRequest,
): Promise<PairingResult> {
  const code = req.code?.trim();
  const machineId = req.machineId?.trim();
  if (!code) return { ok: false, status: 400, error: "missing code" };
  if (!machineId) return { ok: false, status: 400, error: "missing machineId" };

  const row = await deps.getPairingCode(code);
  if (!row) return { ok: false, status: 404, error: "invalid code" };
  if (row.consumedAt) return { ok: false, status: 409, error: "code already used" };
  if (deps.now() > Date.parse(row.expiresAt))
    return { ok: false, status: 410, error: "code expired" };

  // Anti-hijack: never re-point a machine owned by a different account.
  const existingOwner = await deps.getMachineAccount(machineId);
  if (existingOwner !== null && existingOwner !== row.accountId)
    return { ok: false, status: 409, error: "machine already paired to another account" };

  const token = deps.generateToken();
  await deps.upsertMachine({
    id: machineId,
    accountId: row.accountId,
    name: req.name?.trim() || "My Mac",
    tokenHash: sha256hex(token),
  });
  await deps.consumePairingCode(code, machineId);

  return { ok: true, daemonToken: token, machineId, accountId: row.accountId };
}

/** A 256-bit hex token. */
export function generateDaemonToken(): string {
  return randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// QR (device-authorization) pairing.
//
//   1. Daemon → POST /pair/init { machineId, name }  → { nonce }  (unauth)
//      Daemon prints a QR encoding the nonce, then polls /pair/poll.
//   2. Phone scans → POST /pair/claim { nonce } + account JWT     (authed)
//      Relay binds a machine to the account, mints the daemon token.
//   3. Daemon GET /pair/poll?nonce=…  → { status:"claimed", daemonToken }
//
// The nonce is the rendezvous secret (shown only on the user's own Mac); the
// account JWT on /claim is the authorization. Single relay instance holds the
// pending map in memory (Tier 0).
// ---------------------------------------------------------------------------

export interface PendingPairing {
  machineId: string;
  name: string;
  createdAt: number;
  status: "pending" | "claimed";
  daemonToken?: string;
}

export class PairingStore {
  private readonly map = new Map<string, PendingPairing>();

  constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
    private readonly genNonce: () => string = () => randomBytes(9).toString("base64url"),
  ) {}

  /** Register a pending pairing for a machine; returns the nonce to show as a QR. */
  init(machineId: string, name: string): string {
    this.sweep();
    const nonce = this.genNonce();
    this.map.set(nonce, { machineId, name, createdAt: this.now(), status: "pending" });
    return nonce;
  }

  /** Get a live (unexpired) entry, or null. */
  get(nonce: string): PendingPairing | null {
    const p = this.map.get(nonce);
    if (!p) return null;
    if (this.now() - p.createdAt > this.ttlMs) {
      this.map.delete(nonce);
      return null;
    }
    return p;
  }

  /** Attach a minted token to a pending entry. Returns false if missing/already claimed. */
  markClaimed(nonce: string, daemonToken: string): boolean {
    const p = this.get(nonce);
    if (!p || p.status === "claimed") return false;
    p.status = "claimed";
    p.daemonToken = daemonToken;
    return true;
  }

  /** One-time read of a claimed entry's token (deletes it). */
  take(nonce: string): { daemonToken: string; machineId: string } | null {
    const p = this.get(nonce);
    if (!p || p.status !== "claimed" || !p.daemonToken) return null;
    this.map.delete(nonce);
    return { daemonToken: p.daemonToken, machineId: p.machineId };
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.map) if (v.createdAt < cutoff) this.map.delete(k);
  }
}

export type ClaimResult =
  | { ok: true; machineId: string }
  | { ok: false; status: number; error: string };

/**
 * Claim a pending pairing for an authenticated account: anti-hijack check, mint
 * the daemon token, upsert the machine, and attach the token to the nonce so the
 * daemon's next poll receives it.
 */
export async function claimPairing(
  store: PairingStore,
  deps: PairingDeps,
  accountId: string,
  nonce: string,
): Promise<ClaimResult> {
  const p = store.get(nonce);
  if (!p) return { ok: false, status: 404, error: "pairing code expired or invalid" };
  if (p.status === "claimed") return { ok: false, status: 409, error: "already paired" };

  const existingOwner = await deps.getMachineAccount(p.machineId);
  if (existingOwner !== null && existingOwner !== accountId)
    return { ok: false, status: 409, error: "machine already paired to another account" };

  const token = deps.generateToken();
  await deps.upsertMachine({
    id: p.machineId,
    accountId,
    name: p.name,
    tokenHash: sha256hex(token),
  });
  store.markClaimed(nonce, token);
  return { ok: true, machineId: p.machineId };
}

export interface PairingEnv {
  url: string;
  serviceKey: string;
}

/** Production deps: service-role PostgREST reads/writes. */
export function createPairingDeps(env: PairingEnv): PairingDeps {
  const base = env.url.replace(/\/$/, "");
  const headers = {
    apikey: env.serviceKey,
    Authorization: `Bearer ${env.serviceKey}`,
    "Content-Type": "application/json",
  };

  return {
    async getPairingCode(code) {
      const u =
        `${base}/rest/v1/pairing_codes?code=eq.${encodeURIComponent(code)}` +
        `&select=account_id,expires_at,consumed_at`;
      const res = await fetch(u, { headers });
      if (!res.ok) return null;
      const rows = (await res.json()) as Array<{
        account_id: string;
        expires_at: string;
        consumed_at: string | null;
      }>;
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return {
        accountId: rows[0].account_id,
        expiresAt: rows[0].expires_at,
        consumedAt: rows[0].consumed_at,
      };
    },

    async getMachineAccount(machineId) {
      const u =
        `${base}/rest/v1/machines?id=eq.${encodeURIComponent(machineId)}&select=account_id`;
      const res = await fetch(u, { headers });
      if (!res.ok) return null;
      const rows = (await res.json()) as Array<{ account_id: string }>;
      return rows[0]?.account_id ?? null;
    },

    async upsertMachine(row) {
      const res = await fetch(`${base}/rest/v1/machines`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          id: row.id,
          account_id: row.accountId,
          name: row.name,
          token_hash: row.tokenHash,
        }),
      });
      if (!res.ok) throw new Error(`upsertMachine failed: ${res.status} ${await res.text()}`);
    },

    async consumePairingCode(code, machineId) {
      const u = `${base}/rest/v1/pairing_codes?code=eq.${encodeURIComponent(code)}`;
      const res = await fetch(u, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          consumed_at: new Date().toISOString(),
          machine_id: machineId,
        }),
      });
      if (!res.ok) throw new Error(`consumePairingCode failed: ${res.status}`);
    },

    generateToken: generateDaemonToken,
    now: () => Date.now(),
  };
}
