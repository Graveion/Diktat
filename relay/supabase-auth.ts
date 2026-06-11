import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  CloseCode,
  constantTimeEqual,
  type AuthResult,
  type Authenticator,
} from "./broker.ts";

/**
 * Supabase-backed auth (RELAY.md §2, Phase 1).
 *
 *   Agent leg  — bearer is the per-machine daemon token. We sha256 it and
 *                constant-time match `machines.token_hash` (plaintext never stored).
 *   Client leg — bearer is the phone's Supabase access JWT. We verify it against
 *                the project JWKS (ES256), take `sub` as accountId, then enforce
 *                ownership: `machines[machineId].account_id === sub`.
 *
 * All IO goes through an injectable deps seam so the decision logic is unit
 * tested without network or jose.
 */

/** sha256(token) as lowercase hex — how daemon tokens are stored at rest. */
export function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface MachineRow {
  accountId: string;
  tokenHash: string;
}

export interface EntitlementRow {
  trial_started_at: string | null;
  comp_until: string | null;
  entitled_until: string | null; // written by RC webhook
}

/** ok=false → lookup error (fail closed). ok=true, row=null → no account_state row yet (first-time user, let through). */
export type EntitlementLookup =
  | { ok: true; row: EntitlementRow | null }
  | { ok: false };

/** Free-trial window. Must match the app's FREE_TRIAL_MS (useEntitlements.ts). */
export const TRIAL_MS = 24 * 60 * 60 * 1000; // 1 day

/**
 * Pure entitlement decision.
 * - lookup error (ok=false) → deny (fail closed)
 * - no row yet (ok=true, row=null) → allow (user hasn't started trial; app gates first use)
 * - has row → entitled if subscription active OR comp active OR within trial window
 */
export function isEntitled(lookup: EntitlementLookup): boolean {
  if (!lookup.ok) return false;
  if (!lookup.row) return true;
  const now = Date.now();
  const { entitled_until, comp_until, trial_started_at } = lookup.row;
  if (entitled_until && (entitled_until.startsWith("infinity") || new Date(entitled_until).getTime() > now)) return true;
  if (comp_until && (comp_until.startsWith("infinity") || new Date(comp_until).getTime() > now)) return true;
  if (trial_started_at && new Date(trial_started_at).getTime() + TRIAL_MS > now) return true;
  return false;
}

/** Injectable IO so the auth logic is testable without network/jose. */
export interface SupabaseAuthDeps {
  /** Verify a phone's Supabase access JWT; resolve accountId (`sub`) or null if invalid. */
  verifyAccountToken(token: string): Promise<string | null>;
  /** Fetch a machine row by id; null if not found. */
  getMachine(machineId: string): Promise<MachineRow | null>;
  /** Fetch entitlement state for an account; fail closed on error. */
  getEntitlement(accountId: string): Promise<EntitlementLookup>;
  /** Insert the account_state row with trial_started_at=now (never modifies an existing row). True on success. */
  startTrial(accountId: string): Promise<boolean>;
}

/** Build an Authenticator over the given IO deps (pure decision logic). */
export function makeSupabaseAuthenticator(deps: SupabaseAuthDeps): Authenticator {
  return async (leg, machineId, token): Promise<AuthResult> => {
    if (leg === "agent") {
      const machine = await deps.getMachine(machineId);
      if (!machine) return { ok: false, code: CloseCode.unauthorized };
      if (!constantTimeEqual(sha256hex(token), machine.tokenHash))
        return { ok: false, code: CloseCode.unauthorized };
      return { ok: true, accountId: machine.accountId };
    }

    // client leg
    const accountId = await deps.verifyAccountToken(token);
    if (accountId === null) return { ok: false, code: CloseCode.unauthorized };
    const machine = await deps.getMachine(machineId);
    if (!machine) return { ok: false, code: CloseCode.unknownMachine };
    if (machine.accountId !== accountId) return { ok: false, code: CloseCode.forbidden };
    const entResult = await deps.getEntitlement(accountId);
    if (!isEntitled(entResult)) return { ok: false, code: CloseCode.notEntitled };
    if (entResult.ok && entResult.row === null) {
      // First connection: start the trial server-side so a client that never
      // calls start_trial can't ride the no-row allowance forever. Tolerate
      // failure — this connection is allowed either way; the row lands next time.
      await deps.startTrial(accountId).catch(() => false);
    }
    return { ok: true, accountId };
  };
}

