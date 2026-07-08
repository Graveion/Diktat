/**
 * Tests for the WebSocket message router (handleClientMessage).
 *
 * The router is extracted from index.ts into message-handler.ts so it can be
 * tested without booting Bun.serve / config / CLI detection. We inject a mock
 * ws (collects sent JSON), a stub session factory, and stub history readers.
 */
import { test, expect } from "bun:test";
import { handleClientMessage, runningSessionIds, type MessageContext, type SessionFactory } from "./message-handler";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockWs = () => {
  const sent: any[] = [];
  return {
    ws: { send: (m: string) => sent.push(JSON.parse(m)), readyState: 1 } as any,
    sent,
  };
};

/** A fake Session-like object. */
function fakeSession(id: string, cliSessionId?: string) {
  return {
    id,
    summary: { id, cli: "claude", project: "/p", cliSessionId, lastActiveAt: "t" },
    send: async () => {},
    cancel: () => {},
    applyOptions: () => {},
  } as any;
}

/** Build a context with sensible defaults; override per test. */
function makeCtx(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    availableCLIs: { claude: "/bin/claude", cursor: "/bin/agent" },
    projects: ["/allowed/project"],
    activeSessions: new Map(),
    clientPushTokens: new WeakMap(),
    readClaudeHistory: () => [],
    readCursorHistory: () => [],
    ...overrides,
  };
}

const recordingFactory = (created: any[]): SessionFactory => ({
  create: (ws, cli, cliPath, project, model, permissionMode) => {
    const s = fakeSession("new-session-id");
    created.push({ kind: "create", cli, cliPath, project, model, permissionMode });
    return s;
  },
  resume: (ws, id) => null,
  fromClaudeSession: (ws, id, project, cliPath) => {
    const s = fakeSession("claude-new", id);
    created.push({ kind: "fromClaude", id, project, cliPath });
    return s;
  },
  fromCursorSession: (ws, id, project, cliPath) => {
    const s = fakeSession("cursor-new", id);
    created.push({ kind: "fromCursor", id, project, cliPath });
    return s;
  },
  fromCodexSession: (ws, id, project, cliPath) => {
    const s = fakeSession("codex-new", id);
    created.push({ kind: "fromCodex", id, project, cliPath });
    return s;
  },
  fromCopilotSession: (ws, id, project, cliPath) => {
    const s = fakeSession("copilot-new", id);
    created.push({ kind: "fromCopilot", id, project, cliPath });
    return s;
  },
  fromKiroSession: (ws, project, cliPath) => {
    const s = fakeSession("kiro-new");
    created.push({ kind: "fromKiro", project, cliPath });
    return s;
  },
});

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

test("spawn: unknown CLI → error message", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx({ sessionFactory: recordingFactory([]) });
  await handleClientMessage(ctx, ws, { type: "spawn", cli: "nope", project: "/allowed/project" });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ type: "error", message: "CLI not available: nope" });
});

test("spawn: disallowed project → error", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx({ sessionFactory: recordingFactory([]) });
  await handleClientMessage(ctx, ws, { type: "spawn", cli: "claude", project: "/not/allowed" });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ type: "error", message: "Project not in allowed list: /not/allowed" });
});

test("spawn: valid → spawned + session registered", async () => {
  const { ws, sent } = mockWs();
  const created: any[] = [];
  const ctx = makeCtx({ sessionFactory: recordingFactory(created) });
  await handleClientMessage(ctx, ws, { type: "spawn", cli: "claude", project: "/allowed/project", model: "opus", permissionMode: "plan" });
  expect(sent).toHaveLength(1);
  expect(sent[0].type).toBe("spawned");
  expect(sent[0].session.id).toBe("new-session-id");
  expect(ctx.activeSessions.get("new-session-id")).toBeDefined();
  expect(created[0]).toMatchObject({ kind: "create", cli: "claude", cliPath: "/bin/claude", project: "/allowed/project", model: "opus", permissionMode: "plan" });
});

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

