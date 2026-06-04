import { buildConnectedPayload, handleClientMessage, type MessageContext } from "./message-handler";

/**
 * Relay agent-leg client.
 *
 * The daemon dials *out* to the relay's /agent endpoint and holds the socket
 * open. The relay forwards phone->daemon app frames to us, and forwards
 * anything we send that is NOT a `_relay` control frame verbatim to the phone.
 */

// ---------------------------------------------------------------------------
// Socket seam — lets tests inject a fake socket without a real network.
// ---------------------------------------------------------------------------

/** Minimal surface we need from the agent socket. Real Bun WebSocket satisfies it. */
export interface RelaySocket {
  send(data: string): void;
  close(): void;
  onopen?: ((ev?: any) => void) | null;
  onmessage?: ((ev: { data: any }) => void) | null;
  onclose?: ((ev?: any) => void) | null;
  onerror?: ((ev?: any) => void) | null;
}

/** Factory that opens an agent-leg socket for the given url + bearer token. */
export type ConnectFn = (url: string, token: string) => RelaySocket;

const defaultConnect: ConnectFn = (url, token) =>
  // Bun's WebSocket client accepts a headers option in the constructor.
  new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } }) as unknown as RelaySocket;

export interface StartRelayClientOpts {
  ctx: MessageContext;
  relayUrl: string;
  machineId: string;
  daemonToken: string;
  /** Injectable socket factory (tests). Defaults to a real Bun WebSocket. */
  connect?: ConnectFn;
  /** Injectable timer (tests). Defaults to setTimeout. Returns a handle. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Disable the periodic ping (tests). */
  enablePing?: boolean;
}

/** Handle returned by startRelayClient — lets the caller / tests stop it. */
export interface RelayClientHandle {
  /** Stop reconnecting and close the current socket. */
  stop(): void;
  /** The stable adapter ws passed to handleClientMessage. */
  readonly adapter: AdapterWs;
}

// ---------------------------------------------------------------------------
// Adapter ws — the object handleClientMessage and Session see as `ws`.
// ---------------------------------------------------------------------------

/**
 * Stable singleton ws-like object (Tier 0 = one client per machine).
 *
 * - `.send(str)` writes to the live agent socket → relay forwards verbatim to
 *   the phone. App replies therefore carry no `_relay` wrapper.
 * - `.readyState` is 1 ("open") while a phone is attached, 3 ("closed")
 *   otherwise. session.ts gates completion push on `readyState === 1`, so a
 *   push fires only after the phone has detached — exactly the local semantics.
 * - It is a single stable object so `clientPushTokens` (a WeakMap keyed by ws)
 *   keeps the registered token across attach/detach cycles.
 */
export class AdapterWs {
  /** 1 = open (client attached), 3 = closed (no client). */
  readyState = 3;
  /** The live agent socket; swapped on each (re)connect. */
  private socket: RelaySocket | null = null;

  setSocket(socket: RelaySocket | null): void {
    this.socket = socket;
  }

  markAttached(): void {
    this.readyState = 1;
  }

  markDetached(): void {
    this.readyState = 3;
  }

