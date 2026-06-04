# Diktat Relay — Wire Protocol (Tier 0)

The relay lets a phone reach its daemon **without Tailscale, from anywhere**. The
daemon dials *out* to the relay; the phone connects *in*; the relay brokers the
existing app↔daemon protocol between them **verbatim**.

> **Hard rule:** the asset behind the relay is arbitrary shell execution on the
> user's machine (`Shell(*)`). The relay MUST authenticate both legs and enforce
> ownership before brokering a single byte. Never expose an unauthenticated path.

This document is the contract that the **broker** (`relay/`), the **daemon relay
client** (`daemon/relay-client.ts`), and the **app transport** (`useDiktat.ts`)
all implement. If they agree with this file, they interoperate.

---

## 1. Roles & sockets

```
  ┌─────────┐  wss /agent  (daemon-initiated, long-lived, idle)  ┌────────┐  wss /client (phone-initiated)  ┌───────┐
  │ daemon  │ ───────────────────────────────────────────────▶ │ RELAY  │ ◀───────────────────────────── │ phone │
  └─────────┘  Bearer <daemonToken>, ?machineId=…               └────────┘  Bearer <accountToken>, ?machineId=…  └───────┘
```

- **Agent leg** (`/agent`): one outbound WebSocket per machine, opened at daemon
  start, held open. Carries the daemon→phone direction and receives phone→daemon
  frames.
- **Client leg** (`/client`): opened by the app when the user opens a machine.
  One active client per machine in Tier 0 (a second client for the same machine
  replaces the first; the displaced client gets `relay_error: replaced`).

## 2. Authentication (Tier 0: static config; Phase 1: DB + JWT)

The relay loads a static registry (JSON/env) modelling the future DB:

```jsonc
{
  "machines": {
    "<machineId>": { "daemonToken": "<256-bit hex>", "accountId": "<accountId>" }
  },
  "accountTokens": { "<accountToken>": "<accountId>" }
}
```

**Agent leg handshake** — `GET /agent?machineId=M` with header
`Authorization: Bearer <daemonToken>`:
1. Look up `machines[M]`. Missing → close `4401` (unauthorized).
2. Constant-time compare token against `machines[M].daemonToken`. Mismatch → close `4401`.
3. Register `registry[M].agent = thisSocket`, record `accountId`. Send `agent_registered`.
4. If a client is already waiting for `M`, pair immediately (send `client_attached` to agent, `machine_online` to client).

**Client leg handshake** — `GET /client?machineId=M` with header
`Authorization: Bearer <accountToken>`:
1. Resolve `accountId = accountTokens[token]`. Missing → close `4401`.
2. Look up `machines[M]`. Missing → close `4404` (no such machine).
3. **Ownership check:** `machines[M].accountId === accountId`. Mismatch → close `4403` (forbidden). *This is the check that stops anyone driving someone else's shell.*
4. Register `registry[M].client = thisSocket`. If an agent is connected → pair; send `machine_online` to client, `client_attached` to agent. Else send `machine_offline` to client (keep the socket; the daemon may come online).

> Tier 0 tokens are static secrets. Phase 1 swaps step 1 of each leg for: daemon
> token → hashed lookup + revocation; account token → verify a Diktat-issued JWT
> (minted after Sign in with Apple). The handshake shape and ownership rule are
> unchanged — only credential verification is upgraded.

All connections are `wss` (TLS terminated by the tunnel in dev / the host in prod).

## 3. Framing

Every WebSocket message is a JSON object with a `type` field.

- **Control frames** (relay-originated or relay-terminated) carry `"_relay": true`.
  They are handled at the transport layer and never reach app message dispatch.
- **App frames** (everything in PROTOCOL.md §5 — `spawn`, `resume`, `input`,
  `cancel`, `register_push`, `ping` / `connected`, `spawned`, `resumed`,
  `history`, `output`, `tool_use`, `tool_result`, `exit`, `error`, `pong`) are
  passed through **byte-for-byte unchanged**. The relay does not parse, validate,
  or rewrite them. It only routes: agent→client and client→agent.

The `_relay` discriminator keeps the two namespaces from ever colliding. A direct
(Tailscale) connection never sees a `_relay` frame, so the app/daemon handle them
only in relay mode.

## 4. Control frames

All include `"_relay": true`.

| `type` | Direction | Meaning |
|---|---|---|
| `agent_registered` | relay → daemon | Agent leg authenticated & registered. `{ machineId }`. |
| `client_attached` | relay → daemon | A phone attached; daemon should (re)send its `connected` payload. `{ clientId }` (opaque; Tier 0 single-client, informational). |
| `client_detached` | relay → daemon | The phone disconnected. Daemon keeps sessions running. |
| `machine_online` | relay → phone | The daemon is connected; normal brokering is live. |
| `machine_offline` | relay → phone | No daemon connected for this machine (asleep/offline). Phone keeps the relay socket and shows "reconnecting to Mac" — it does NOT tear down/back off. |
| `relay_error` | relay → either | `{ code, message }`. Codes: `machine_offline` (no agent yet), `replaced` (a newer client took over), `unauthorized`, `forbidden`. Sent before a close where applicable. |

