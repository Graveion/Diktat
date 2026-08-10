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
/** Cap on output buffered while the phone is detached. Past this we drop the
 *  oldest frames and flag overflow, so reattach falls back to a full history
 *  reload rather than replaying a partial (misleading) tail. */
export const MAX_DETACHED_BUFFER_BYTES = 256 * 1024;

export class AdapterWs {
  /** 1 = open (client attached), 3 = closed (no client). */
  readyState = 3;
  /** The live agent socket; swapped on each (re)connect. */
  private socket: RelaySocket | null = null;
  /** Session frames emitted while detached, awaiting replay on reattach. */
  private buffer: string[] = [];
  private bufferedBytes = 0;
  private overflowed = false;

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
    // `_relay` control frames (keep-alive ping/pong) are daemon↔relay transport,
    // not phone content, so they must reach the relay whether or not a phone is
    // attached — they bypass the detached-buffering gate entirely. (Gating them
    // on phone-attachment silently dropped the keep-alive ping while idle: the
    // relay never saw a ping, so no pong came back and the daemon reconnect-
    // looped every ~45s.) Session frames still buffer while detached for replay.
    const isControl = data.includes('"_relay"');
    if (!isControl && this.readyState !== 1) {
      this.bufferWhileDetached(data);
      return;
    }
    try {
      this.socket?.send(data);
    } catch {
      /* best-effort */
    }
  }

  private bufferWhileDetached(data: string): void {
    this.buffer.push(data);
    this.bufferedBytes += data.length;
    // Ring-drop oldest frames past the cap; once we've dropped anything the
    // replay would be partial, so mark overflow.
    while (this.bufferedBytes > MAX_DETACHED_BUFFER_BYTES && this.buffer.length > 1) {
      const dropped = this.buffer.shift()!;
      this.bufferedBytes -= dropped.length;
      this.overflowed = true;
    }
  }

  /** Drain frames buffered while detached. Caller replays them on reattach
   *  (or, if `overflowed`, asks the client to reload history instead). */
  drainBuffer(): { frames: string[]; overflowed: boolean } {
    const frames = this.buffer;
    const overflowed = this.overflowed;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.overflowed = false;
    return { frames, overflowed };
  }
}

// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 30_000;
// If no pong arrives within this window after a ping, the TCP socket is likely
// frozen (e.g. Fly VM suspended mid-connection). Force-close to trigger reconnect.
const PING_TIMEOUT_MS = 15_000;
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
  let pingTimeoutHandle: unknown = null;
  let lastPongAt: number = 0; // 0 = no pong received yet (first ping cycle)
  let socket: RelaySocket | null = null;

  function log(msg: string): void {
    console.log(`[${new Date().toISOString()}] [relay] ${msg}`);
  }

  function clearPing(): void {
    if (pingHandle != null) {
      clearTimer(pingHandle);
      pingHandle = null;
    }
    if (pingTimeoutHandle != null) {
      clearTimer(pingTimeoutHandle);
      pingTimeoutHandle = null;
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
    lastPongAt = Date.now(); // treat connection open as an implicit first pong
    const tick = () => {
      if (stopped) return;
      adapter.send(JSON.stringify({ _relay: true, type: "ping" }));
      // Expect a pong back within PING_TIMEOUT_MS. If the TCP socket is frozen
      // (e.g. Fly VM suspended), the pong never arrives and we force a reconnect.
      pingTimeoutHandle = setTimer(() => {
        pingTimeoutHandle = null;
        if (stopped) return;
        const elapsed = Date.now() - lastPongAt;
        if (elapsed > PING_TIMEOUT_MS) {
          log(`ping timeout (no pong in ${elapsed}ms) — reconnecting`);
          socket?.close();
        }
      }, PING_TIMEOUT_MS);
      pingHandle = setTimer(tick, PING_INTERVAL_MS);
    };
    pingHandle = setTimer(tick, PING_INTERVAL_MS);
  }

  function handleControlFrame(msg: any): void {
    switch (msg.type) {
      case "pong":
        lastPongAt = Date.now();
        if (pingTimeoutHandle != null) {
          clearTimer(pingTimeoutHandle);
          pingTimeoutHandle = null;
        }
        break;
      case "agent_registered":
        log(`registered as machine ${machineId}`);
        break;
      case "client_attached": {
        log(`client attached${msg.clientId ? ` (${msg.clientId})` : ""}`);
        adapter.markAttached();
        adapter.send(JSON.stringify(buildConnectedPayload(ctx)));
        // Catch the phone up on output that streamed while it was away. A
        // small gap replays verbatim; an overflow asks the client to reload
        // history instead of showing a misleading partial tail.
        const { frames, overflowed } = adapter.drainBuffer();
        if (overflowed) {
          log("detached buffer overflowed — requesting client resync");
          adapter.send(JSON.stringify({ type: "resync" }));
        } else if (frames.length > 0) {
          log(`replaying ${frames.length} buffered frame(s) to reattached client`);
          for (const f of frames) adapter.send(f);
        }
        break;
      }
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
