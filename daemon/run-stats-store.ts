import { existsSync, readFileSync, writeFileSync } from "fs";
import type { RunSummary } from "./run-summary";
import { dataPath, ensureDataDir } from "./paths";

// One JSON line per completed run, in the data dir. Capped to the most recent
// MAX_RECORDS so the file can't grow without bound on a busy machine.
const STORE_PATH = dataPath("run-stats.jsonl");
const MAX_RECORDS = 5000;
// Per-run cap on stored file paths — keeps lines small while still allowing
// accurate unique-file aggregation for normal runs.
const MAX_FILES_PER_RUN = 100;

export interface RunRecord {
  id: string;
  sessionId: string;
  cli: string;
  project: string;
  ts: string; // ISO completion time
  durationMs: number;
  files: string[];
  editCount: number;
  linesAdded: number;
  linesRemoved: number;
  commandsRun: number;
  testStatus: "pass" | "fail" | "none";
  exitCode: number;
}

export interface StatsTotals {
  runs: number;
  edits: number;
  linesAdded: number;
  linesRemoved: number;
  commandsRun: number;
  filesChanged: number; // unique across the runs in scope
  testsPassed: number;
  testsFailed: number;
  durationMs: number;
  lastRunAt?: string;
}

export interface AggregatedStats {
  overall: StatsTotals;
  perSession: Record<string, StatsTotals>;
}

function readRunRecords(storePath = STORE_PATH): RunRecord[] {
  if (!existsSync(storePath)) return [];
  const out: RunRecord[] = [];
  try {
    for (const line of readFileSync(storePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as RunRecord); } catch { /* skip malformed */ }
    }
  } catch { /* unreadable — treat as empty */ }
  return out;
}

/**
 * Append one completed run. Best-effort: never throws (a stats write must not
 * break a session). Trims to the most recent MAX_RECORDS on each write.
 */
export function recordRun(
  meta: { id: string; sessionId: string; cli: string; project: string },
  summary: RunSummary,
  endedAt: Date,
  storePath = STORE_PATH,
): void {
  try {
    const record: RunRecord = {
      id: meta.id,
      sessionId: meta.sessionId,
      cli: meta.cli,
      project: meta.project,
      ts: endedAt.toISOString(),
      durationMs: summary.durationMs,
      files: summary.filesChanged.slice(0, MAX_FILES_PER_RUN),
      editCount: summary.editCount,
      linesAdded: summary.linesAdded,
      linesRemoved: summary.linesRemoved,
      commandsRun: summary.commandsRun,
      testStatus: summary.testStatus,
      exitCode: summary.exitCode,
    };
    const records = readRunRecords(storePath);
    records.push(record);
    const kept = records.slice(-MAX_RECORDS);
    if (storePath === STORE_PATH) ensureDataDir();
    writeFileSync(storePath, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
  } catch {
    /* best-effort persistence */
  }
}

function emptyTotals(): StatsTotals {
  return {
    runs: 0, edits: 0, linesAdded: 0, linesRemoved: 0, commandsRun: 0,
    filesChanged: 0, testsPassed: 0, testsFailed: 0, durationMs: 0,
  };
}

// Fold a run into a totals accumulator, tracking unique files via a side Set.
function fold(t: StatsTotals, files: Set<string>, r: RunRecord): void {
  t.runs += 1;
  t.edits += r.editCount;
  t.linesAdded += r.linesAdded;
  t.linesRemoved += r.linesRemoved;
  t.commandsRun += r.commandsRun;
  t.durationMs += r.durationMs;
  if (r.testStatus === "pass") t.testsPassed += 1;
  else if (r.testStatus === "fail") t.testsFailed += 1;
  for (const f of r.files) files.add(f);
  if (!t.lastRunAt || r.ts > t.lastRunAt) t.lastRunAt = r.ts;
}

/**
 * Aggregate all persisted runs into overall + per-session totals. Unique file
 * counts are deduped within each scope.
 */
export function aggregate(storePath = STORE_PATH): AggregatedStats {
  const records = readRunRecords(storePath);
  const overall = emptyTotals();
  const overallFiles = new Set<string>();
  const perSession: Record<string, StatsTotals> = {};
  const perSessionFiles: Record<string, Set<string>> = {};

  for (const r of records) {
    fold(overall, overallFiles, r);
    if (!perSession[r.sessionId]) {
      perSession[r.sessionId] = emptyTotals();
      perSessionFiles[r.sessionId] = new Set<string>();
    }
    fold(perSession[r.sessionId]!, perSessionFiles[r.sessionId]!, r);
  }

  overall.filesChanged = overallFiles.size;
  for (const id of Object.keys(perSession)) {
    perSession[id]!.filesChanged = perSessionFiles[id]!.size;
  }
  return { overall, perSession };
}
