import { test, expect } from "bun:test";
import {
  newRunAccumulator,
  accumulateToolEvent,
  finalizeRunSummary,
  formatPushBody,
  formatPushTitle,
  formatDuration,
  countDiffLines,
  detectTestResult,
  isTestCommand,
  summaryToPushData,
  type RunAccumulator,
} from "./run-summary";

// Helper: build a buildEditDiff-style block.
const diffBlock = (olds: string[], news: string[]) =>
  [...olds.map((l) => `- ${l}`), ...news.map((l) => `+ ${l}`)].join("\n");

// ---------------------------------------------------------------------------
// countDiffLines
// ---------------------------------------------------------------------------

test("countDiffLines: counts + and - prefixed lines", () => {
  const diff = diffBlock(["a", "b"], ["a", "b", "c", "d"]);
  expect(countDiffLines(diff)).toEqual({ added: 4, removed: 2 });
});

test("countDiffLines: ignores context-ish lines without +/- prefix", () => {
  const diff = "@@ edit 1 of 2 @@\n- old\n+ new\nplain line";
  expect(countDiffLines(diff)).toEqual({ added: 1, removed: 1 });
});

// ---------------------------------------------------------------------------
// isTestCommand
// ---------------------------------------------------------------------------

test("isTestCommand: matches known test runners", () => {
  expect(isTestCommand("bun test")).toBe(true);
  expect(isTestCommand("npm test")).toBe(true);
  expect(isTestCommand("npm run test")).toBe(true);
  expect(isTestCommand("pytest -q")).toBe(true);
  expect(isTestCommand("go test ./...")).toBe(true);
  expect(isTestCommand("cargo test")).toBe(true);
  expect(isTestCommand("npx vitest run")).toBe(true);
});

test("isTestCommand: does not match unrelated commands", () => {
  expect(isTestCommand("ls -la")).toBe(false);
  expect(isTestCommand("git status")).toBe(false);
  expect(isTestCommand("bun build ./index.ts")).toBe(false);
});

// ---------------------------------------------------------------------------
// detectTestResult — heuristic
// ---------------------------------------------------------------------------

test("detectTestResult: '41 passed' → pass with detail", () => {
  const preview = "\n 41 passed\n 0 failed\nRan 41 tests across 5 files. [1.20s]";
  expect(detectTestResult(preview)).toEqual({ status: "pass", detail: "41 passed" });
});

test("detectTestResult: '2 failed' → fail with detail", () => {
  const preview = "✗ thing > does stuff\n 39 passed\n 2 failed\n";
  expect(detectTestResult(preview)).toEqual({ status: "fail", detail: "2 failed" });
});

test("detectTestResult: bare FAIL token → fail no detail", () => {
  expect(detectTestResult("FAIL src/foo.test.ts")).toEqual({ status: "fail" });
});

