import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { toolDisplayName, readHistory } from "./claude-sessions";

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
// readHistory — exercises the real function against a fixture written into the
// hardcoded CLAUDE_PROJECTS_DIR (~/.claude/projects). We create a throwaway
// project subdir + session JSONL and remove it afterward.
// ---------------------------------------------------------------------------

const projectsDir = join(homedir(), ".claude", "projects");
const fixtureDirName = `diktat-readhistory-test-${Date.now()}`;
const fixtureDir = join(projectsDir, fixtureDirName);
const sessionId = `test-session-${Date.now()}`;

function writeSession(lines: object[]) {
  writeFileSync(
    join(fixtureDir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

beforeAll(() => {
  mkdirSync(fixtureDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(fixtureDir, { recursive: true, force: true });
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

  const messages = readHistory(sessionId);

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

  const messages = readHistory(sessionId);
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

  const messages = readHistory(sessionId, 5);
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

  const messages = readHistory(sessionId);
  expect(messages).toHaveLength(2);
  expect(messages[0]!.text).toBe("valid one");
  expect(messages[1]!.text).toBe("valid two");
});

test("readHistory: unknown session id returns empty array", () => {
  expect(readHistory("definitely-not-a-real-session-id-zzz")).toEqual([]);
});