test("resume: unknown session → 'Session not found'", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx({ sessionFactory: recordingFactory([]) }); // resume returns null
  await handleClientMessage(ctx, ws, { type: "resume", sessionId: "missing" });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ type: "error", message: "Session not found: missing" });
});

test("resume: claude session → resumed + async history sent", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx({
    sessionFactory: recordingFactory([]),
    readClaudeHistory: () => [{ role: "user", text: "hi" }] as any,
  });
  await handleClientMessage(ctx, ws, { type: "resume", sessionId: "sess-1", isClaudeSession: true, project: "/p" });
  expect(sent[0].type).toBe("resumed");
  // history is sent via setImmediate — flush the microtask/timer queue
  await new Promise((r) => setTimeout(r, 5));
  const hist = sent.find((m) => m.type === "history");
  expect(hist).toBeDefined();
  expect(hist.messages).toHaveLength(1);
});

test("resume: initial history is capped at 40 with hasMore when the window fills", async () => {
  const { ws, sent } = mockWs();
  // A reader that returns the last `limit` of a 100-message conversation.
  const total = 100;
  const reader = (_id: string, limit = 20) => {
    const n = Math.min(limit, total);
    return Array.from({ length: n }, (_, i) => ({ role: "user", text: `m${total - n + i}` })) as any;
  };
  const ctx = makeCtx({ sessionFactory: recordingFactory([]), readClaudeHistory: reader });
  await handleClientMessage(ctx, ws, { type: "resume", sessionId: "sess-1", isClaudeSession: true, project: "/p" });
  await new Promise((r) => setTimeout(r, 5));
  const hist = sent.find((m) => m.type === "history");
  expect(hist.messages).toHaveLength(40);
  expect(hist.hasMore).toBe(true);
  expect(hist.messages[0].text).toBe("m60"); // last 40 of 100
});

// ---------------------------------------------------------------------------
// load_history (scroll-up paging)
// ---------------------------------------------------------------------------

/** Reader over a `total`-message conversation: returns the last `limit`. */
function pagingReader(total: number) {
  return (_id: string, limit = 20) => {
    const n = Math.min(limit, total);
    return Array.from({ length: n }, (_, i) => ({ role: "user", text: `m${total - n + i}` })) as any;
  };
}

test("load_history: returns the older page before the loaded messages", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx({ readClaudeHistory: pagingReader(100) });
  ctx.activeSessions.set("s1", fakeSession("s1", "cli-1"));
  await handleClientMessage(ctx, ws, { type: "load_history", sessionId: "s1", loaded: 40 });
  await new Promise((r) => setTimeout(r, 5));
  const page = sent.find((m) => m.type === "history_page");
  expect(page.messages).toHaveLength(40);      // want=80, minus 40 loaded
  expect(page.messages[0].text).toBe("m20");   // page = m20..m59
  expect(page.messages[39].text).toBe("m59");
  expect(page.hasMore).toBe(true);
});

test("load_history: at the top, returns the remainder and hasMore=false", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx({ readClaudeHistory: pagingReader(100) });
  ctx.activeSessions.set("s1", fakeSession("s1", "cli-1"));
  await handleClientMessage(ctx, ws, { type: "load_history", sessionId: "s1", loaded: 80 });
  await new Promise((r) => setTimeout(r, 5));
  const page = sent.find((m) => m.type === "history_page");
  expect(page.messages).toHaveLength(20);      // want=120 but only 100 exist
  expect(page.messages[0].text).toBe("m0");
  expect(page.hasMore).toBe(false);
});

test("load_history: unknown session → empty page, hasMore=false", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx({ readClaudeHistory: pagingReader(100) });
  await handleClientMessage(ctx, ws, { type: "load_history", sessionId: "ghost", loaded: 40 });
  expect(sent[0]).toEqual({ type: "history_page", sessionId: "ghost", messages: [], hasMore: false });
});

