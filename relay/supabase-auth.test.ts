import { describe, expect, it } from "bun:test";
import { CloseCode } from "./broker.ts";
import {
  isEntitled,
  makeSupabaseAuthenticator,
  sha256hex,
  type MachineRow,
  type SupabaseAuthDeps,
} from "./supabase-auth.ts";

const ACCT = "acct-uuid-1";
const OTHER_ACCT = "acct-uuid-2";
const MACHINE = "machine-A";
const DAEMON_TOKEN = "super-secret-daemon-token";

function deps(over: Partial<SupabaseAuthDeps> = {}): SupabaseAuthDeps {
  const machine: MachineRow = { accountId: ACCT, tokenHash: sha256hex(DAEMON_TOKEN) };
  return {
    verifyAccountToken: async (t) => (t === "good-jwt" ? ACCT : null),
    getMachine: async (id) => (id === MACHINE ? machine : null),
    getEntitlement: async (_accountId) => ({ ok: true, row: null }),
    ...over,
  };
}

describe("sha256hex", () => {
  it("is stable and 64 hex chars", () => {
    expect(sha256hex("x")).toBe(sha256hex("x"));
    expect(sha256hex("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256hex("a")).not.toBe(sha256hex("b"));
  });
});

describe("agent leg", () => {
  it("accepts the correct daemon token", async () => {
    const auth = makeSupabaseAuthenticator(deps());
    expect(await auth("agent", MACHINE, DAEMON_TOKEN)).toEqual({ ok: true, accountId: ACCT });
  });

  it("rejects a wrong daemon token (4401)", async () => {
    const auth = makeSupabaseAuthenticator(deps());
    expect(await auth("agent", MACHINE, "wrong")).toEqual({ ok: false, code: CloseCode.unauthorized });
  });

  it("rejects an unknown machine (4401)", async () => {
    const auth = makeSupabaseAuthenticator(deps());
    expect(await auth("agent", "nope", DAEMON_TOKEN)).toEqual({ ok: false, code: CloseCode.unauthorized });
  });
});

describe("client leg", () => {
  it("accepts a valid JWT for the owner", async () => {
    const auth = makeSupabaseAuthenticator(deps());
    expect(await auth("client", MACHINE, "good-jwt")).toEqual({ ok: true, accountId: ACCT });
  });

  it("rejects an invalid JWT (4401)", async () => {
    const auth = makeSupabaseAuthenticator(deps());
    expect(await auth("client", MACHINE, "bad-jwt")).toEqual({ ok: false, code: CloseCode.unauthorized });
  });

  it("rejects an unknown machine (4404)", async () => {
    const auth = makeSupabaseAuthenticator(deps());
    expect(await auth("client", "nope", "good-jwt")).toEqual({ ok: false, code: CloseCode.unknownMachine });
  });

  it("rejects a valid JWT that does NOT own the machine (4403)", async () => {
    const auth = makeSupabaseAuthenticator(
      deps({ verifyAccountToken: async () => OTHER_ACCT }),
    );
    expect(await auth("client", MACHINE, "good-jwt")).toEqual({ ok: false, code: CloseCode.forbidden });
  });
});

describe("entitlement", () => {
  // isEntitled pure-function tests
  it("isEntitled: lookup error → false", () => {
    expect(isEntitled({ ok: false })).toBe(false);
  });

  it("isEntitled: no row → true (first-time user)", () => {
    expect(isEntitled({ ok: true, row: null })).toBe(true);
  });

  it("isEntitled: has row with active trial → true", () => {
    const trial_started_at = new Date(Date.now() - 1_000).toISOString(); // started 1s ago
    expect(isEntitled({ ok: true, row: { trial_started_at, comp_until: null, entitled_until: null } })).toBe(true);
  });

  it("isEntitled: has row with expired trial → false", () => {
    const trial_started_at = new Date(Date.now() - 4_000_000).toISOString(); // > 1h ago
    expect(isEntitled({ ok: true, row: { trial_started_at, comp_until: null, entitled_until: null } })).toBe(false);
  });

  it("isEntitled: has row with comp_until = 'infinity' → true", () => {
    expect(isEntitled({ ok: true, row: { trial_started_at: null, comp_until: "infinity", entitled_until: null } })).toBe(true);
  });

  it("isEntitled: has row with active comp → true", () => {
    const comp_until = new Date(Date.now() + 86_400_000).toISOString(); // +1 day
    expect(isEntitled({ ok: true, row: { trial_started_at: null, comp_until, entitled_until: null } })).toBe(true);
  });

  it("isEntitled: has row with expired comp + active subscription → true", () => {
    const comp_until = new Date(Date.now() - 86_400_000).toISOString(); // expired
    const entitled_until = new Date(Date.now() + 86_400_000).toISOString(); // active
    expect(isEntitled({ ok: true, row: { trial_started_at: null, comp_until, entitled_until } })).toBe(true);
  });

  it("isEntitled: has row with all expired → false", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(isEntitled({ ok: true, row: { trial_started_at: past, comp_until: past, entitled_until: past } })).toBe(false);
  });

  // Authenticator integration tests
  it("authenticator client leg: entitled user accepted", async () => {
    const auth = makeSupabaseAuthenticator(deps());
    expect(await auth("client", MACHINE, "good-jwt")).toEqual({ ok: true, accountId: ACCT });
  });

  it("authenticator client leg: expired trial returns 4402", async () => {
    const trial_started_at = new Date(Date.now() - 4_000_000).toISOString();
    const auth = makeSupabaseAuthenticator(
      deps({
        getEntitlement: async () => ({
          ok: true,
          row: { trial_started_at, comp_until: null, entitled_until: null },
        }),
      }),
    );
    expect(await auth("client", MACHINE, "good-jwt")).toEqual({ ok: false, code: CloseCode.notEntitled });
  });

  it("authenticator client leg: entitlement lookup error returns 4402", async () => {
    const auth = makeSupabaseAuthenticator(
      deps({ getEntitlement: async () => ({ ok: false }) }),
    );
    expect(await auth("client", MACHINE, "good-jwt")).toEqual({ ok: false, code: CloseCode.notEntitled });
  });
});
