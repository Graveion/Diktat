import { describe, expect, test } from "bun:test";
import { loadConfig, type RelayConfig } from "./config.ts";
import {
  authResult,
  Broker,
  CloseCode,
  constantTimeEqual,
  controlFrame,
  isControlFrame,
  type RelaySocket,
} from "./broker.ts";

const DAEMON_TOKEN = "a".repeat(64);
const ACCOUNT_TOKEN = "b".repeat(64);
const OTHER_ACCOUNT_TOKEN = "c".repeat(64);

function makeConfig(): RelayConfig {
  return loadConfig({
    machines: {
      M: { daemonToken: DAEMON_TOKEN, accountId: "acct_tim" },
      OTHER: { daemonToken: "d".repeat(64), accountId: "acct_other" },
    },
    accountTokens: {
      [ACCOUNT_TOKEN]: "acct_tim",
      [OTHER_ACCOUNT_TOKEN]: "acct_other",
    },
  });
}

/** Fake socket: records every sent frame and every close. */
class FakeSocket implements RelaySocket {
  sent: string[] = [];
  closes: { code: number; reason?: string }[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(code: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
  /** Parsed control frames received. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.filter(isControlFrame).map((s) => JSON.parse(s));
  }
  types(): string[] {
    return this.frames().map((f) => f.type as string);
  }
}

// ---------------------------------------------------------------------------
// Auth — agent leg
// ---------------------------------------------------------------------------
describe("authResult: agent leg", () => {
  const config = makeConfig();

  test("valid token registers", () => {
    const r = authResult(config, "agent", "M", DAEMON_TOKEN);
    expect(r).toEqual({ ok: true, accountId: "acct_tim" });
  });

  test("unknown machineId -> 4401", () => {
    const r = authResult(config, "agent", "NOPE", DAEMON_TOKEN);
    expect(r).toEqual({ ok: false, code: CloseCode.unauthorized });
    expect(CloseCode.unauthorized).toBe(4401);
  });

  test("wrong token -> 4401 (constant-time compare still rejects)", () => {
    const r = authResult(config, "agent", "M", "x".repeat(64));
    expect(r).toEqual({ ok: false, code: 4401 });
  });

  test("wrong-length token -> 4401", () => {
    const r = authResult(config, "agent", "M", "short");
    expect(r).toEqual({ ok: false, code: 4401 });
  });
});

// ---------------------------------------------------------------------------
// Auth — client leg (incl. the critical ownership test)
// ---------------------------------------------------------------------------
describe("authResult: client leg", () => {
  const config = makeConfig();

  test("valid token + owned machine -> ok", () => {
    const r = authResult(config, "client", "M", ACCOUNT_TOKEN);
    expect(r).toEqual({ ok: true, accountId: "acct_tim" });
  });

  test("unknown account token -> 4401", () => {
    const r = authResult(config, "client", "M", "z".repeat(64));
    expect(r).toEqual({ ok: false, code: 4401 });
  });

  test("unknown machineId -> 4404", () => {
    const r = authResult(config, "client", "NOPE", ACCOUNT_TOKEN);
    expect(r).toEqual({ ok: false, code: 4404 });
  });

  test("token's account does NOT own the machine -> 4403 (ownership)", () => {
    // OTHER_ACCOUNT_TOKEN resolves to acct_other, machine M is owned by acct_tim.
    const r = authResult(config, "client", "M", OTHER_ACCOUNT_TOKEN);
    expect(r).toEqual({ ok: false, code: CloseCode.forbidden });
    expect(CloseCode.forbidden).toBe(4403);
  });
});

describe("constantTimeEqual", () => {
  test("equal", () => expect(constantTimeEqual("abc", "abc")).toBe(true));
  test("unequal same length", () => expect(constantTimeEqual("abc", "abd")).toBe(false));
  test("different length", () => expect(constantTimeEqual("abc", "abcd")).toBe(false));
});

describe("isControlFrame", () => {
  test("control frame", () => expect(isControlFrame(controlFrame("machine_online"))).toBe(true));
  test("app frame", () => expect(isControlFrame('{"type":"input","text":"hi"}')).toBe(false));
  test("non-json", () => expect(isControlFrame("not json")).toBe(false));
  test("array is not control", () => expect(isControlFrame("[1,2,3]")).toBe(false));
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------
describe("Broker pairing", () => {
  test("agent first, then client", () => {
    const b = new Broker();
    const agent = new FakeSocket();
    const client = new FakeSocket();

    b.registerAgent("M", "acct_tim", agent);
    expect(agent.types()).toEqual(["agent_registered"]);

    b.registerClient("M", "acct_tim", client);
    // client sees machine_online (agent present), agent sees client_attached.
    expect(client.types()).toEqual(["machine_online"]);
    expect(agent.types()).toEqual(["agent_registered", "client_attached"]);
  });

  test("client first (machine_offline), then agent registers (machine_online)", () => {
    const b = new Broker();
    const client = new FakeSocket();
    const agent = new FakeSocket();

    b.registerClient("M", "acct_tim", client);
    expect(client.types()).toEqual(["machine_offline"]);

    b.registerAgent("M", "acct_tim", agent);
    expect(agent.types()).toEqual(["agent_registered", "client_attached"]);
    // client now told machine_online.
    expect(client.types()).toEqual(["machine_offline", "machine_online"]);
  });

  test("agent_registered carries machineId", () => {
    const b = new Broker();
    const agent = new FakeSocket();
    b.registerAgent("M", "acct_tim", agent);
    expect(agent.frames()[0]).toMatchObject({ _relay: true, type: "agent_registered", machineId: "M" });
  });
});

// ---------------------------------------------------------------------------
// Verbatim pipe
// ---------------------------------------------------------------------------
describe("Broker verbatim pipe", () => {
  test("client app frame arrives byte-identical at agent and vice versa", () => {
    const b = new Broker();
    const agent = new FakeSocket();
    const client = new FakeSocket();
    b.registerAgent("M", "acct_tim", agent);
    b.registerClient("M", "acct_tim", client);

    // Use odd spacing / key order so re-serialization would change the bytes.
    const clientFrame = '{"type":"input","sessionId":"s","text":"hi"}';
    b.route("M", "client", clientFrame);
    expect(agent.sent[agent.sent.length - 1]).toBe(clientFrame);

    const agentFrame = '{ "type":"output",  "sessionId":"s","data":"line\\n" }';
    b.route("M", "agent", agentFrame);
    expect(client.sent[client.sent.length - 1]).toBe(agentFrame);
  });

  test("_relay frame is NOT cross-forwarded", () => {
    const b = new Broker();
    const agent = new FakeSocket();
    const client = new FakeSocket();
    b.registerAgent("M", "acct_tim", agent);
    b.registerClient("M", "acct_tim", client);

    const agentBefore = agent.sent.length;
    const clientBefore = client.sent.length;

    b.route("M", "client", controlFrame("machine_online"));
    b.route("M", "agent", '{"_relay":true,"type":"client_attached"}');

    expect(agent.sent.length).toBe(agentBefore);
    expect(client.sent.length).toBe(clientBefore);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
describe("Broker lifecycle", () => {
  test("agent close -> client gets machine_offline", () => {
    const b = new Broker();
    const agent = new FakeSocket();
    const client = new FakeSocket();
    b.registerAgent("M", "acct_tim", agent);
    b.registerClient("M", "acct_tim", client);

    b.handleClose("M", "agent", agent);
    expect(client.types()).toEqual(["machine_online", "machine_offline"]);
    // client socket kept; not closed.
    expect(client.closes).toEqual([]);
    expect(b.getState("M")?.agent).toBeUndefined();
    expect(b.getState("M")?.client).toBe(client);
  });

  test("client close -> agent gets client_detached", () => {
    const b = new Broker();
    const agent = new FakeSocket();
    const client = new FakeSocket();
    b.registerAgent("M", "acct_tim", agent);
    b.registerClient("M", "acct_tim", client);

    b.handleClose("M", "client", client);
    expect(agent.types()).toEqual(["agent_registered", "client_attached", "client_detached"]);
    expect(agent.closes).toEqual([]);
  });

  test("second client replaces first: first gets relay_error replaced + close", () => {
    const b = new Broker();
    const agent = new FakeSocket();
    const c1 = new FakeSocket();
    const c2 = new FakeSocket();
    b.registerAgent("M", "acct_tim", agent);
    b.registerClient("M", "acct_tim", c1);
    expect(c1.types()).toEqual(["machine_online"]);

    b.registerClient("M", "acct_tim", c2);

    // c1 displaced.
    expect(c1.types()).toEqual(["machine_online", "relay_error"]);
    expect(c1.frames().find((f) => f.type === "relay_error")).toMatchObject({ code: "replaced" });
    expect(c1.closes).toEqual([{ code: CloseCode.forbidden, reason: "replaced" }]);

    // c2 becomes active.
    expect(c2.types()).toEqual(["machine_online"]);
    expect(b.getState("M")?.client).toBe(c2);
  });

  test("displaced client's late close does not evict the new client", () => {
    const b = new Broker();
    const agent = new FakeSocket();
    const c1 = new FakeSocket();
    const c2 = new FakeSocket();
    b.registerAgent("M", "acct_tim", agent);
    b.registerClient("M", "acct_tim", c1);
    b.registerClient("M", "acct_tim", c2);

    // Stale close from the displaced socket must be ignored.
    b.handleClose("M", "client", c1);
    expect(b.getState("M")?.client).toBe(c2);
    // agent should NOT have received a client_detached from the stale close.
    expect(agent.types()).toEqual(["agent_registered", "client_attached", "client_attached"]);
  });

  test("registry entry is dropped once both legs are gone", () => {
    const b = new Broker();
    const agent = new FakeSocket();
    const client = new FakeSocket();
    b.registerAgent("M", "acct_tim", agent);
    b.registerClient("M", "acct_tim", client);

    b.handleClose("M", "client", client);
    b.handleClose("M", "agent", agent);
    expect(b.getState("M")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------
describe("config loader", () => {
  test("accepts an injected object", () => {
    const c = loadConfig({ machines: {}, accountTokens: {} });
    expect(c).toEqual({ machines: {}, accountTokens: {} });
  });

  test("rejects malformed machine entry", () => {
    expect(() => loadConfig({ machines: { M: { daemonToken: "x" } } as never, accountTokens: {} })).toThrow();
  });

  test("reads the example file", () => {
    const c = loadConfig(new URL("./relay-config.example.json", import.meta.url).pathname);
    expect(Object.keys(c.machines).length).toBeGreaterThan(0);
    expect(Object.keys(c.accountTokens).length).toBeGreaterThan(0);
  });
});
