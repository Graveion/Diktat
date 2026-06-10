import { loadConfig } from "./config.ts";
import {
  Broker,
  CloseCode,
  staticAuthenticator,
  type Authenticator,
  type Leg,
  type RelaySocket,
} from "./broker.ts";
import {
  createSupabaseDeps,
  makeMachineToucher,
  makeSupabaseAuthenticator,
  type SupabaseAuthDeps,
} from "./supabase-auth.ts";
import {
  claimPairing,
  completePairing,
  createPairingDeps,
  PairingStore,
  type PairingDeps,
} from "./pairing.ts";

/** Per-connection data attached at upgrade time. */
interface ConnData {
  leg: Leg;
  machineId: string;
  accountId: string;
}

// Supabase-backed auth when configured (prod); static relay-config.json otherwise
// (local/dev/tests). Bun auto-loads relay/.env, so these are present in deploy.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

let authenticate: Authenticator;
let supaDeps: SupabaseAuthDeps | null = null;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  supaDeps = createSupabaseDeps({ url: SUPABASE_URL, serviceKey: SUPABASE_SECRET_KEY });
  authenticate = makeSupabaseAuthenticator(supaDeps);
  console.log("[diktat-relay] auth: Supabase (JWKS + machines table)");
} else {
  authenticate = staticAuthenticator(loadConfig());
  console.log("[diktat-relay] auth: static relay-config.json");
}

// Pairing (typed code + QR) is only available with a Supabase backend (needs the
// service role to mint machines). Null in static/local mode.
const pairingDeps: PairingDeps | null =
  SUPABASE_URL && SUPABASE_SECRET_KEY
    ? createPairingDeps({ url: SUPABASE_URL, serviceKey: SUPABASE_SECRET_KEY })
    : null;

// In-memory pending QR pairings (Tier 0, single instance).
const pairingStore = new PairingStore();

// Presence stamp for the app's online indicator (Supabase mode only).
const touchMachine: ((machineId: string) => void) | null =
  SUPABASE_URL && SUPABASE_SECRET_KEY
    ? makeMachineToucher({ url: SUPABASE_URL, serviceKey: SUPABASE_SECRET_KEY })
    : null;

const broker = new Broker();

// Per-IP rate limit on /pair/init (20 requests / 60s per IP).
const PAIR_INIT_MAX = 20;
const PAIR_INIT_WINDOW_MS = 60_000;
const pairInitCounts = new Map<string, { count: number; resetAt: number }>();

function checkPairInitRateLimit(ip: string): boolean {
  const now = Date.now();
  let entry = pairInitCounts.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + PAIR_INIT_WINDOW_MS };
    pairInitCounts.set(ip, entry);
  }
  entry.count++;
  return entry.count <= PAIR_INIT_MAX;
}

// Per-account concurrent client connection cap.
const CLIENT_CONN_MAX = 5;
const clientConnCounts = new Map<string, number>();

const PORT = Number(process.env.PORT ?? 9090);

function bearer(req: Request): string | undefined {
  const h = req.headers.get("authorization");
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : undefined;
}

/** Adapt a Bun ServerWebSocket to the broker's RelaySocket interface. */
function asRelaySocket(ws: { send(d: string): void; close(c?: number, r?: string): void }): RelaySocket {
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
  };
}

