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

/** Injectable IO so the auth logic is testable without network/jose. */
export interface SupabaseAuthDeps {
  /** Verify a phone's Supabase access JWT; resolve accountId (`sub`) or null if invalid. */
  verifyAccountToken(token: string): Promise<string | null>;
  /** Fetch a machine row by id; null if not found. */
  getMachine(machineId: string): Promise<MachineRow | null>;
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
  };
}
