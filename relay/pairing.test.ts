import { describe, expect, it } from "bun:test";
import {
  completePairing,
  generateDaemonToken,
  type PairingCodeRow,
  type PairingDeps,
} from "./pairing.ts";
import { sha256hex } from "./supabase-auth.ts";

const ACCT = "acct-1";
const NOW = Date.parse("2026-06-04T12:00:00Z");
const FUTURE = "2026-06-04T12:10:00Z";
const PAST = "2026-06-04T11:50:00Z";

interface Recorder {
  upserted: Array<{ id: string; accountId: string; name: string; tokenHash: string }>;
  consumed: Array<{ code: string; machineId: string }>;
}

function deps(
  over: Partial<PairingDeps> = {},
  code: PairingCodeRow | null = { accountId: ACCT, expiresAt: FUTURE, consumedAt: null },
): { deps: PairingDeps; rec: Recorder } {
  const rec: Recorder = { upserted: [], consumed: [] };
  const base: PairingDeps = {
    getPairingCode: async () => code,
    getMachineAccount: async () => null,
    upsertMachine: async (row) => {
      rec.upserted.push(row);
    },
    consumePairingCode: async (c, m) => {
      rec.consumed.push({ code: c, machineId: m });
    },
    generateToken: () => "fixed-token",
    now: () => NOW,
    ...over,
  };
  return { deps: base, rec };
}

describe("completePairing", () => {
  it("mints a token, stores its hash, and consumes the code", async () => {
    const { deps: d, rec } = deps();
    const r = await completePairing(d, { code: "ABCD1234", machineId: "m1", name: "Studio" });
    expect(r).toEqual({ ok: true, daemonToken: "fixed-token", machineId: "m1", accountId: ACCT });
    expect(rec.upserted).toEqual([
      { id: "m1", accountId: ACCT, name: "Studio", tokenHash: sha256hex("fixed-token") },
    ]);
    expect(rec.consumed).toEqual([{ code: "ABCD1234", machineId: "m1" }]);
  });

  it("defaults the machine name when omitted", async () => {
    const { deps: d, rec } = deps();
    await completePairing(d, { code: "C", machineId: "m1" });
    expect(rec.upserted[0]!.name).toBe("My Mac");
  });

  it("rejects missing code / machineId (400)", async () => {
    const { deps: d } = deps();
    expect(await completePairing(d, { code: "", machineId: "m1" })).toMatchObject({ ok: false, status: 400 });
    expect(await completePairing(d, { code: "C", machineId: "  " })).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects an unknown code (404)", async () => {
    const { deps: d } = deps({}, null);
    expect(await completePairing(d, { code: "X", machineId: "m1" })).toMatchObject({ ok: false, status: 404 });
  });

  it("rejects an already-consumed code (409)", async () => {
    const { deps: d } = deps({}, { accountId: ACCT, expiresAt: FUTURE, consumedAt: "2026-06-04T11:00:00Z" });
    expect(await completePairing(d, { code: "X", machineId: "m1" })).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects an expired code (410)", async () => {
    const { deps: d } = deps({}, { accountId: ACCT, expiresAt: PAST, consumedAt: null });
    expect(await completePairing(d, { code: "X", machineId: "m1" })).toMatchObject({ ok: false, status: 410 });
  });

  it("re-pairs a machine the SAME account already owns", async () => {
    const { deps: d, rec } = deps({ getMachineAccount: async () => ACCT });
    const r = await completePairing(d, { code: "C", machineId: "m1" });
    expect(r.ok).toBe(true);
    expect(rec.upserted).toHaveLength(1);
  });

  it("refuses to hijack a machine owned by another account (409)", async () => {
    const { deps: d, rec } = deps({ getMachineAccount: async () => "other-acct" });
    const r = await completePairing(d, { code: "C", machineId: "m1" });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(rec.upserted).toHaveLength(0);
    expect(rec.consumed).toHaveLength(0);
  });
});

describe("generateDaemonToken", () => {
  it("returns unique 64-char hex tokens", () => {
    const a = generateDaemonToken();
    const b = generateDaemonToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
