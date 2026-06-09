import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { parseKiroConversation, listKiroSessions, readKiroHistory, kiroSessionExists } from "./kiro-sessions";
import type { StoredConversation } from "./kiro-conversation";

// Build a ConversationState the way Amazon Q serializes it (externally tagged).
function conv(id: string, entries: any[]): StoredConversation {
  return {
    conversation_id: id,
    next_message: null,
    history: entries,
    valid_history_range: [0, entries.length],
    transcript: [],
    tools: {},
    context_manager: null,
    context_message_length: null,
    latest_summary: null,
    file_line_tracker: {},
    checkpoint_manager: null,
    mcp_enabled: true,
  } as StoredConversation;
}
const userPrompt = (prompt: string, timestamp: string | null = null) => ({
  user: { additional_context: "", env_context: { env_state: null }, content: { Prompt: { prompt } }, timestamp, images: null },
});
const asstResponse = (content: string) => ({ Response: { message_id: null, content } });
const asstToolUse = (content: string, tool_uses: any[]) => ({ ToolUse: { message_id: null, content, tool_uses } });
const toolUse = (id: string, name: string, args: any) => ({ id, name, orig_name: name, args, orig_args: args });
const userToolResults = (results: any[]) => ({
  user: { additional_context: "", env_context: { env_state: null }, content: { ToolUseResults: { tool_use_results: results } }, timestamp: null, images: null },
});

// ── parseKiroConversation (pure) ─────────────────────────────────────────────
test("parseKiroConversation: maps Prompt/Response pairs to user/assistant", () => {
  const c = conv("k1", [
    { ...userPrompt("hello"), assistant: asstResponse("hi there") },
  ]);
  expect(parseKiroConversation(c)).toEqual([
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi there" },
  ]);
});

test("parseKiroConversation: ToolUse → Bash card, result attached from a later ToolUseResults turn", () => {
  const c = conv("k2", [
    { ...userPrompt("run tests"), assistant: asstToolUse("running", [toolUse("tu1", "execute_bash", { command: "bun test" })]) },
    { ...userToolResults([{ tool_use_id: "tu1", content: [{ Text: "25 pass" }], status: "Success" }]), assistant: asstResponse("done") },
  ]);
  const msgs = parseKiroConversation(c);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  const tool = msgs.find((m) => m.role === "tool")!;
  expect(tool.toolName).toBe("Bash:bun test");
  expect(tool.toolCommand).toBe("bun test");
  expect(tool.toolResult).toBe("25 pass");
});

test("parseKiroConversation: fs_write str_replace → Edit; fs_read → Read", () => {
  const c = conv("k3", [
    { ...userPrompt("edit"), assistant: asstToolUse("", [toolUse("e1", "fs_write", { path: "/a/b.ts", old_str: "foo", new_str: "bar" })]) },
    { ...userPrompt("read"), assistant: asstToolUse("", [toolUse("r1", "fs_read", { path: "/a/b.ts" })]) },
  ]);
  const tools = parseKiroConversation(c).filter((m) => m.role === "tool");
  expect(tools[0]!.toolName).toBe("Edit:b.ts");
  expect(tools[0]!.toolDiff).toContain("- foo");
  expect(tools[0]!.toolDiff).toContain("+ bar");
  expect(tools[1]!.toolName).toBe("Read:b.ts");
});

test("parseKiroConversation: tolerates a JSON string and bad input", () => {
  const c = conv("k4", [{ ...userPrompt("x"), assistant: asstResponse("y") }]);
  expect(parseKiroConversation(JSON.stringify(c)).length).toBe(2);
  expect(parseKiroConversation("{ not json")).toEqual([]);
});

// ── disk-level against a synthetic data.sqlite3 ──────────────────────────────
function withDb(fn: (dbPath: string) => void, opts: { withTable?: boolean } = { withTable: true }) {
  const dir = mkdtempSync(join(tmpdir(), "diktat-kiro-"));
  const dbPath = join(dir, "data.sqlite3");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT);`); // always present
  if (opts.withTable) {
    db.exec(`CREATE TABLE conversations (key TEXT PRIMARY KEY, value TEXT);`);
    const c1 = conv("k1", [{ ...userPrompt("older q", "2026-06-08T10:00:00+00:00"), assistant: asstResponse("a1") }]);
    const c2 = conv("k2", [{ ...userPrompt("newer q", "2026-06-09T10:00:00+00:00"), assistant: asstResponse("a2") }]);
    db.query("INSERT INTO conversations (key, value) VALUES (?, ?)").run("/Users/me/old", JSON.stringify(c1));
    db.query("INSERT INTO conversations (key, value) VALUES (?, ?)").run("/Users/me/new", JSON.stringify(c2));
  }
  db.close();
  try {
    fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("listKiroSessions: lists conversations keyed by cwd, newest first", () => {
  withDb((dbPath) => {
    const sessions = listKiroSessions(dbPath);
    expect(sessions.map((s) => s.id)).toEqual(["k2", "k1"]); // k2 has newer timestamp
    expect(sessions[0]!.project).toBe("/Users/me/new");
    expect(sessions[0]!.projectLabel).toBe("new");
    expect(sessions[0]!.firstMessage).toBe("newer q");
  });
});

test("readKiroHistory + kiroSessionExists: by conversation_id", () => {
  withDb((dbPath) => {
    expect(readKiroHistory("k1", 20, dbPath)).toEqual([
      { role: "user", text: "older q" },
      { role: "assistant", text: "a1" },
    ]);
    expect(kiroSessionExists("k2", dbPath)).toBe(true);
    expect(kiroSessionExists("nope", dbPath)).toBe(false);
  });
});

test("kiro readers tolerate a missing conversations table and a missing DB", () => {
  withDb((dbPath) => {
    expect(listKiroSessions(dbPath)).toEqual([]);
    expect(readKiroHistory("k1", 20, dbPath)).toEqual([]);
    expect(kiroSessionExists("k1", dbPath)).toBe(false);
  }, { withTable: false });
  expect(listKiroSessions("/no/such/data.sqlite3")).toEqual([]);
});