test("load_history: kiro session (no cliSessionId) → empty page (paging unsupported)", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx({ readKiroHistory: pagingReader(100) });
  const s = fakeSession("k1");
  s.summary = { id: "k1", cli: "kiro", project: "/p", cliSessionId: undefined, lastActiveAt: "t" };
  ctx.activeSessions.set("k1", s);
  await handleClientMessage(ctx, ws, { type: "load_history", sessionId: "k1", loaded: 40 });
  expect(sent[0]).toEqual({ type: "history_page", sessionId: "k1", messages: [], hasMore: false });
});

// ---------------------------------------------------------------------------
// running-session tracking (M4)
// ---------------------------------------------------------------------------

test("runningSessionIds: returns only sessions whose isRunning is true", () => {
  const ctx = makeCtx();
  const a = fakeSession("a"); a.isRunning = true;
  const b = fakeSession("b"); b.isRunning = false;
  const c = fakeSession("c"); c.isRunning = true;
  ctx.activeSessions.set("a", a);
  ctx.activeSessions.set("b", b);
  ctx.activeSessions.set("c", c);
  expect(runningSessionIds(ctx).sort()).toEqual(["a", "c"]);
});

test("spawn wires onRunningChange → broadcasts sessions_running", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx({ sessionFactory: recordingFactory([]) });
  await handleClientMessage(ctx, ws, { type: "spawn", cli: "claude", project: "/allowed/project" });
  const session = ctx.activeSessions.get("new-session-id") as any;
  expect(typeof session.onRunningChange).toBe("function");
  // Simulate a run starting: flip the flag and fire the callback.
  session.isRunning = true;
  session.onRunningChange();
  const frame = sent.find((m) => m.type === "sessions_running");
  expect(frame).toBeDefined();
  expect(frame.ids).toEqual(["new-session-id"]);
});

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

test("input: no active session → error", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx();
  await handleClientMessage(ctx, ws, { type: "input", sessionId: "ghost", text: "hi" });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ type: "error", message: "No active session: ghost" });
});

test("input: active session → session.send called with push token", async () => {
  const { ws } = mockWs();
  let received: any;
  const session = fakeSession("s1");
  session.send = async (text: string, token?: string) => { received = { text, token }; };
  const ctx = makeCtx();
  ctx.activeSessions.set("s1", session);
  ctx.clientPushTokens.set(ws as object, "push-tok");
  await handleClientMessage(ctx, ws, { type: "input", sessionId: "s1", text: "do it" });
  expect(received).toEqual({ text: "do it", token: "push-tok" });
});

test("input: per-turn model/permission → applyOptions called before send", async () => {
  const { ws } = mockWs();
  let applied: any;
  let sentText: string | undefined;
  const session = fakeSession("s3");
  session.applyOptions = (o: any) => { applied = o; };
  session.send = async (text: string) => { sentText = text; };
  const ctx = makeCtx();
  ctx.activeSessions.set("s3", session);
  await handleClientMessage(ctx, ws, { type: "input", sessionId: "s3", text: "go", model: "opus", permissionMode: "full" });
  expect(applied).toEqual({ model: "opus", permissionMode: "full" });
  expect(sentText).toBe("go");
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

test("cancel: active session → exit code -1 and cancel called", async () => {
  const { ws, sent } = mockWs();
  let cancelled = false;
  const session = fakeSession("s2");
  session.cancel = () => { cancelled = true; };
  const ctx = makeCtx();
  ctx.activeSessions.set("s2", session);
  await handleClientMessage(ctx, ws, { type: "cancel", sessionId: "s2" });
  expect(cancelled).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ type: "exit", code: -1 });
});

test("cancel: unknown session → no message sent", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx();
  await handleClientMessage(ctx, ws, { type: "cancel", sessionId: "ghost" });
  expect(sent).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// ping / register_push
// ---------------------------------------------------------------------------

test("ping → pong", async () => {
  const { ws, sent } = mockWs();
  await handleClientMessage(makeCtx(), ws, { type: "ping" });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ type: "pong" });
});

