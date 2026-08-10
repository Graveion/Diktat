import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseCodexRollout, listCodexSessions, readCodexHistory, findCodexRollout, codexSessionExists } from "./codex-sessions";

// Build rollout JSONL lines straight from the verified codex-rollout.ts schema.
const line = (type: string, payload: any) => JSON.stringify({ timestamp: "2025-05-07T17:24:21.597Z", type, payload });
const meta = (id: string, cwd: string) =>
  line("session_meta", { id, cwd, timestamp: "2025-05-07T17:24:21.597Z", originator: "cli", cli_version: "1.0.0", model_provider: "openai", base_instructions: null });
const userMsg = (text: string) => line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
const asstMsg = (text: string) => line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const fnCall = (call_id: string, name: string, args: any) =>
  line("response_item", { type: "function_call", name, arguments: JSON.stringify(args), call_id });
const fnOut = (call_id: string, output: any) => line("response_item", { type: "function_call_output", call_id, output });

test("parseCodexRollout: extracts user + assistant message text", () => {
  const raw = [meta("s1", "/proj"), userMsg("hello there"), asstMsg("hi, working on it")].join("\n");
  const msgs = parseCodexRollout(raw);
  expect(msgs).toEqual([
    { role: "user", text: "hello there" },
    { role: "assistant", text: "hi, working on it" },
  ]);
});

test("parseCodexRollout: shell function_call → Bash tool with command, output linked", () => {
  const raw = [
    userMsg("run the tests"),
    fnCall("c1", "shell", { command: ["bash", "-lc", "bun test"] }),
    fnOut("c1", "25 pass, 0 fail"),
  ].join("\n");
  const msgs = parseCodexRollout(raw);
  const tool = msgs.find((m) => m.role === "tool")!;
  expect(tool.toolName).toBe("Bash:bash -lc bun test");
  expect(tool.toolCommand).toBe("bash -lc bun test");
  expect(tool.toolResult).toBe("25 pass, 0 fail");
});

test("parseCodexRollout: function_call_output array form joins input_text", () => {
  const raw = [
    fnCall("c2", "shell", { command: "ls" }),
    fnOut("c2", [{ type: "input_text", text: "file_a" }, { type: "input_text", text: "file_b" }]),
  ].join("\n");
  const tool = parseCodexRollout(raw).find((m) => m.role === "tool")!;
  expect(tool.toolResult).toBe("file_a\nfile_b");
});

test("parseCodexRollout: skips reasoning and system roles, tolerates unknown items", () => {
  const raw = [
    line("response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: null }),
    line("response_item", { type: "message", role: "system", content: [{ type: "input_text", text: "sys" }] }),
    line("response_item", { type: "totally_new_kind", foo: 1 }),
    asstMsg("done"),
  ].join("\n");
  expect(parseCodexRollout(raw)).toEqual([{ role: "assistant", text: "done" }]);
});

test("parseCodexRollout: ignores non-response_item lines and malformed lines", () => {
  const raw = [meta("s", "/p"), "{ not json", line("turn_context", { cwd: "/p", approval_policy: "never", sandbox_policy: "workspace-write" }), userMsg("hi")].join("\n");
  expect(parseCodexRollout(raw)).toEqual([{ role: "user", text: "hi" }]);
});

test("parseCodexRollout: respects the limit (keeps the last N)", () => {
  const raw = Array.from({ length: 50 }, (_, i) => asstMsg(`m${i}`)).join("\n");
  const msgs = parseCodexRollout(raw, 5);
  expect(msgs.length).toBe(5);
  expect(msgs[4]!.text).toBe("m49");
});

// ── disk-level helpers against a synthetic ~/.codex/sessions tree ─────────────
function withSessionsDir(fn: (dir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "diktat-codex-"));
  const dayDir = join(root, "2025", "05", "07");
  mkdirSync(dayDir, { recursive: true });
  const uuid = "11111111-2222-3333-4444-555555555555";
  const file = join(dayDir, `rollout-2025-05-07T17-24-21-${uuid}.jsonl`);
  writeFileSync(file, [meta(uuid, "/Users/me/myproj"), userMsg("first question"), asstMsg("an answer")].join("\n") + "\n");
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("listCodexSessions: lists sessions with id, project, first message", () => {
  withSessionsDir((dir) => {
    const sessions = listCodexSessions(dir);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.id).toBe("11111111-2222-3333-4444-555555555555");
    expect(sessions[0]!.project).toBe("/Users/me/myproj");
    expect(sessions[0]!.projectLabel).toBe("myproj");
    expect(sessions[0]!.firstMessage).toBe("first question");
  });
});

test("findCodexRollout / codexSessionExists: locate by id", () => {
  withSessionsDir((dir) => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(findCodexRollout(id, dir)).toContain(`-${id}.jsonl`);
    expect(codexSessionExists(id, dir)).toBe(true);
    expect(codexSessionExists("00000000-0000-0000-0000-000000000000", dir)).toBe(false);
  });
});

test("readCodexHistory: reads a session's messages by id", () => {
  withSessionsDir((dir) => {
    const msgs = readCodexHistory("11111111-2222-3333-4444-555555555555", 20, dir);
    expect(msgs).toEqual([
      { role: "user", text: "first question" },
      { role: "assistant", text: "an answer" },
    ]);
  });
});

test("listCodexSessions: empty when dir is missing", () => {
  expect(listCodexSessions("/no/such/codex/dir")).toEqual([]);
});
