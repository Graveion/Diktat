/**
 * Tests for the REAL exported cursor-sessions functions.
 *
 * cursor-sessions.ts hardcodes CURSOR_PROJECTS_DIR but every reader now takes
 * an optional `projectsDir` param that defaults to it. We build a temp layout
 *
 *   <tmpProjectsDir>/<encodedProjectDir>/agent-transcripts/<sessionId>/<sessionId>.jsonl
 *
 * and pass the temp dir into the real functions — no copy-pasted parsing.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, cpSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readCursorHistory,
  readFirstUserMessage,
  listCursorSessions,
} from "./cursor-sessions";

// ---------------------------------------------------------------------------
// Temp project layout
// ---------------------------------------------------------------------------

let tmpProjectsDir: string;
const sessionId = "test-session-abc123";
const encodedDir = "Users-test-user-projects-myapp";

function sessionDir(id = sessionId, project = encodedDir): string {
  return join(tmpProjectsDir, project, "agent-transcripts", id);
}

/** Write a JSONL fixture for the default test session. Returns the file path. */
function writeFixture(lines: object[], id = sessionId, project = encodedDir): string {
  const dir = sessionDir(id, project);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${id}.jsonl`);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return filePath;
}

/** Run the real readCursorHistory against the temp dir. */
function history(lines: object[], limit?: number) {
  writeFixture(lines);
  return readCursorHistory(sessionId, limit ?? 20, tmpProjectsDir);
}

/** Run the real readFirstUserMessage against a written fixture. */
function firstMessage(lines: object[]): string {
  const filePath = writeFixture(lines);
  return readFirstUserMessage(filePath);
}

beforeAll(() => {
  tmpProjectsDir = join(tmpdir(), `diktat-cursor-test-${Date.now()}`);
  mkdirSync(sessionDir(), { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpProjectsDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// readFirstUserMessage — REAL function against temp files
// ---------------------------------------------------------------------------

test("readFirstUserMessage: strips <user_query> and <timestamp> wrappers", () => {
  expect(
    firstMessage([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<timestamp>2024-01-01T00:00:00Z</timestamp>\n<user_query>\nFix the bug please\n</user_query>",
          },
        ],
      },
    ]),
  ).toBe("Fix the bug please");
});

test("readFirstUserMessage: handles array content with text block", () => {
  expect(
    firstMessage([{ role: "user", content: [{ type: "text", text: "Hello from array content" }] }]),
  ).toBe("Hello from array content");
});

test("readFirstUserMessage: handles message.content wrapper", () => {
  expect(
    firstMessage([
      { role: "user", message: { content: [{ type: "text", text: "Wrapped in message.content" }] } },
    ]),
  ).toBe("Wrapped in message.content");
});

test("readFirstUserMessage: skips non-user roles and returns first user message", () => {
  expect(
    firstMessage([
      { role: "assistant", content: [{ type: "text", text: "I am the assistant" }] },
      { role: "user", content: [{ type: "text", text: "I am the user" }] },
    ]),
  ).toBe("I am the user");
});

test("readFirstUserMessage: truncates to 120 characters", () => {
  expect(
    firstMessage([{ role: "user", content: [{ type: "text", text: "A".repeat(200) }] }]),
  ).toHaveLength(120);
});

test("readFirstUserMessage: returns empty string when no user message", () => {
  expect(
    firstMessage([{ role: "assistant", content: [{ type: "text", text: "assistant only" }] }]),
  ).toBe("");
});

test("readFirstUserMessage: skips tool_result blocks, extracts text blocks only", () => {
  expect(
    firstMessage([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "id_1", content: "tool output" },
          { type: "text", text: "actual question" },
        ],
      },
    ]),
  ).toBe("actual question");
});

test("readFirstUserMessage: missing file returns empty string", () => {
  expect(readFirstUserMessage(join(tmpProjectsDir, "does-not-exist.jsonl"))).toBe("");
});

// ---------------------------------------------------------------------------
// readCursorHistory — REAL function against temp files
// ---------------------------------------------------------------------------

test("readCursorHistory: correctly parses tool_use + tool_result from JSONL", () => {
  const messages = history([
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a/b.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents here" }] },
  ]);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.role).toBe("tool");
  expect(messages[0]!.toolName).toContain("Read");
  expect(messages[0]!.toolPath).toBe("/a/b.ts");
  expect(messages[0]!.toolResult).toBeDefined();
  expect(messages[0]!.toolResult!.length).toBeGreaterThan(0);
});

test("readCursorHistory: strips redacted-reasoning (only text blocks make it through)", () => {
  const messages = history([
    {
      role: "assistant",
      content: [
        { type: "redacted-reasoning", data: "base64==", providerOptions: { cursor: { modelName: "composer-2.5-fast" } } },
        { type: "text", text: "The actual response" },
      ],
    },
  ]);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.role).toBe("assistant");
  expect(messages[0]!.text).toBe("The actual response");
});

test("readCursorHistory: handles entry.message?.content ?? entry.content fallback", () => {
  const top = history([{ role: "user", content: [{ type: "text", text: "Top level content" }] }]);
  expect(top).toHaveLength(1);
  expect(top[0]!.text).toBe("Top level content");

  const wrapped = history([{ role: "user", message: { content: [{ type: "text", text: "Wrapped content" }] } }]);
  expect(wrapped).toHaveLength(1);
  expect(wrapped[0]!.text).toBe("Wrapped content");
});

test("readCursorHistory: limit applied correctly (returns last N messages)", () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `Message ${i}` }],
  }));
  const messages = history(lines, 10);
  expect(messages).toHaveLength(10);
  expect(messages[9]!.text).toBe("Message 29");
});

test("readCursorHistory: malformed lines skipped gracefully", () => {
  // Write a mix of raw garbage and valid JSON lines directly.
  const filePath = join(sessionDir(), `${sessionId}.jsonl`);
  writeFileSync(
    filePath,
    [
      "not valid json at all",
      JSON.stringify({ role: "user", content: [{ type: "text", text: "valid line" }] }),
      "{broken",
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "also valid" }] }),
    ].join("\n") + "\n",
    "utf-8",
  );
  const messages = readCursorHistory(sessionId, 20, tmpProjectsDir);
  expect(messages).toHaveLength(2);
  expect(messages[0]!.text).toBe("valid line");
  expect(messages[1]!.text).toBe("also valid");
});

test("readCursorHistory: tool_result without matching tool_use is skipped", () => {
  const messages = history([
    { role: "user", content: [{ type: "tool_result", tool_use_id: "nonexistent_id", content: "orphaned result" }] },
  ]);
  expect(messages).toHaveLength(0);
});

test("readCursorHistory: full conversation round-trip", () => {
  const messages = history([
    { role: "user", content: [{ type: "text", text: "What files exist?" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "index.ts\nsession.ts" }] },
  ]);

  expect(messages.length).toBeGreaterThanOrEqual(3);
  expect(messages.find((m) => m.role === "user")?.text).toBe("What files exist?");
  expect(messages.find((m) => m.role === "assistant")?.text).toBe("Let me check.");
  const toolMsg = messages.find((m) => m.role === "tool");
  expect(toolMsg).toBeDefined();
  expect(toolMsg!.toolName).toContain("Bash");
  expect(toolMsg!.toolResult).toBeDefined();
});

test("readCursorHistory: unknown session id returns empty array", () => {
  expect(readCursorHistory("no-such-session-zzz", 20, tmpProjectsDir)).toEqual([]);
});

// ---------------------------------------------------------------------------
// [REDACTED] filtering
// ---------------------------------------------------------------------------

test("[REDACTED] standalone text block is filtered out", () => {
  expect(history([{ role: "assistant", content: [{ type: "text", text: "[REDACTED]" }] }])).toHaveLength(0);
});

test("[REDACTED] mixed with real text: only real text kept", () => {
  const messages = history([
    { role: "assistant", content: [{ type: "text", text: "Real response A" }] },
    { role: "assistant", content: [{ type: "text", text: "[REDACTED]" }] },
    { role: "assistant", content: [{ type: "text", text: "[REDACTED]" }] },
    { role: "assistant", content: [{ type: "text", text: "Real response B" }] },
    { role: "assistant", content: [{ type: "text", text: "[REDACTED]" }] },
  ]);
  expect(messages).toHaveLength(2);
  expect(messages[0]!.text).toBe("Real response A");
  expect(messages[1]!.text).toBe("Real response B");
});

test("[REDACTED] with mixed case and whitespace is filtered", () => {
  const messages = history([
    { role: "assistant", content: [{ type: "text", text: "  [REDACTED]  " }] },
    { role: "assistant", content: [{ type: "text", text: "[redacted]" }] },
    { role: "assistant", content: [{ type: "text", text: "[Redacted]" }] },
  ]);
  expect(messages).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Tool name canonical mapping
// ---------------------------------------------------------------------------

test("toolDisplayName: StrReplace → Edit with file path", () => {
  const messages = history([
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "StrReplace", input: { path: "/src/foo.ts", oldStr: "a", newStr: "b" } }] },
  ]);
  expect(messages[0]!.toolName).toContain("Edit");
});

test("toolDisplayName: ReadFile → Read with file path", () => {
  const messages = history([
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ReadFile", input: { path: "/src/bar.ts" } }] },
  ]);
  expect(messages[0]!.toolName).toContain("Read");
  expect(messages[0]!.toolName).toContain("bar.ts");
});

test("toolDisplayName: rg → Grep", () => {
  const messages = history([
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "rg", input: { pattern: "TODO" } }] },
  ]);
  expect(messages[0]!.toolName).toBe("Grep");
});

test("toolDisplayName: AwaitShell/ApplyPatch/Delete canonical names", () => {
  for (const [name, expected] of [["AwaitShell", "Bash"], ["ApplyPatch", "Edit"], ["Delete", "Write"]] as const) {
    const messages = history([{ role: "assistant", content: [{ type: "tool_use", id: "t1", name, input: {} }] }]);
    expect(messages[0]!.toolName).toBe(expected);
  }
});

// ---------------------------------------------------------------------------
// listCursorSessions — REAL function against temp layout
// ---------------------------------------------------------------------------

test("listCursorSessions: lists sessions with project label and first message", () => {
  // Layout: <dir>/<encodedProject>/agent-transcripts/<sessionId>/<sessionId>.jsonl
  const dir = join(tmpProjectsDir, "list-test");
  const id = "ls-session-1";
  const sdir = join(dir, "my-app", "agent-transcripts", id);
  mkdirSync(sdir, { recursive: true });
  writeFileSync(
    join(sdir, `${id}.jsonl`),
    JSON.stringify({ role: "user", content: [{ type: "text", text: "hello session" }] }) + "\n",
    "utf-8",
  );

  const sessions = listCursorSessions(dir);
  const found = sessions.find((s) => s.id === id);
  expect(found).toBeDefined();
  expect(found!.firstMessage).toBe("hello session");
  expect(found!.projectLabel.length).toBeGreaterThan(0);
});

test("listCursorSessions: dedupes by id, sorts by lastActiveAt desc, caps at 50", () => {
  const dir = join(tmpProjectsDir, "cap-test");
  for (let i = 0; i < 55; i++) {
    const id = `cap-${String(i).padStart(3, "0")}`;
    const sdir = join(dir, "proj", "agent-transcripts", id);
    mkdirSync(sdir, { recursive: true });
    writeFileSync(
      join(sdir, `${id}.jsonl`),
      JSON.stringify({ role: "user", content: [{ type: "text", text: `m${i}` }] }) + "\n",
      "utf-8",
    );
  }
  const sessions = listCursorSessions(dir);
  expect(sessions.length).toBe(50);
  // sorted desc by ISO mtime
  for (let i = 1; i < sessions.length; i++) {
    expect(sessions[i - 1]!.lastActiveAt >= sessions[i]!.lastActiveAt).toBe(true);
  }
});

test("listCursorSessions: missing projects dir returns empty", () => {
  expect(listCursorSessions(join(tmpProjectsDir, "nope-does-not-exist"))).toEqual([]);
});

// ---------------------------------------------------------------------------
// Real fixtures: copy testdata JSONL into the layout readCursorHistory expects
// (project-dir/agent-transcripts/<sessionId>/<sessionId>.jsonl) and route
// through the REAL readCursorHistory.
// ---------------------------------------------------------------------------

let realFixturesDir: string;

beforeAll(() => {
  realFixturesDir = join(tmpdir(), `diktat-cursor-realfix-${Date.now()}`);
  // Big session fixture under a known sessionId
  const placeFixture = (srcPath: string, id: string) => {
    const dest = join(realFixturesDir, "proj", "agent-transcripts", id);
    mkdirSync(dest, { recursive: true });
    cpSync(srcPath, join(dest, `${id}.jsonl`));
  };
  placeFixture("./testdata/cursor-session.jsonl", "cursor-session");
  placeFixture("./testdata/6e69c404-9884-4611-86ca-a6f67680f09b.jsonl", "6e69c404-9884-4611-86ca-a6f67680f09b");
  placeFixture("./testdata/c88ef9bb-f0d4-498c-b56a-1ecf0793db0b.jsonl", "c88ef9bb-f0d4-498c-b56a-1ecf0793db0b");
  placeFixture("./testdata/dccd729f-87f7-4d37-905d-54bdb673b34d.jsonl", "dccd729f-87f7-4d37-905d-54bdb673b34d");
});

afterAll(() => {
  try {
    rmSync(realFixturesDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

test("real fixture: no [REDACTED] messages in parsed history", () => {
  const messages = readCursorHistory("cursor-session", 1000, realFixturesDir);
  expect(messages.filter((m) => m.text?.includes("[REDACTED]"))).toHaveLength(0);
});

test("real fixture: assistant messages have real text content", () => {
  const messages = readCursorHistory("cursor-session", 1000, realFixturesDir);
  const assistantMsgs = messages.filter((m) => m.role === "assistant");
  expect(assistantMsgs.length).toBeGreaterThan(0);
  for (const msg of assistantMsgs) {
    expect(msg.text.trim()).not.toBe("");
    expect(msg.text.trim()).not.toBe("[REDACTED]");
  }
});

test("real fixture: tool_use messages parsed with canonical names", () => {
  const messages = readCursorHistory("cursor-session", 1000, realFixturesDir);
  const toolMsgs = messages.filter((m) => m.role === "tool");
  expect(toolMsgs.length).toBeGreaterThan(0);
  const rawNames = ["StrReplace", "ReadFile", "rg", "AwaitShell", "ApplyPatch"];
  for (const msg of toolMsgs) {
    const prefix = (msg.toolName ?? "").split(":")[0];
    for (const raw of rawNames) expect(prefix).not.toBe(raw);
  }
});

const SUBAGENT_IDS = [
  "6e69c404-9884-4611-86ca-a6f67680f09b",
  "c88ef9bb-f0d4-498c-b56a-1ecf0793db0b",
  "dccd729f-87f7-4d37-905d-54bdb673b34d",
];

for (const id of SUBAGENT_IDS) {
  const label = id.slice(0, 8);

  test(`subagent ${label}: no [REDACTED] in parsed output`, () => {
    const messages = readCursorHistory(id, 1000, realFixturesDir);
    for (const msg of messages) expect(msg.text ?? "").not.toContain("[REDACTED]");
  });

  test(`subagent ${label}: ReadFile → Read, rg → Grep (canonical names only)`, () => {
    const messages = readCursorHistory(id, 1000, realFixturesDir);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBeGreaterThan(0);
    for (const msg of toolMsgs) {
      const prefix = (msg.toolName ?? "").split(":")[0];
      expect(prefix).not.toBe("ReadFile");
      expect(prefix).not.toBe("rg");
      if (msg.toolName?.startsWith("Read")) expect(prefix).toBe("Read");
    }
  });

  test(`subagent ${label}: tool messages carry file paths where applicable`, () => {
    const messages = readCursorHistory(id, 1000, realFixturesDir);
    const readMsgs = messages.filter((m) => m.toolName?.startsWith("Read:"));
    expect(readMsgs.length).toBeGreaterThan(0);
    for (const msg of readMsgs) expect(msg.toolPath).toBeDefined();
  });
}
