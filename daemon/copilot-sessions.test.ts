import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { rowsToHistory, listCopilotSessions, readCopilotHistory, copilotSessionExists } from "./copilot-sessions";

// ── rowsToHistory (pure) ─────────────────────────────────────────────────────
test("rowsToHistory: interleaves user, tool (by turn), assistant in turn order", () => {
  const turns = [
    { turn_index: 1, user_message: "run tests", assistant_response: "all green" },
    { turn_index: 0, user_message: "hi", assistant_response: "hello" },
  ];
  const events = [
    { turn_index: 1, tool_call_id: "t1", event_type: "exec", command: "bun test", output: "25 pass", exit_code: 0 },
  ];
  const msgs = rowsToHistory(turns, events);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "tool", "assistant"]);
  const tool = msgs.find((m) => m.role === "tool")!;
  expect(tool.toolCommand).toBe("bun test");
  expect(tool.toolResult).toBe("25 pass");
});

test("rowsToHistory: skips trajectory rows without a command; uses exit code as result", () => {
  const turns = [{ turn_index: 0, user_message: "x", assistant_response: "y" }];
  const events = [
    { turn_index: 0, tool_call_id: null, event_type: "thinking", command: null, output: null, exit_code: null },
    { turn_index: 0, tool_call_id: "t2", event_type: "exec", command: "ls", output: null, exit_code: 2 },
  ];
  const msgs = rowsToHistory(turns, events);
  const tools = msgs.filter((m) => m.role === "tool");
  expect(tools.length).toBe(1);
  expect(tools[0]!.toolResult).toBe("exit 2");
});

test("rowsToHistory: honors the limit (keeps the last N)", () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({ turn_index: i, user_message: `u${i}`, assistant_response: `a${i}` }));
  const msgs = rowsToHistory(turns, [], 4);
  expect(msgs.length).toBe(4);
  expect(msgs[3]!.text).toBe("a29");
});

// ── disk-level against a synthetic session-store.db ──────────────────────────
function withDb(fn: (dbPath: string) => void, opts: { withTraj?: boolean } = { withTraj: true }) {
  const dir = mkdtempSync(join(tmpdir(), "diktat-copilot-"));
  const dbPath = join(dir, "session-store.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);`);
  db.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT);`);
  if (opts.withTraj) {
    db.exec(`CREATE TABLE forge_trajectory_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, tool_call_id TEXT, turn_index INTEGER, event_type TEXT, command TEXT, output TEXT, exit_code INTEGER, event_key TEXT, event_value TEXT);`);
  }
  db.exec(`INSERT INTO sessions (id, cwd, summary, updated_at) VALUES ('s1', '/Users/me/proj', 'fix the bug', '2026-06-09T10:00:00Z');`);
  db.exec(`INSERT INTO sessions (id, cwd, summary, updated_at) VALUES ('s2', '/Users/me/other', '', '2026-06-08T10:00:00Z');`);
  db.exec(`INSERT INTO turns (session_id, turn_index, user_message, assistant_response) VALUES ('s1', 0, 'whats broken', 'looking');`);
  db.exec(`INSERT INTO turns (session_id, turn_index, user_message, assistant_response) VALUES ('s1', 1, 'fix it', 'fixed');`);
  db.exec(`INSERT INTO turns (session_id, turn_index, user_message, assistant_response) VALUES ('s2', 0, 'hello there world', 'hi');`);
  if (opts.withTraj) {
    db.exec(`INSERT INTO forge_trajectory_events (session_id, tool_call_id, turn_index, event_type, command, output, exit_code) VALUES ('s1', 'c1', 1, 'exec', 'make', 'ok', 0);`);
  }
  db.close();
  try {
    fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("listCopilotSessions: lists with cwd, summary (or first user msg), ordered by updated_at", () => {
  withDb((dbPath) => {
    const sessions = listCopilotSessions(dbPath);
    expect(sessions.map((s) => s.id)).toEqual(["s1", "s2"]); // s1 newer
    expect(sessions[0]!.project).toBe("/Users/me/proj");
    expect(sessions[0]!.projectLabel).toBe("proj");
    expect(sessions[0]!.firstMessage).toBe("fix the bug"); // from summary
    expect(sessions[1]!.firstMessage).toBe("hello there world"); // falls back to first turn
  });
});

test("readCopilotHistory: reads turns + tool card", () => {
  withDb((dbPath) => {
    const msgs = readCopilotHistory("s1", 20, dbPath);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "tool", "assistant"]);
    expect(msgs.find((m) => m.role === "tool")!.toolCommand).toBe("make");
  });
});

test("readCopilotHistory: tolerates a missing forge_trajectory_events table", () => {
  withDb((dbPath) => {
    const msgs = readCopilotHistory("s1", 20, dbPath);
    expect(msgs.filter((m) => m.role === "tool").length).toBe(0);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  }, { withTraj: false });
});

test("copilotSessionExists / missing DB returns empty", () => {
  withDb((dbPath) => {
    expect(copilotSessionExists("s1", dbPath)).toBe(true);
    expect(copilotSessionExists("nope", dbPath)).toBe(false);
  });
  expect(listCopilotSessions("/no/such/session-store.db")).toEqual([]);
  expect(readCopilotHistory("s1", 20, "/no/such/session-store.db")).toEqual([]);
});