const server = Bun.serve<ConnData, never>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    // Pairing: daemon redeems a code for a per-machine token (RELAY.md pairing).
    if (url.pathname === "/pair/complete") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!pairingDeps) return new Response("pairing unavailable", { status: 503 });
      let body: { code?: string; machineId?: string; name?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return new Response(JSON.stringify({ error: "invalid JSON" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const result = await completePairing(pairingDeps, {
        code: body.code ?? "",
        machineId: body.machineId ?? "",
        name: body.name,
      });
      const status = result.ok ? 200 : result.status;
      const payload = result.ok
        ? { daemonToken: result.daemonToken, machineId: result.machineId, accountId: result.accountId }
        : { error: result.error };
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    // QR pairing — daemon registers a pending pairing and gets a nonce to show.
    if (url.pathname === "/pair/init") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!pairingDeps) return json({ error: "pairing unavailable" }, 503);
      const ip = req.headers.get("x-forwarded-for") ?? "unknown";
      if (!checkPairInitRateLimit(ip)) return json({ error: "rate limited" }, 429);
      let b: { machineId?: string; name?: string };
      try { b = (await req.json()) as typeof b; } catch { return json({ error: "invalid JSON" }, 400); }
      if (!b.machineId) return json({ error: "missing machineId" }, 400);
      const nonce = pairingStore.init(b.machineId, b.name?.trim() || "My Mac");
      return json({ nonce, expiresInSec: 300 });
    }

    // QR pairing — phone claims a nonce for its account (authed with the JWT).
    if (url.pathname === "/pair/claim") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!pairingDeps || !supaDeps) return json({ error: "pairing unavailable" }, 503);
      const token = bearer(req);
      if (!token) return json({ error: "missing bearer token" }, 401);
      const accountId = await supaDeps.verifyAccountToken(token);
      if (!accountId) return json({ error: "unauthorized" }, 401);
      let b: { nonce?: string };
      try { b = (await req.json()) as typeof b; } catch { return json({ error: "invalid JSON" }, 400); }
      if (!b.nonce) return json({ error: "missing nonce" }, 400);
      const result = await claimPairing(pairingStore, pairingDeps, accountId, b.nonce);
      return result.ok ? json({ ok: true, machineId: result.machineId }) : json({ error: result.error }, result.status);
    }

    // Account deletion (App Store requirement): an authed user erases their
    // account. FKs cascade from auth.users, so removing the user also removes
    // their machines, pairing codes, and billing state.
    if (url.pathname === "/account/delete") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!supaDeps || !SUPABASE_URL || !SUPABASE_SECRET_KEY) return json({ error: "unavailable" }, 503);
      const token = bearer(req);
      if (!token) return json({ error: "missing bearer token" }, 401);
      const accountId = await supaDeps.verifyAccountToken(token);
      if (!accountId) return json({ error: "unauthorized" }, 401);
      const res = await fetch(
        `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users/${encodeURIComponent(accountId)}`,
        {
          method: "DELETE",
          headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` },
        },
      ).catch(() => null);
      if (!res || !res.ok) return json({ error: "delete failed" }, 502);
      return json({ ok: true });
    }

    // RevenueCat webhook — receives purchase / renewal / expiry events and
    // updates account_state.entitled_until so the relay entitlement gate
    // reflects real subscription state server-side.
    if (url.pathname === "/rc/webhook") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return json({ error: "unavailable" }, 503);

      // Verify shared secret RC sends in the Authorization header (set in RC dashboard).
      const RC_WEBHOOK_SECRET = process.env.RC_WEBHOOK_SECRET;
      if (RC_WEBHOOK_SECRET) {
        const auth = req.headers.get("authorization");
        if (auth !== RC_WEBHOOK_SECRET) return new Response("unauthorized", { status: 401 });
      }

      let body: { event?: { type?: string; app_user_id?: string; expiration_at_ms?: number | null } };
      try { body = (await req.json()) as typeof body; } catch { return json({ error: "invalid JSON" }, 400); }

      const event = body.event;
      const accountId = event?.app_user_id;
      if (!accountId) return json({ ok: true }); // anonymous / no user id — ignore

      // Always write expiration_at_ms as entitled_until regardless of event type:
      // active subscription → future date; expired → past date; the relay gate
      // compares against now() so both cases resolve correctly.
      const expiresMs = event?.expiration_at_ms ?? null;
      const entitledUntil = expiresMs != null ? new Date(expiresMs).toISOString() : null;

      const base = SUPABASE_URL.replace(/\/$/, "");
      const headers = {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
      };
      // Upsert — account_state row may not exist yet if user subscribed before
      // starting a trial session (rare but possible via family sharing / promo).
      await fetch(`${base}/rest/v1/account_state`, {
        method: "POST",
        headers,
        body: JSON.stringify({ account_id: accountId, entitled_until: entitledUntil }),
      }).catch(() => {});

      console.log(`[rc-webhook] ${event?.type} accountId=${accountId} entitled_until=${entitledUntil ?? "null"}`);
      return json({ ok: true });
    }

    // QR pairing — daemon polls until the phone claims (then gets the token once).
    if (url.pathname === "/pair/poll") {
      if (!pairingDeps) return json({ error: "pairing unavailable" }, 503);
      const nonce = url.searchParams.get("nonce");
      if (!nonce) return json({ error: "missing nonce" }, 400);
      const taken = pairingStore.take(nonce);
      if (taken) return json({ status: "claimed", daemonToken: taken.daemonToken, machineId: taken.machineId });
      return json({ status: pairingStore.get(nonce) ? "pending" : "expired" });
    }

    let leg: Leg;
    if (url.pathname === "/agent") leg = "agent";
    else if (url.pathname === "/client") leg = "client";
    else return new Response("not found", { status: 404 });

    const machineId = url.searchParams.get("machineId");
    if (!machineId) return new Response("missing machineId", { status: 400 });

    const token = bearer(req);
    if (!token) return new Response("missing bearer token", { status: 401 });

    const auth = await authenticate(leg, machineId, token);
    if (!auth.ok) {
      // Surface the relay close-code intent over HTTP for pre-upgrade failures.
      return new Response("auth failed", { status: 401, headers: { "x-relay-close": String(auth.code) } });
    }

    const ok = srv.upgrade(req, { data: { leg, machineId, accountId: auth.accountId } });
    if (ok) return undefined;
    return new Response("upgrade failed", { status: 500 });
  },
  websocket: {
    open(ws) {
      const { leg, machineId, accountId } = ws.data;
      const sock = asRelaySocket(ws);
      // Stash the adapter on the ws so close/message route to the same identity.
      (ws as unknown as { _sock: RelaySocket })._sock = sock;
      if (leg === "agent") {
        broker.registerAgent(machineId, accountId, sock);
        touchMachine?.(machineId); // mark online on connect
      } else {
        // Enforce per-account concurrent client connection cap.
        const current = clientConnCounts.get(accountId) ?? 0;
        if (current >= CLIENT_CONN_MAX) {
          ws.close(CloseCode.notEntitled, "too many connections");
          return;
        }
        clientConnCounts.set(accountId, current + 1);
        broker.registerClient(machineId, accountId, sock);
      }
    },
    message(ws, message) {
      const { leg, machineId } = ws.data;
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      // Refresh presence on the daemon's keep-alive ping (small control frame,
      // ~every 30s) so the online indicator stays fresh during long sessions.
      if (leg === "agent" && touchMachine && raw.length < 64 && raw.includes('"_relay"') && raw.includes('"ping"')) {
        touchMachine(machineId);
      }
      broker.route(machineId, leg, raw);
    },
    close(ws) {
      const { leg, machineId, accountId } = ws.data;
      const sock = (ws as unknown as { _sock?: RelaySocket })._sock;
      if (sock) broker.handleClose(machineId, leg, sock);
      if (leg === "client") {
        const current = clientConnCounts.get(accountId) ?? 0;
        if (current <= 1) {
          clientConnCounts.delete(accountId);
        } else {
          clientConnCounts.set(accountId, current - 1);
        }
      }
    },
  },
});

console.log(`[diktat-relay] listening on :${server.port}`);
