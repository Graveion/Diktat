import { test, expect, afterEach } from "bun:test";
import { existsSync, rmSync } from "fs";
import { recordRun, aggregate } from "./run-stats-store";
import type { RunSummary } from "./run-summary";

const TMP = "./run-stats.test.jsonl";

afterEach(() => { if (existsSync(TMP)) rmSync(TMP); });

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  filesChanged: ["/a.ts"],
  editCount: 1,
  linesAdded: 3,
  linesRemoved: 1,
  commandsRun: 0,
  testStatus: "none",
  durationMs: 1000,
  exitCode: 0,
  ...over,
});

const meta = (sessionId: string) => ({ id: `run-${Math.round(performance.now() * 1000)}-${sessionId}`, sessionId, cli: "claude", project: "/proj" });

test("aggregate of an empty store is zeroed", () => {
  const { overall, perSession } = aggregate(TMP);
  expect(overall.runs).toBe(0);
  expect(Object.keys(perSession)).toHaveLength(0);
});

test("records fold into overall and per-session totals", () => {
  recordRun(meta("s1"), summary({ filesChanged: ["/a.ts", "/b.ts"], editCount: 2, linesAdded: 5, commandsRun: 1, testStatus: "pass" }), new Date("2026-06-01T10:00:00Z"), TMP);
  recordRun(meta("s1"), summary({ filesChanged: ["/a.ts"], editCount: 1, linesAdded: 2, testStatus: "fail" }), new Date("2026-06-01T11:00:00Z"), TMP);
  recordRun(meta("s2"), summary({ filesChanged: ["/c.ts"], commandsRun: 3 }), new Date("2026-06-02T09:00:00Z"), TMP);

  const { overall, perSession } = aggregate(TMP);
  expect(overall.runs).toBe(3);
  expect(overall.edits).toBe(4);          // 2 + 1 + 1
  expect(overall.commandsRun).toBe(4);    // 1 + 0 + 3
  expect(overall.filesChanged).toBe(3);   // a, b, c deduped
  expect(overall.testsPassed).toBe(1);
  expect(overall.testsFailed).toBe(1);
  expect(overall.lastRunAt).toBe("2026-06-02T09:00:00.000Z");

  expect(perSession.s1!.runs).toBe(2);
  expect(perSession.s1!.filesChanged).toBe(2); // a, b (a deduped across its 2 runs)
  expect(perSession.s2!.runs).toBe(1);
  expect(perSession.s2!.commandsRun).toBe(3);
});

test("malformed lines are skipped, not fatal", () => {
  recordRun(meta("s1"), summary(), new Date("2026-06-01T10:00:00Z"), TMP);
  // aggregate should still read the one good record
  expect(aggregate(TMP).overall.runs).toBe(1);
});
