import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { toolDisplayName, readHistory, listClaudeSessions } from "./claude-sessions";

// ---------------------------------------------------------------------------
// toolDisplayName — pure exported function, tested directly
// ---------------------------------------------------------------------------

test("toolDisplayName: Read with file_path → Read:<basename>", () => {
  expect(toolDisplayName("Read", { file_path: "/a/b/c.ts" })).toBe("Read:c.ts");
});

test("toolDisplayName: Bash with long command → Bash: + first 35 chars", () => {
  const cmd = "x".repeat(50);
  expect(toolDisplayName("Bash", { command: cmd })).toBe("Bash:" + "x".repeat(35));
});

test("toolDisplayName: AwaitShell special case → Bash:<command>", () => {
  expect(toolDisplayName("AwaitShell", { command: "npm test" })).toBe("Bash:npm test");
});

test("toolDisplayName: call_mcp_tool with empty input → Task", () => {
  expect(toolDisplayName("call_mcp_tool", {})).toBe("Task");
});

test("toolDisplayName: StrReplace with path → Edit:<basename>", () => {
  expect(toolDisplayName("StrReplace", { path: "/x/y.ts" })).toBe("Edit:y.ts");
});

test("toolDisplayName: Unknown tool with null input → canonical name unchanged", () => {
  expect(toolDisplayName("Unknown", null)).toBe("Unknown");
});

test("toolDisplayName: canonical aliases without input return canonical name", () => {
  expect(toolDisplayName("ReadFile", null)).toBe("Read");
  expect(toolDisplayName("ApplyPatch", null)).toBe("Edit");
  expect(toolDisplayName("rg", null)).toBe("Grep");
  expect(toolDisplayName("Delete", null)).toBe("Write");
  expect(toolDisplayName("CallMcpTool", null)).toBe("Task");
});

test("toolDisplayName: path takes priority over command", () => {
  expect(toolDisplayName("Bash", { path: "/p/q.sh", command: "echo hi" })).toBe("Bash:q.sh");
});

// ---------------------------------------------------------------------------
// readHistory — exercises the REAL function against a temp projectsDir, passed
// via the injectable third parameter. Layout: <projectsDir>/<proj>/<id>.jsonl
// ---------------------------------------------------------------------------

let projectsDir: string;
let fixtureDir: string;
const sessionId = `test-session-${Date.now()}`;

function writeSession(lines: object[]) {
  writeFileSync(
    join(fixtureDir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

function readHistoryTmp(id = sessionId, limit = 20) {
  return readHistory(id, limit, projectsDir);
}

beforeAll(() => {
  projectsDir = join(tmpdir(), `diktat-claude-test-${Date.now()}`);
  fixtureDir = join(projectsDir, "encoded-project-dir");
  mkdirSync(fixtureDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(projectsDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

test("readHistory: parses user/assistant text and tool_use + tool_result", () => {
  writeSession([
    { type: "user", message: { content: "What files exist?" } },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: "index.ts\nsession.ts" },
        ],
      },
    },
  ]);

  const messages = readHistoryTmp();

  const userMsg = messages.find((m) => m.role === "user");
  expect(userMsg?.text).toBe("What files exist?");

  const assistantMsg = messages.find((m) => m.role === "assistant");
  expect(assistantMsg?.text).toBe("Let me check.");

  const toolMsg = messages.find((m) => m.role === "tool");
  expect(toolMsg).toBeDefined();
  expect(toolMsg!.toolName).toBe("Bash:ls");
  expect(toolMsg!.toolCommand).toBe("ls");
  expect(toolMsg!.toolResult).toBeDefined();
  expect(toolMsg!.toolResult).toContain("index.ts");
});

test("readHistory: tool_result boilerplate is suppressed (no toolResult set)", () => {
  writeSession([
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tw1", name: "Write", input: { file_path: "/f.ts", content: "x" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tw1", content: "The file /f.ts has been updated successfully." },
        ],
      },
    },
  ]);

  const messages = readHistoryTmp();
  const toolMsg = messages.find((m) => m.role === "tool");
  expect(toolMsg).toBeDefined();
  expect(toolMsg!.toolName).toBe("Write:f.ts");
  expect(toolMsg!.toolResult).toBeUndefined();
});

