import { describe, expect, it } from "bun:test";
import { CloseCode } from "./broker.ts";
import {
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
