import { timingSafeEqual } from "node:crypto";
import type { RelayConfig } from "./config.ts";

/** Which leg a connection is for. */
export type Leg = "agent" | "client";

/** Close codes (RELAY.md §2/§4). */
export const CloseCode = {
  unauthorized: 4401,
  forbidden: 4403,
  unknownMachine: 4404,
} as const;

/** Minimal socket abstraction so the Broker is unit-testable without real WS. */
export interface RelaySocket {
  /** Send a raw string frame verbatim. */
  send(data: string): void;
  /** Close with a WS close code + reason. */
  close(code: number, reason?: string): void;
}

/** Result of an auth handshake decision (pure). */
export type AuthResult =
  | { ok: true; accountId: string }
  | { ok: false; code: number };

/** Constant-time string compare. Returns false on length mismatch without leaking via early-return timing on equal-length inputs. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still burn a compare against self to avoid trivial length-based timing,
    // then reject. Length is not itself secret here (tokens are fixed-width).
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Pure auth/ownership decision (RELAY.md §2).
 *
 * Agent leg:  machine must exist (else 4401) and daemonToken must match (4401).
 * Client leg: token must resolve to an account (4401); machine must exist (4404);
 *             machines[M].accountId must equal that account (4403).
 */
export function authResult(
  config: RelayConfig,
  leg: Leg,
  machineId: string,
  token: string,
): AuthResult {
  if (leg === "agent") {
    const machine = config.machines[machineId];
    if (!machine) return { ok: false, code: CloseCode.unauthorized };
    if (!constantTimeEqual(token, machine.daemonToken))
      return { ok: false, code: CloseCode.unauthorized };
    return { ok: true, accountId: machine.accountId };
  }

  // client leg
  const accountId = config.accountTokens[token];
  if (accountId === undefined) return { ok: false, code: CloseCode.unauthorized };
  const machine = config.machines[machineId];
  if (!machine) return { ok: false, code: CloseCode.unknownMachine };
  if (machine.accountId !== accountId) return { ok: false, code: CloseCode.forbidden };
  return { ok: true, accountId };
}

/** A control frame is a JSON object with `_relay: true`. */
export function isControlFrame(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON we can read — treat as an app frame and forward verbatim.
    return false;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>)._relay === true
  );
}

/** Build a control-frame JSON string (always carries `_relay: true`). */
export function controlFrame(type: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ _relay: true, type, ...extra });
}

interface MachineState {
  accountId: string;
  agent?: RelaySocket;
  client?: RelaySocket;
}

/**
 * In-memory broker. Owns the machineId -> { agent?, client?, accountId } registry,
 * pairing, the verbatim app-frame pipe, and control-frame emission.
 *
 * Methods take RelaySocket so they can be driven with fakes in tests.
 */
export class Broker {
  private readonly machines = new Map<string, MachineState>();

  // Auth is decided up-front via authResult(); the Broker only manages the
  // post-auth registry, so it intentionally holds no config reference.
  constructor() {}

  /** Test/introspection helper. */
  getState(machineId: string): Readonly<MachineState> | undefined {
    return this.machines.get(machineId);
  }

  private stateFor(machineId: string, accountId: string): MachineState {
    let s = this.machines.get(machineId);
    if (!s) {
      s = { accountId };
      this.machines.set(machineId, s);
    }
    return s;
  }

  /**
   * Register an authenticated agent leg (RELAY.md §2 agent steps 3–4).
   * Sends `agent_registered`; if a client is already waiting, pairs immediately.
   */
  registerAgent(machineId: string, accountId: string, agent: RelaySocket): void {
    const state = this.stateFor(machineId, accountId);
    state.agent = agent;

    agent.send(controlFrame("agent_registered", { machineId }));

    if (state.client) {
      // Pair: tell client we're online, tell agent a client is attached.
      state.client.send(controlFrame("machine_online"));
      agent.send(controlFrame("client_attached", { clientId: machineId }));
    }
  }

  /**
   * Register an authenticated client leg (RELAY.md §2 client step 4).
   * Single active client per machine: displaces any existing client first.
   * Pairs if an agent is present, otherwise sends `machine_offline`.
   */
  registerClient(machineId: string, accountId: string, client: RelaySocket): void {
    const state = this.stateFor(machineId, accountId);

    // Single active client: a newer client replaces the old one.
    const existing = state.client;
    if (existing && existing !== client) {
      existing.send(controlFrame("relay_error", { code: "replaced", message: "a newer client took over" }));
      existing.close(CloseCode.forbidden, "replaced");
    }

    state.client = client;

    if (state.agent) {
      client.send(controlFrame("machine_online"));
      state.agent.send(controlFrame("client_attached", { clientId: machineId }));
    } else {
      client.send(controlFrame("machine_offline", { code: "machine_offline", message: "no daemon connected" }));
    }
  }

  /**
   * Route an inbound frame from `from` (RELAY.md §5).
   * Control frames (`_relay:true`) are consumed at the edge, never cross-forwarded.
   * App frames are forwarded verbatim (the raw string, not re-serialized) to the peer.
   */
  route(machineId: string, from: Leg, raw: string): void {
    if (isControlFrame(raw)) return; // never forwarded across legs
    const state = this.machines.get(machineId);
    if (!state) return;
    const peer = from === "client" ? state.agent : state.client;
    if (peer) peer.send(raw);
  }

  /**
   * Handle a socket close (RELAY.md §6).
   * Agent close  -> client (if any) gets `machine_offline`; keep the client socket.
   * Client close -> agent (if any) gets `client_detached`; keep the agent socket.
   * Only clears the slot if `socket` is still the registered one (ignore stale closes,
   * e.g. a displaced client closing after a newer client took its slot).
   */
  handleClose(machineId: string, leg: Leg, socket: RelaySocket): void {
    const state = this.machines.get(machineId);
    if (!state) return;

    if (leg === "agent") {
      if (state.agent !== socket) return;
      state.agent = undefined;
      if (state.client) state.client.send(controlFrame("machine_offline", { code: "machine_offline", message: "daemon disconnected" }));
    } else {
      if (state.client !== socket) return;
      state.client = undefined;
      if (state.agent) state.agent.send(controlFrame("client_detached"));
    }

    // Drop fully-empty machine state so the registry doesn't leak entries.
    if (!state.agent && !state.client) this.machines.delete(machineId);
  }
}