test("detectTestResult: no signal → none", () => {
  expect(detectTestResult("some random output")).toEqual({ status: "none" });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

test("formatDuration: sub-minute → Ns", () => {
  expect(formatDuration(45000)).toBe("45s");
  expect(formatDuration(999)).toBe("1s");
});

test("formatDuration: whole minutes → Nm", () => {
  expect(formatDuration(120000)).toBe("2m");
});

test("formatDuration: minutes + seconds → NmSs", () => {
  expect(formatDuration(80000)).toBe("1m20s");
});

// ---------------------------------------------------------------------------
// formatPushTitle
// ---------------------------------------------------------------------------

test("formatPushTitle: success", () => {
  expect(formatPushTitle("Diktat", 0)).toBe("✓ Diktat");
});

test("formatPushTitle: failure includes exit code", () => {
  expect(formatPushTitle("Diktat", 2)).toBe("✗ Diktat — exited 2");
});

// ---------------------------------------------------------------------------
// accumulator — files dedupe & line counting
// ---------------------------------------------------------------------------

test("accumulator: Edit files dedupe to unique set, lines summed", () => {
  const acc = newRunAccumulator(0);
  accumulateToolEvent(acc, { kind: "tool_use", name: "Edit", path: "/a.ts", diff: diffBlock(["x"], ["x", "y"]) });
  accumulateToolEvent(acc, { kind: "tool_use", name: "Edit", path: "/a.ts", diff: diffBlock(["p"], ["q"]) });
  accumulateToolEvent(acc, { kind: "tool_use", name: "Edit", path: "/b.ts", diff: diffBlock([], ["new"]) });

  const s = finalizeRunSummary(acc, 0, 0);
  expect(s.editCount).toBe(3);
  expect(s.filesChanged.sort()).toEqual(["/a.ts", "/b.ts"]);
  // /a.ts: +2/-1 then +1/-1; /b.ts: +1/-0  => added 4, removed 2
  expect(s.linesAdded).toBe(4);
  expect(s.linesRemoved).toBe(2);
});

test("accumulator: MultiEdit diff summed across edits", () => {
  const acc = newRunAccumulator(0);
  const diff =
    "@@ edit 1 of 2 @@\n" + diffBlock(["a"], ["a", "b"]) + "\n\n@@ edit 2 of 2 @@\n" + diffBlock(["c"], ["d"]);
  accumulateToolEvent(acc, { kind: "tool_use", name: "MultiEdit", path: "/m.ts", diff });
  const s = finalizeRunSummary(acc, 0, 0);
  expect(s.linesAdded).toBe(3);
  expect(s.linesRemoved).toBe(2);
  expect(s.filesChanged).toEqual(["/m.ts"]);
});

test("accumulator: Write counts content lines as added", () => {
  const acc = newRunAccumulator(0);
  accumulateToolEvent(acc, { kind: "tool_use", name: "Write", path: "/new.ts", content: "line1\nline2\nline3" });
  const s = finalizeRunSummary(acc, 0, 0);
  expect(s.linesAdded).toBe(3);
  expect(s.linesRemoved).toBe(0);
  expect(s.editCount).toBe(1);
  expect(s.filesChanged).toEqual(["/new.ts"]);
});

// ---------------------------------------------------------------------------
// accumulator — Bash last-command + test heuristic
// ---------------------------------------------------------------------------

test("accumulator: Bash captures last command and counts runs", () => {
  const acc = newRunAccumulator(0);
  accumulateToolEvent(acc, { kind: "tool_use", name: "Bash", command: "ls -la" });
  accumulateToolEvent(acc, { kind: "tool_use", name: "Bash", command: "  git status  " });
  const s = finalizeRunSummary(acc, 0, 0);
  expect(s.commandsRun).toBe(2);
  expect(s.lastCommand).toBe("git status");
});

test("accumulator: test command + passing result → testStatus pass", () => {
  const acc = newRunAccumulator(0);
  accumulateToolEvent(acc, { kind: "tool_use", name: "Bash", id: "b1", command: "bun test" });
  accumulateToolEvent(acc, { kind: "tool_result", id: "b1", preview: "41 passed\n0 failed" });
  const s = finalizeRunSummary(acc, 0, 0);
  expect(s.testStatus).toBe("pass");
  expect(s.testDetail).toBe("41 passed");
});

test("accumulator: test command + failing result → testStatus fail", () => {
  const acc = newRunAccumulator(0);
  accumulateToolEvent(acc, { kind: "tool_use", name: "Bash", id: "b1", command: "npm test" });
  accumulateToolEvent(acc, { kind: "tool_result", id: "b1", preview: "39 passed\n2 failed" });
  const s = finalizeRunSummary(acc, 0, 0);
  expect(s.testStatus).toBe("fail");
  expect(s.testDetail).toBe("2 failed");
});

test("accumulator: result for non-test Bash is ignored", () => {
  const acc = newRunAccumulator(0);
  accumulateToolEvent(acc, { kind: "tool_use", name: "Bash", id: "b1", command: "ls" });
  accumulateToolEvent(acc, { kind: "tool_result", id: "b1", preview: "2 failed" });
  const s = finalizeRunSummary(acc, 0, 0);
  expect(s.testStatus).toBe("none");
});

test("accumulator: a failing test run wins over a later pass", () => {
  const acc = newRunAccumulator(0);
  accumulateToolEvent(acc, { kind: "tool_use", name: "Bash", id: "b1", command: "bun test" });
  accumulateToolEvent(acc, { kind: "tool_result", id: "b1", preview: "2 failed" });
  accumulateToolEvent(acc, { kind: "tool_use", name: "Bash", id: "b2", command: "bun test" });
  accumulateToolEvent(acc, { kind: "tool_result", id: "b2", preview: "41 passed" });
  const s = finalizeRunSummary(acc, 0, 0);
  expect(s.testStatus).toBe("fail");
});

test("accumulator: default testStatus is none", () => {
  const acc = newRunAccumulator(0);
  expect(finalizeRunSummary(acc, 0, 0).testStatus).toBe("none");
});

// ---------------------------------------------------------------------------
// finalizeRunSummary — duration & exit code
// ---------------------------------------------------------------------------

test("finalizeRunSummary: durationMs from start vs end", () => {
  const acc = newRunAccumulator(1000);
  const s = finalizeRunSummary(acc, 0, 81000);
  expect(s.durationMs).toBe(80000);
  expect(s.exitCode).toBe(0);
});

test("finalizeRunSummary: negative duration clamped to 0", () => {
  const acc = newRunAccumulator(5000);
  expect(finalizeRunSummary(acc, 0, 1000).durationMs).toBe(0);
});

// ---------------------------------------------------------------------------
// formatPushBody — composition & ordering
// ---------------------------------------------------------------------------

function summaryFrom(acc: RunAccumulator, exitCode = 0, durationMs = 80000) {
  return finalizeRunSummary(acc, exitCode, acc.startedAt + durationMs);
}

test("formatPushBody: edits + passing tests", () => {
  const acc = newRunAccumulator(0);
  acc.filesChanged.add("/a"); acc.filesChanged.add("/b"); acc.filesChanged.add("/c");
  acc.linesAdded = 84; acc.linesRemoved = 12;
  acc.testStatus = "pass"; acc.testDetail = "41 passed";
  const body = formatPushBody(summaryFrom(acc));
  expect(body).toBe("3 files · +84/−12 · tests ✓ 41 passed · 1m20s");
});

test("formatPushBody: test failure leads (worst news first)", () => {
  const acc = newRunAccumulator(0);
  acc.filesChanged.add("/a"); acc.filesChanged.add("/b"); acc.filesChanged.add("/c");
  acc.linesAdded = 84; acc.linesRemoved = 12;
  acc.testStatus = "fail"; acc.testDetail = "2 failed";
  const body = formatPushBody(summaryFrom(acc));
  expect(body).toBe("tests ✗ 2 failed · 3 files · +84/−12 · 1m20s");
});

test("formatPushBody: no edits → 'No file changes'", () => {
  const acc = newRunAccumulator(0);
  const body = formatPushBody(summaryFrom(acc, 0, 45000));
  expect(body).toBe("No file changes · 45s");
});

test("formatPushBody: single file uses singular", () => {
  const acc = newRunAccumulator(0);
  acc.filesChanged.add("/a");
  acc.linesAdded = 3; acc.linesRemoved = 0;
  const body = formatPushBody(summaryFrom(acc, 0, 45000));
  expect(body).toBe("1 file · +3/−0 · 45s");
});

test("formatPushBody: test pass with no edits still surfaces tests", () => {
  const acc = newRunAccumulator(0);
  acc.testStatus = "pass"; acc.testDetail = "10 passed";
  const body = formatPushBody(summaryFrom(acc, 0, 45000));
  expect(body).toBe("tests ✓ 10 passed · No file changes · 45s");
});

// ---------------------------------------------------------------------------
// summaryToPushData
// ---------------------------------------------------------------------------

test("summaryToPushData: includes sessionId + all fields, omits empty optionals", () => {
  const acc = newRunAccumulator(0);
  acc.filesChanged.add("/a.ts");
  acc.linesAdded = 5; acc.linesRemoved = 1; acc.editCount = 1;
  acc.commandsRun = 2; acc.lastCommand = "bun test";
  acc.testStatus = "pass"; acc.testDetail = "5 passed";
  const data = summaryToPushData("sess-1", finalizeRunSummary(acc, 0, 1000));
  expect(data).toMatchObject({
    sessionId: "sess-1",
    exitCode: 0,
    filesChanged: ["/a.ts"],
    editCount: 1,
    linesAdded: 5,
    linesRemoved: 1,
    commandsRun: 2,
    lastCommand: "bun test",
    testStatus: "pass",
    testDetail: "5 passed",
    durationMs: 1000,
  });
});

test("summaryToPushData: omits lastCommand/testDetail when absent", () => {
  const acc = newRunAccumulator(0);
  const data = summaryToPushData("sess-2", finalizeRunSummary(acc, 0, 0));
  expect(data.lastCommand).toBeUndefined();
  expect(data.testDetail).toBeUndefined();
  expect(data.testStatus).toBe("none");
});