export interface SupabaseEnv {
  /** e.g. https://xxxx.supabase.co */
  url: string;
  /** service_role / secret key — bypasses RLS for the machine lookup. */
  serviceKey: string;
}

/**
 * Fire-and-forget `machines.last_seen_at = now` stamp. Called when a daemon's
 * agent leg authenticates (and on its keep-alive pings) so the app's online
 * indicator reflects recently-connected machines. Never throws.
 */
export function makeMachineToucher(env: SupabaseEnv): (machineId: string) => void {
  const base = env.url.replace(/\/$/, "");
  const headers = {
    apikey: env.serviceKey,
    Authorization: `Bearer ${env.serviceKey}`,
    "Content-Type": "application/json",
  };
  return (machineId) => {
    fetch(`${base}/rest/v1/machines?id=eq.${encodeURIComponent(machineId)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
    }).catch(() => {
      /* best-effort presence stamp */
    });
  };
}

/**
 * Production deps: ES256 JWT verification via the project JWKS, and a
 * service-role PostgREST read of the machines table.
 */
export function createSupabaseDeps(env: SupabaseEnv): SupabaseAuthDeps {
  const base = env.url.replace(/\/$/, "");
  const JWKS = createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`));
  const issuer = `${base}/auth/v1`;

  return {
    async verifyAccountToken(token) {
      try {
        const { payload } = await jwtVerify(token, JWKS, {
          issuer,
          audience: "authenticated",
        });
        return typeof payload.sub === "string" ? payload.sub : null;
      } catch {
        return null;
      }
    },

    async getMachine(machineId) {
      const u =
        `${base}/rest/v1/machines?id=eq.${encodeURIComponent(machineId)}` +
        `&select=account_id,token_hash`;
      let res: Response;
      try {
        res = await fetch(u, {
          headers: {
            apikey: env.serviceKey,
            Authorization: `Bearer ${env.serviceKey}`,
          },
        });
      } catch {
        return null; // transient network failure → treat as not found (auth fails closed)
      }
      if (!res.ok) return null;
      const rows = (await res.json()) as Array<{ account_id: string; token_hash: string }>;
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return { accountId: rows[0].account_id, tokenHash: rows[0].token_hash };
    },

    async getEntitlement(accountId) {
      const u = `${base}/rest/v1/account_state?account_id=eq.${encodeURIComponent(accountId)}&select=trial_started_at,comp_until,entitled_until`;
      try {
        const res = await fetch(u, {
          headers: { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` },
        });
        if (!res.ok) return { ok: false };
        const rows = (await res.json()) as Array<{
          trial_started_at: string | null;
          comp_until: string | null;
          entitled_until: string | null;
        }>;
        if (!Array.isArray(rows) || rows.length === 0) return { ok: true, row: null };
        return { ok: true, row: { trial_started_at: rows[0].trial_started_at, comp_until: rows[0].comp_until, entitled_until: rows[0].entitled_until } };
      } catch {
        return { ok: false }; // network error → fail closed
      }
    },

    async startTrial(accountId) {
      try {
        const res = await fetch(`${base}/rest/v1/account_state`, {
          method: "POST",
          headers: {
            apikey: env.serviceKey,
            Authorization: `Bearer ${env.serviceKey}`,
            "Content-Type": "application/json",
            Prefer: "resolution=ignore-duplicates", // existing row is never modified
          },
          body: JSON.stringify({ account_id: accountId, trial_started_at: new Date().toISOString() }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