test("readHistory: respects the limit (returns last N messages)", () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({
    type: "user",
    message: { content: `msg ${i}` },
  }));
  writeSession(lines);

  const messages = readHistoryTmp(sessionId, 5);
  expect(messages).toHaveLength(5);
  expect(messages[4]!.text).toBe("msg 29");
});

test("readHistory: malformed lines skipped, valid lines kept", () => {
  writeFileSync(
    join(fixtureDir, `${sessionId}.jsonl`),
    [
      "not json",
      JSON.stringify({ type: "user", message: { content: "valid one" } }),
      "{broken",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "valid two" }] } }),
    ].join("\n") + "\n",
    "utf-8",
  );

  const messages = readHistoryTmp();
  expect(messages).toHaveLength(2);
  expect(messages[0]!.text).toBe("valid one");
  expect(messages[1]!.text).toBe("valid two");
});

test("readHistory: unknown session id returns empty array", () => {
  expect(readHistory("definitely-not-a-real-session-id-zzz", 20, projectsDir)).toEqual([]);
});

// ---------------------------------------------------------------------------
// listClaudeSessions — REAL function against a temp projectsDir
// ---------------------------------------------------------------------------

test("listClaudeSessions: lists top-level jsonl, reads cwd + first message", () => {
  const dir = join(tmpdir(), `diktat-claude-list-${Date.now()}`);
  const proj = join(dir, "encoded-proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "sess-a.jsonl"),
    [
      JSON.stringify({ type: "user", cwd: "/Users/me/code/myrepo", message: { content: "First user line" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
    ].join("\n") + "\n",
    "utf-8",
  );

  const sessions = listClaudeSessions(dir);
  const found = sessions.find((s) => s.id === "sess-a");
  expect(found).toBeDefined();
  expect(found!.project).toBe("/Users/me/code/myrepo");
  expect(found!.projectLabel).toBe("myrepo");
  expect(found!.firstMessage).toBe("First user line");

  rmSync(dir, { recursive: true, force: true });
});

test("listClaudeSessions: skips subagent subdirectories (only top-level jsonl)", () => {
  const dir = join(tmpdir(), `diktat-claude-sub-${Date.now()}`);
  const proj = join(dir, "p");
  const subagent = join(proj, "subagent");
  mkdirSync(subagent, { recursive: true });
  writeFileSync(join(proj, "top.jsonl"), JSON.stringify({ type: "user", cwd: "/x", message: { content: "hi" } }) + "\n", "utf-8");
  // This nested file must NOT be picked up
  writeFileSync(join(subagent, "nested.jsonl"), JSON.stringify({ type: "user", cwd: "/x", message: { content: "nested" } }) + "\n", "utf-8");

  const sessions = listClaudeSessions(dir);
  expect(sessions.map((s) => s.id)).toContain("top");
  expect(sessions.map((s) => s.id)).not.toContain("nested");

  rmSync(dir, { recursive: true, force: true });
});

test("listClaudeSessions: dedupes by id, sorts desc by lastActiveAt, caps at 50", () => {
  const dir = join(tmpdir(), `diktat-claude-cap-${Date.now()}`);
  const proj = join(dir, "p");
  mkdirSync(proj, { recursive: true });
  const base = Date.now();
  for (let i = 0; i < 55; i++) {
    const fp = join(proj, `cap-${String(i).padStart(3, "0")}.jsonl`);
    writeFileSync(fp, JSON.stringify({ type: "user", cwd: "/x", message: { content: `m${i}` } }) + "\n", "utf-8");
    // Stagger mtimes so sort order is deterministic (later index = newer)
    const t = new Date(base + i * 1000);
    utimesSync(fp, t, t);
  }

  const sessions = listClaudeSessions(dir);
  expect(sessions.length).toBe(50);
  for (let i = 1; i < sessions.length; i++) {
    expect(sessions[i - 1]!.lastActiveAt >= sessions[i]!.lastActiveAt).toBe(true);
  }
  // Newest (cap-054) should be first; oldest 5 dropped by cap
  expect(sessions[0]!.id).toBe("cap-054");

  rmSync(dir, { recursive: true, force: true });
});

test("listClaudeSessions: missing dir returns empty array", () => {
  expect(listClaudeSessions(join(tmpdir(), `diktat-claude-missing-${Date.now()}`))).toEqual([]);
});
