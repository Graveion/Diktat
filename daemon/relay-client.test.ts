/**
 * Tests for the relay agent-leg client.
 *
 * The agent socket is external, so we inject a fake socket factory (connect)
 * exposing the same onopen/onmessage/onclose/onerror seam the real Bun
 * WebSocket uses. handleClientMessage runs for real against an injected
 * MessageContext (with a stub session factory) so app-frame dispatch is
 * exercised end-to-end without spawning a CLI.
 */
import { test, expect } from "bun:test";
import { startRelayClient, AdapterWs, MAX_DETACHED_BUFFER_BYTES, type RelaySocket } from "./relay-client";
import type { MessageContext, SessionFactory } from "./message-handler";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A fake agent socket that records sent frames and exposes manual drivers. */
function fakeSocket() {
  const sent: any[] = [];
  let closed = false;
  const s: RelaySocket = {
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {
      closed = true;
    },
  };
  return {
    socket: s,
    sent,
    isClosed: () => closed,
    fireOpen: () => s.onopen?.(),
    fireMessage: (obj: any) => s.onmessage?.({ data: JSON.stringify(obj) }),
    fireRaw: (raw: string) => s.onmessage?.({ data: raw }),
    fireClose: () => s.onclose?.(),
    fireError: () => s.onerror?.(),
  };
}

const fakeSessionFactory: SessionFactory = {
  create: () => {
    throw new Error("not used");
  },
  resume: () => null,
  fromClaudeSession: () => {
    throw new Error("not used");
  },
  fromCursorSession: () => {
    throw new Error("not used");
  },
  fromCodexSession: () => {
    throw new Error("not used");
  },
  fromCopilotSession: () => {
    throw new Error("not used");
  },
  fromKiroSession: () => {
    throw new Error("not used");
  },
};

function makeCtx(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    availableCLIs: { claude: "/bin/claude", cursor: "/bin/agent" },
    projects: ["/allowed/project"],
    activeSessions: new Map(),
    clientPushTokens: new WeakMap(),
    sessionFactory: fakeSessionFactory,
    readClaudeHistory: () => [],
    readCursorHistory: () => [],
    ...overrides,
  };
}