  send(data: string): void {
    // If the agent socket dropped mid-run, silently drop — session output is
    // best-effort while disconnected, mirroring a closed local ws.
    try {
      this.socket?.send(data);
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 30_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 30_000;

function jitter(ms: number): number {
  // +/- 20% jitter so reconnecting daemons don't thunder together.
  const delta = ms * 0.2;
  return Math.round(ms - delta + Math.random() * 2 * delta);
}

export function startRelayClient(opts: StartRelayClientOpts): RelayClientHandle {
  const {
    ctx,
    relayUrl,
    machineId,
    daemonToken,
    connect = defaultConnect,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h as any),
    enablePing = true,
  } = opts;

  const adapter = new AdapterWs();
  const url = `${relayUrl.replace(/\/$/, "")}/agent?machineId=${encodeURIComponent(machineId)}`;

  let stopped = false;
  let backoff = BACKOFF_MIN_MS;
  let reconnectHandle: unknown = null;
  let pingHandle: unknown = null;
  let socket: RelaySocket | null = null;

  function log(msg: string): void {
    console.log(`[${new Date().toISOString()}] [relay] ${msg}`);
  }

  function clearPing(): void {
    if (pingHandle != null) {
      clearTimer(pingHandle);
      pingHandle = null;
    }
  }

  function scheduleReconnect(reason: string): void {
    if (stopped) return;
    const delay = jitter(backoff);
    log(`reconnecting in ${delay}ms (${reason})`);
    reconnectHandle = setTimer(() => {
      reconnectHandle = null;
      open();
    }, delay);
    // Exponential growth toward the cap for the *next* attempt.
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  function startPing(): void {
    if (!enablePing) return;
    clearPing();
    const tick = () => {
      if (stopped) return;
      // A `_relay` ping the broker can ignore. Chosen over WS protocol pings so
      // the keep-alive is explicit, transport-agnostic, and never reaches app
      // dispatch (it carries _relay:true). The relay drops unknown _relay types.
      adapter.send(JSON.stringify({ _relay: true, type: "ping" }));
      pingHandle = setTimer(tick, PING_INTERVAL_MS);
    };
    pingHandle = setTimer(tick, PING_INTERVAL_MS);
  }

  function handleControlFrame(msg: any): void {
    switch (msg.type) {
      case "agent_registered":
        log(`registered as machine ${machineId}`);
        break;
      case "client_attached":
        log(`client attached${msg.clientId ? ` (${msg.clientId})` : ""}`);
        adapter.markAttached();
        adapter.send(JSON.stringify(buildConnectedPayload(ctx)));
        break;
      case "client_detached":
        log("client detached");
        adapter.markDetached();
        // activeSessions keep running; push fires on completion (ws "closed").
        break;
      default:
        // Unknown control frame — ignore (forward-compatible).
        break;
    }
  }

  function onMessage(raw: any): void {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      // Malformed frame from the relay — ignore (we never forward to phone here).
      return;
    }
    if (msg && msg._relay === true) {
      handleControlFrame(msg);
      return;
    }
    // App frame (phone -> daemon): dispatch through the shared router, exactly
    // like local mode. Output flows back via adapter.send -> agent socket.
    handleClientMessage(ctx, adapter as any, msg).catch((e) => {
      console.error("Unhandled error in relay message handler:", e);
      try {
        adapter.send(JSON.stringify({ type: "error", message: "Internal error" }));
      } catch {
        /* best-effort */
      }
    });
  }

  function open(): void {
    if (stopped) return;
    let s: RelaySocket;
    try {
      s = connect(url, daemonToken);
    } catch (e) {
      // Synchronous open failure (rare) — treat as a transient drop.
      console.error("[relay] connect threw:", e);
      scheduleReconnect("connect threw");
      return;
    }
    socket = s;
    adapter.setSocket(s);

    s.onopen = () => {
      // Clean open: reset backoff. NOTE: a 401 fails the *upgrade* and surfaces
      // as onclose/onerror without onopen, so we never reset backoff on auth fail.
      backoff = BACKOFF_MIN_MS;
      log("agent socket open");
      startPing();
    };

    s.onmessage = (ev: { data: any }) => onMessage(ev.data);

    s.onerror = () => {
      // Bun fires error then close; log here, let onclose drive reconnect.
      // A failed handshake (e.g. HTTP 401) lands here with no prior onopen.
      log("agent socket error (handshake/auth failure or transport error)");
    };

    s.onclose = () => {
      clearPing();
      adapter.setSocket(null);
      adapter.markDetached();
      if (socket === s) socket = null;
      scheduleReconnect("socket closed");
    };
  }

  open();

  return {
    adapter,
    stop() {
      stopped = true;
      clearPing();
      if (reconnectHandle != null) {
        clearTimer(reconnectHandle);
        reconnectHandle = null;
      }
      try {
        socket?.close();
      } catch {
        /* best-effort */
      }
      socket = null;
      adapter.setSocket(null);
      adapter.markDetached();
    },
  };
}
