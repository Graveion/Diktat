import { useCallback, useEffect, useState } from "react";
import { RELAY_URL, supabase } from "../store/supabase";

function relayHttpBase(u: string): string {
  return u.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").replace(/\/$/, "");
}

// MOCK_MODE (simulator dev) serves a fake machine so the UI is exercisable
// without a Supabase round-trip. Mirrors useAuth / useMockDiktat.
const MOCK_MODE = __DEV__;

export interface Machine {
  id: string;
  name: string;
  lastSeenAt: string | null;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
}

// Human-typable code: 8 chars, no ambiguous 0/O/1/I/L characters.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

const PAIRING_TTL_MS = 10 * 60 * 1000;

const MOCK_MACHINES: Machine[] = [
  { id: "mock-mac", name: "Mock Studio", lastSeenAt: new Date().toISOString() },
];

export interface MachinesApi {
  machines: Machine[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createPairingCode: () => Promise<PairingCode>;
  /** Claim a QR pairing nonce (scanned from the Mac) for this account. */
  claimQrPairing: (nonce: string) => Promise<{ ok: boolean; machineId?: string; error?: string }>;
  unpair: (id: string) => Promise<void>;
}

export function useMachines(): MachinesApi {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (MOCK_MODE) {
      setMachines(MOCK_MACHINES);
      setLoading(false);
      return;
    }
    const { data, error: err } = await supabase
      .from("machines")
      .select("id,name,last_seen_at")
      .order("created_at", { ascending: true });
    if (err) {
      setError(err.message);
    } else if (data) {
      setMachines(data.map((m) => ({ id: m.id, name: m.name, lastSeenAt: m.last_seen_at })));
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createPairingCode = useCallback(async (): Promise<PairingCode> => {
    const code = generateCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    if (MOCK_MODE) return { code, expiresAt };

    const { data: u } = await supabase.auth.getUser();
    const accountId = u.user?.id;
    if (!accountId) throw new Error("Not signed in");
    const { error: err } = await supabase
      .from("pairing_codes")
      .insert({ code, account_id: accountId, expires_at: expiresAt });
    if (err) throw err;
    return { code, expiresAt };
  }, []);

  const claimQrPairing = useCallback(
    async (nonce: string): Promise<{ ok: boolean; machineId?: string; error?: string }> => {
      if (MOCK_MODE) {
        setMachines(MOCK_MACHINES);
        return { ok: true, machineId: MOCK_MACHINES[0]!.id };
      }
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return { ok: false, error: "Not signed in" };
      try {
        const res = await fetch(`${relayHttpBase(RELAY_URL)}/pair/claim`, {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ nonce }),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; machineId?: string; error?: string };
        if (!res.ok || !body.ok) {
          return { ok: false, error: body.error ?? `Pairing failed (${res.status})` };
        }
        await refresh();
        return { ok: true, machineId: body.machineId };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? "Network error" };
      }
    },
    [refresh],
  );

  const unpair = useCallback(
    async (id: string) => {
      if (MOCK_MODE) {
        setMachines((m) => m.filter((x) => x.id !== id));
        return;
      }
      const { error: err } = await supabase.from("machines").delete().eq("id", id);
      if (err) {
        setError(err.message);
        return;
      }
      await refresh();
    },
    [refresh],
  );

  return { machines, loading, error, refresh, createPairingCode, claimQrPairing, unpair };
}