/** Start a relay client wired to a single fresh fake socket; returns helpers. */
function harness(ctx = makeCtx()) {
  const created: ReturnType<typeof fakeSocket>[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const handle = startRelayClient({
    ctx,
    relayUrl: "wss://relay.test",
    machineId: "machine-1",
    daemonToken: "tok",
    enablePing: false,
    connect: () => {
      const f = fakeSocket();
      created.push(f);
      return f.socket;
    },
    // Capture scheduled timers instead of really waiting.
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    clearTimer: () => {},
  });
  return { handle, created, timers, ctx };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("client_attached: sends connected payload and marks adapter open", () => {
  const { handle, created } = harness();
  const sock = created[0]!;
  sock.fireOpen();

  expect(handle.adapter.readyState).toBe(3); // not attached yet

  sock.fireMessage({ _relay: true, type: "client_attached", clientId: "c1" });

  expect(handle.adapter.readyState).toBe(1);
  expect(sock.sent.length).toBe(1);
  const frame = sock.sent[0];
  expect(frame.type).toBe("connected");
  expect(frame.clis).toEqual(["claude", "cursor"]);
  expect(frame.projects).toEqual(["/allowed/project"]);
  expect(Array.isArray(frame.sessions)).toBe(true);
  expect(frame._relay).toBeUndefined(); // app frame, no relay wrapper
});

test("client_detached: marks adapter closed", () => {
  const { handle, created } = harness();
  const sock = created[0]!;
  sock.fireOpen();
  sock.fireMessage({ _relay: true, type: "client_attached" });
  expect(handle.adapter.readyState).toBe(1);

  sock.fireMessage({ _relay: true, type: "client_detached" });
  expect(handle.adapter.readyState).toBe(3);
});

test("app frame is dispatched and the reply is written verbatim (no _relay)", () => {
  const { created } = harness();
  const sock = created[0]!;
  sock.fireOpen();
  sock.fireMessage({ _relay: true, type: "client_attached" });
  sock.sent.length = 0; // drop the connected payload

  sock.fireMessage({ type: "ping" }); // app frame

  expect(sock.sent.length).toBe(1);
  expect(sock.sent[0]).toEqual({ type: "pong" });
  expect(sock.sent[0]._relay).toBeUndefined();
});

test("a _relay control frame is NOT dispatched to handleClientMessage", () => {
  // register_push would set a push token if it were (wrongly) dispatched.
  const ctx = makeCtx();
  const { handle, created } = harness(ctx);
  const sock = created[0]!;
  sock.fireOpen();

  // A _relay frame that *also* carries an app-like type must never reach dispatch.
  sock.fireMessage({ _relay: true, type: "register_push", token: "should-not-store" });

  // Token was never stored on the adapter (control frames bypass the router).
  expect(ctx.clientPushTokens.get(handle.adapter as object)).toBeUndefined();
  // agent_registered / unknown control frames produce no app-frame output.
  expect(sock.sent.length).toBe(0);
});

test("register_push (real app frame) stores the token on the stable adapter", () => {
  const ctx = makeCtx();
  const { handle, created } = harness(ctx);
  const sock = created[0]!;
  sock.fireOpen();
  sock.fireMessage({ _relay: true, type: "client_attached" });

  sock.fireMessage({ type: "register_push", token: "expo-tok" });
  expect(ctx.clientPushTokens.get(handle.adapter as object)).toBe("expo-tok");
});

test("malformed relay frame is ignored (no throw, no output)", () => {
  const { created } = harness();
  const sock = created[0]!;
  sock.fireOpen();
  expect(() => sock.fireRaw("{ not json")).not.toThrow();
  expect(sock.sent.length).toBe(0);
});

test("on socket close, a reconnect is scheduled and reconnect opens a new socket", () => {
  const { created, timers } = harness();
  const sock = created[0]!;
  sock.fireOpen();

  expect(created.length).toBe(1);
  sock.fireClose();

  // A reconnect timer was scheduled.
  expect(timers.length).toBeGreaterThanOrEqual(1);
  const reconnect = timers[timers.length - 1]!;
  expect(reconnect.ms).toBeGreaterThan(0);

  // Firing it opens a fresh socket.
  reconnect.fn();
  expect(created.length).toBe(2);
});

// ---------------------------------------------------------------------------
// Detached-output buffering / replay
// ---------------------------------------------------------------------------

test("AdapterWs buffers session frames while detached and drains them in order", () => {
  const a = new AdapterWs();
  a.markDetached();
  a.send(JSON.stringify({ type: "output", text: "one" }));
  a.send(JSON.stringify({ type: "output", text: "two" }));
  const { frames, overflowed } = a.drainBuffer();
  expect(overflowed).toBe(false);
  expect(frames.map((f) => JSON.parse(f).text)).toEqual(["one", "two"]);
  // Draining empties the buffer.
  expect(a.drainBuffer().frames.length).toBe(0);
});

test("AdapterWs does NOT buffer _relay control frames (e.g. pings)", () => {
  const a = new AdapterWs();
  a.markDetached();
  a.send(JSON.stringify({ _relay: true, type: "ping" }));
  expect(a.drainBuffer().frames.length).toBe(0);
});

test("AdapterWs writes live (does not buffer) while attached", () => {
  const a = new AdapterWs();
  const sent: string[] = [];
  a.setSocket({ send: (d) => sent.push(d), close: () => {} });
  a.markAttached();
  a.send(JSON.stringify({ type: "output", text: "live" }));
  expect(sent.length).toBe(1);
  expect(a.drainBuffer().frames.length).toBe(0);
});

test("AdapterWs flags overflow and drops oldest past the cap", () => {
  const a = new AdapterWs();
  a.markDetached();
  const big = "x".repeat(Math.ceil(MAX_DETACHED_BUFFER_BYTES / 2));
  // Three half-cap frames exceed the cap → oldest dropped, overflow set.
  a.send(JSON.stringify({ type: "output", text: big }));
  a.send(JSON.stringify({ type: "output", text: big }));
  a.send(JSON.stringify({ type: "output", text: big }));
  const { frames, overflowed } = a.drainBuffer();
  expect(overflowed).toBe(true);
  expect(frames.length).toBeLessThan(3);
});

test("client_attached replays buffered frames after the connected payload", () => {
  const { handle, created } = harness();
  const sock = created[0]!;
  sock.fireOpen();
  // Attach, then detach so subsequent output buffers.
  sock.fireMessage({ _relay: true, type: "client_attached" });
  sock.fireMessage({ _relay: true, type: "client_detached" });
  sock.sent.length = 0;

  handle.adapter.send(JSON.stringify({ type: "output", text: "missed" }));
  expect(sock.sent.length).toBe(0); // buffered, not sent live

  // Reattach: connected payload first, then the replayed frame.
  sock.fireMessage({ _relay: true, type: "client_attached" });
  expect(sock.sent[0].type).toBe("connected");
  expect(sock.sent[1]).toEqual({ type: "output", text: "missed" });
});

test("client_attached sends a resync frame (not a partial replay) on overflow", () => {
  const { handle, created } = harness();
  const sock = created[0]!;
  sock.fireOpen();
  sock.fireMessage({ _relay: true, type: "client_attached" });
  sock.fireMessage({ _relay: true, type: "client_detached" });
  sock.sent.length = 0;

  const big = "x".repeat(Math.ceil(MAX_DETACHED_BUFFER_BYTES / 2));
  for (let i = 0; i < 3; i++) handle.adapter.send(JSON.stringify({ type: "output", text: big }));

  sock.fireMessage({ _relay: true, type: "client_attached" });
  expect(sock.sent[0].type).toBe("connected");
  expect(sock.sent[1]).toEqual({ type: "resync" });
  // No buffered output frames replayed alongside the resync.
  expect(sock.sent.some((f: any) => f.type === "output")).toBe(false);
});

test("stop() prevents further reconnects and closes the socket", () => {
  const { handle, created, timers } = harness();
  const sock = created[0]!;
  sock.fireOpen();

  handle.stop();
  expect(sock.isClosed()).toBe(true);

  // A close after stop must not schedule another reconnect.
  const before = timers.length;
  sock.fireClose();
  // No new connect even if a stale timer somehow fired.
  expect(created.length).toBe(1);
  expect(timers.length).toBe(before);
});
