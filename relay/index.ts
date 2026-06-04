import { loadConfig } from "./config.ts";
import {
  Broker,
  staticAuthenticator,
  type Authenticator,
  type Leg,
  type RelaySocket,
} from "./broker.ts";
import { createSupabaseDeps, makeMachineToucher, makeSupabaseAuthenticator } from "./supabase-auth.ts";
import { completePairing, createPairingDeps, type PairingDeps } from "./pairing.ts";

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
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  authenticate = makeSupabaseAuthenticator(
    createSupabaseDeps({ url: SUPABASE_URL, serviceKey: SUPABASE_SECRET_KEY }),
  );
  console.log("[diktat-relay] auth: Supabase (JWKS + machines table)");
} else {
  authenticate = staticAuthenticator(loadConfig());
  console.log("[diktat-relay] auth: static relay-config.json");
}

// Pairing endpoint is only available with a Supabase backend (it needs the
// service role to mint machines + consume codes). Null in static/local mode.
const pairingDeps: PairingDeps | null =
  SUPABASE_URL && SUPABASE_SECRET_KEY
    ? createPairingDeps({ url: SUPABASE_URL, serviceKey: SUPABASE_SECRET_KEY })
    : null;

// Presence stamp for the app's online indicator (Supabase mode only).
const touchMachine: ((machineId: string) => void) | null =
  SUPABASE_URL && SUPABASE_SECRET_KEY
    ? makeMachineToucher({ url: SUPABASE_URL, serviceKey: SUPABASE_SECRET_KEY })
    : null;

const broker = new Broker();

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
      const { leg, machineId } = ws.data;
      const sock = (ws as unknown as { _sock?: RelaySocket })._sock;
      if (sock) broker.handleClose(machineId, leg, sock);
    },
  },
});

console.log(`[diktat-relay] listening on :${server.port}`);