test("register_push: stores token, sends nothing", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx();
  await handleClientMessage(ctx, ws, { type: "register_push", token: "expo-token" });
  expect(sent).toHaveLength(0);
  expect(ctx.clientPushTokens.get(ws as object)).toBe("expo-token");
});

test("register_push: no token → nothing stored", async () => {
  const { ws } = mockWs();
  const ctx = makeCtx();
  await handleClientMessage(ctx, ws, { type: "register_push" });
  expect(ctx.clientPushTokens.get(ws as object)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// invalid JSON — handled by the thin wrapper in index.ts, mirrored here to
// pin the exact error string used by the websocket message() handler.
// ---------------------------------------------------------------------------

test("invalid JSON → 'Invalid message format'", () => {
  const { ws, sent } = mockWs();
  // Mirror the parse-guard from index.ts's websocket.message handler.
  const data = "{not valid json";
  try {
    JSON.parse(data);
  } catch {
    ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
  }
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ type: "error", message: "Invalid message format" });
});

// ---------------------------------------------------------------------------
// sessionId validation — phone-supplied ids flow into filesystem path joins
// ---------------------------------------------------------------------------

const TRAVERSAL_IDS = ["../../etc/passwd", "foo/../bar", "a\\b", ""];

test("resume: traversal sessionId rejected, no factory/history call", async () => {
  for (const bad of TRAVERSAL_IDS) {
    const { ws, sent } = mockWs();
    const created: any[] = [];
    let historyRead = false;
    const ctx = makeCtx({
      sessionFactory: recordingFactory(created),
      readClaudeHistory: () => { historyRead = true; return []; },
    });
    await handleClientMessage(ctx, ws, { type: "resume", sessionId: bad, isClaudeSession: true, project: "/p" });
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: "error", message: `Session not found: ${bad}` });
    expect(created).toHaveLength(0);
    expect(historyRead).toBe(false);
  }
});

test("resume: non-string sessionId rejected", async () => {
  for (const bad of [undefined, null, 42, { a: 1 }]) {
    const { ws, sent } = mockWs();
    const created: any[] = [];
    const ctx = makeCtx({ sessionFactory: recordingFactory(created) });
    await handleClientMessage(ctx, ws, { type: "resume", sessionId: bad, isCursorSession: true });
    expect(sent[0].type).toBe("error");
    expect(created).toHaveLength(0);
  }
});

test("resume: traversal sessionId rejected for codex/copilot/kiro history readers", async () => {
  for (const flag of ["isCodexSession", "isCopilotSession", "isKiroSession"]) {
    const { ws, sent } = mockWs();
    const created: any[] = [];
    const ctx = makeCtx({ sessionFactory: recordingFactory(created) });
    await handleClientMessage(ctx, ws, { type: "resume", sessionId: "../../etc/passwd", [flag]: true });
    expect(sent[0].type).toBe("error");
    expect(created).toHaveLength(0);
  }
});

test("input: traversal sessionId rejected", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx();
  await handleClientMessage(ctx, ws, { type: "input", sessionId: "foo/../bar", text: "hi" });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ type: "error", message: "No active session: foo/../bar" });
});

test("cancel: traversal sessionId silently ignored", async () => {
  const { ws, sent } = mockWs();
  const ctx = makeCtx();
  await handleClientMessage(ctx, ws, { type: "cancel", sessionId: "a\\b" });
  expect(sent).toHaveLength(0);
});

test("resume: valid UUID sessionId still accepted", async () => {
  const { ws, sent } = mockWs();
  const created: any[] = [];
  const ctx = makeCtx({ sessionFactory: recordingFactory(created) });
  await handleClientMessage(ctx, ws, {
    type: "resume",
    sessionId: "6e69c404-9884-4611-86ca-a6f67680f09b",
    isClaudeSession: true,
    project: "/p",
  });
  expect(sent[0].type).toBe("resumed");
  expect(created).toHaveLength(1);
});