Close codes: `4401` unauthorized, `4403` forbidden (ownership), `4404` unknown machine.

## 5. Brokering rules

Once an agent and client are paired for a machine `M`:
- Any **app frame** from the client socket → forwarded verbatim to `registry[M].agent`.
- Any **app frame** from the agent socket → forwarded verbatim to `registry[M].client`.
- `_relay` frames are never forwarded across; they are produced/consumed at the relay edge.
- The relay holds no application state and parses no app frame. Backpressure: rely on the platform's WS buffering for Tier 0.

## 6. Lifecycle

```
DAEMON START (relay mode)
  daemon ──▶ relay:  GET /agent?machineId=M   Authorization: Bearer <daemonToken>
  relay  ──▶ daemon: {_relay, type:"agent_registered", machineId:M}

PHONE OPENS MACHINE M
  phone ──▶ relay:   GET /client?machineId=M  Authorization: Bearer <accountToken>
  relay verifies token → accountId; asserts machines[M].accountId == accountId
  if agent connected:
     relay ──▶ phone:  {_relay, type:"machine_online"}
     relay ──▶ daemon: {_relay, type:"client_attached", clientId}
     daemon ──▶ (agent→relay→phone): {type:"connected", clis, projects, sessions}
  else:
     relay ──▶ phone:  {_relay, type:"machine_offline"}

ACTIVE SESSION (verbatim pipe; PROTOCOL.md §5 unchanged)
  phone  ──▶ daemon:  {type:"resume", sessionId, ...}
  daemon ──▶ phone:   {type:"output"...}{type:"tool_use"...}{type:"exit",code}

DAEMON DROPS WHILE PHONE CONNECTED
  agent socket closes → relay ──▶ phone: {_relay, type:"machine_offline"}
  phone keeps relay socket, shows "reconnecting to Mac" (no backoff teardown)
  daemon reconnects /agent → relay ──▶ phone: {_relay, type:"machine_online"}
  phone re-resumes its active session (existing pendingResume logic)

PHONE DISCONNECTS
  client socket closes → relay ──▶ daemon: {_relay, type:"client_detached"}
  daemon keeps its CLI processes running (push fires on completion as today)
```

## 7. Reconnection

- **Daemon agent leg:** new in relay mode — reconnect with jittered backoff
  (mirror the app's 5s→30s in `useDiktat.ts`). The daemon process stays up across
  a transient agent-leg drop, so in-flight CLI `activeSessions` survive; on
  reconnect it re-registers and the phone re-resumes.
- **Phone client leg:** existing backoff applies to the *relay* socket. But a
  `machine_offline` control frame is a **soft** state — the relay socket is
  healthy, only the daemon is away — so the app must NOT treat it as a socket
  teardown; it keeps the relay socket and waits for `machine_online`.
- **Keep-alives:** the app's 30s ping still flows (verbatim) to the daemon. The
  daemon sends an agent-leg ping at a similar cadence to defeat platform/proxy
  idle timeouts.

## 8. Push (Tier 0 / MVP)

Unchanged — daemon-direct. The phone's `register_push` flows verbatim through the
relay to the daemon; the daemon POSTs to Expo on session-exit-while-closed exactly
as today. Relay-held push tokens (for daemon-offline notifications) are a later
phase, out of scope here.

## 9. What changes vs. PROTOCOL.md

| | |
|---|---|
| §1–§4 (CLI blob/stream/JSONL formats) | unchanged — daemon-internal, relay never sees them |
| §5 app↔daemon message **bodies** | unchanged — transported verbatim |
| Transport | `ws://100.x:9000` (direct) → `wss://relay/{agent,client}` (relayed) |
| New | this relay control namespace (`_relay: true` frames), additive; direct mode never emits or receives it |

## 10. Threat model (Tier 0)

| Threat | Mitigation |
|---|---|
| Attacker drives a victim's shell via the relay | Client leg requires a valid account token AND `machines[M].accountId === accountId`. |
| Attacker impersonates a daemon | Agent leg requires the per-machine `daemonToken` (constant-time compared). |
| Stolen daemon token | Per-machine + revocable (remove the registry entry). Phase 1: hashed at rest + rotation. |
| MITM | `wss`/TLS on both legs. |
| Relay operator sees plaintext | Accepted residual for Tier 0 (relay must pipe JSON). E2E encryption is a documented Phase-4 option. |
| Unauthenticated local mode | The free Tailscale path is unchanged and stays trusted-network-only; relay mode is the only internet-exposed path and it is authenticated. |
| DoS / connection floods | Per-IP connection rate limit + auth-before-pair at the edge (Phase 1+; minimal in Tier 0). |
