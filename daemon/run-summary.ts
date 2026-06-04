// Per-run accumulator + summary/body builder for the task-completion push.
//
// As the daemon parses the tool stream during a single CLI run, it feeds each
// tool_use / tool_result into `accumulateToolEvent`. At the end of the run it
// finalizes into a RunSummary (`finalizeRunSummary`) and renders a compact push
// body (`formatPushBody`). These are pure functions so they can be unit-tested
// without spawning a process.

export type TestStatus = "pass" | "fail" | "none";

// Mutable accumulator carried on the Session for the duration of one runCLI.
export interface RunAccumulator {
  filesChanged: Set<string>;
  editCount: number;
  linesAdded: number;
  linesRemoved: number;
  commandsRun: number;
  lastCommand?: string;
  testStatus: TestStatus;
  testDetail?: string;
  startedAt: number;
  // Track the call/tool id of any in-flight test Bash command so its result
  // preview can be matched up when it arrives.
  pendingTestToolIds: Set<string>;
}

// Plain, serializable shape used for the push `data` payload and for tests.
export interface RunSummary {
  filesChanged: string[];
  editCount: number;
  linesAdded: number;
  linesRemoved: number;
  commandsRun: number;
  lastCommand?: string;
  testStatus: TestStatus;
  testDetail?: string;
  durationMs: number;
  exitCode: number;
}

export function newRunAccumulator(startedAt: number = Date.now()): RunAccumulator {
  return {
    filesChanged: new Set<string>(),
    editCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    commandsRun: 0,
    lastCommand: undefined,
    testStatus: "none",
    testDetail: undefined,
    startedAt,
    pendingTestToolIds: new Set<string>(),
  };
}

// Does a Bash command look like a test run?
const TEST_CMD = /\b(test|jest|vitest|pytest|go test|cargo test|bun test|npm (run )?test)\b/i;

export function isTestCommand(command: string): boolean {
  return TEST_CMD.test(command);
}

// Count "+ " / "- " prefixed lines in a buildEditDiff-style block.
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+ ")) added++;
    else if (line.startsWith("- ")) removed++;
  }
  return { added, removed };
}

// A normalized tool event the accumulator understands. The daemon adapts both
// Claude (tool_use) and Cursor (tool_call) shapes to this.
export interface ToolUseEvent {
  kind: "tool_use";
  name: string;
  id?: string;
  // For Edit/MultiEdit: the +/- diff the daemon already built.
  diff?: string;
  // For Write: the file content (we count its lines as added).
  content?: string;
  // For file tools: the resolved path.
  path?: string;
  // For Bash: the command string.
  command?: string;
}

export interface ToolResultEvent {
  kind: "tool_result";
  id?: string;
  preview?: string;
}

export type ToolEvent = ToolUseEvent | ToolResultEvent;

// Scan a test command's result preview for pass/fail signals. Best-effort.
export function detectTestResult(preview: string): { status: TestStatus; detail?: string } {
  const failedNum = preview.match(/(\d+)\s+failed/i);
  // "0 failed" is not a failure — fall through to the passed/none checks.
  if (failedNum && Number(failedNum[1]) > 0) {
    return { status: "fail", detail: `${failedNum[1]} failed` };
  }
  const passedNum = preview.match(/(\d+)\s+passed/i);
  if (passedNum) {
    return { status: "pass", detail: `${passedNum[1]} passed` };
  }
  // A bare FAIL token (e.g. jest "FAIL src/foo.test.ts") with no count.
  if (/\bFAIL\b/.test(preview)) {
    return { status: "fail" };
  }
  return { status: "none" };
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

// Update the accumulator with a single normalized tool event.
export function accumulateToolEvent(acc: RunAccumulator, event: ToolEvent): void {
  if (event.kind === "tool_use") {
    if (EDIT_TOOLS.has(event.name)) {
      acc.editCount++;
      if (event.path) acc.filesChanged.add(event.path);
      if (event.name === "Write") {
        if (typeof event.content === "string" && event.content.length > 0) {
          acc.linesAdded += event.content.split("\n").length;
        }
      } else if (typeof event.diff === "string") {
        const { added, removed } = countDiffLines(event.diff);
        acc.linesAdded += added;
        acc.linesRemoved += removed;
      }
    } else if (event.name === "Bash") {
      acc.commandsRun++;
      if (typeof event.command === "string") {
        acc.lastCommand = event.command.trim();
        if (event.id && isTestCommand(event.command)) {
          acc.pendingTestToolIds.add(event.id);
        }
      }
    }
    return;
  }

  // tool_result: only interesting if it matches a pending test command.
  if (event.id && acc.pendingTestToolIds.has(event.id) && typeof event.preview === "string") {
    const result = detectTestResult(event.preview);
    if (result.status !== "none") {
      // A failure anywhere should win over a later pass.
      if (acc.testStatus !== "fail") {
        acc.testStatus = result.status;
        acc.testDetail = result.detail;
      }
    }
  }
}

export function finalizeRunSummary(
  acc: RunAccumulator,
  exitCode: number,
  endedAt: number = Date.now(),
): RunSummary {
  return {
    filesChanged: [...acc.filesChanged],
    editCount: acc.editCount,
    linesAdded: acc.linesAdded,
    linesRemoved: acc.linesRemoved,
    commandsRun: acc.commandsRun,
    lastCommand: acc.lastCommand,
    testStatus: acc.testStatus,
    testDetail: acc.testDetail,
    durationMs: Math.max(0, endedAt - acc.startedAt),
    exitCode,
  };
}

// Compact duration like "45s", "1m20s", "2m".
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m${sec}s`;
}

// Build the push body. Worst news (test fail / non-zero exit) goes first.
export function formatPushBody(summary: RunSummary): string {
  const duration = formatDuration(summary.durationMs);
  const parts: string[] = [];

  const filesPart = () => {
    const n = summary.filesChanged.length;
    return `${n} file${n === 1 ? "" : "s"}`;
  };
  const linesPart = () => `+${summary.linesAdded}/−${summary.linesRemoved}`;
  const testFailPart = () =>
    `tests ✗${summary.testDetail ? ` ${summary.testDetail}` : ""}`;
  const testPassPart = () =>
    `tests ✓${summary.testDetail ? ` ${summary.testDetail}` : ""}`;

  const hasEdits = summary.filesChanged.length > 0 || summary.linesAdded > 0 || summary.linesRemoved > 0;

  // Lead with the worst news.
  if (summary.testStatus === "fail") {
    parts.push(testFailPart());
    if (hasEdits) {
      parts.push(filesPart());
      parts.push(linesPart());
    }
    parts.push(duration);
    return parts.join(" · ");
  }

  if (!hasEdits) {
    // No file changes. Still surface a test pass or last command if present.
    if (summary.testStatus === "pass") parts.push(testPassPart());
    parts.push("No file changes");
    parts.push(duration);
    return parts.join(" · ");
  }

  parts.push(filesPart());
  parts.push(linesPart());
  if (summary.testStatus === "pass") parts.push(testPassPart());
  parts.push(duration);
  return parts.join(" · ");
}

// Title mirrors today's behaviour but adds a failure variant.
export function formatPushTitle(project: string, exitCode: number): string {
  return exitCode === 0 ? `✓ ${project}` : `✗ ${project} — exited ${exitCode}`;
}

// String-map payload for the push `data` field (Expo requires JSON-able data;
// we keep everything serializable but typed loosely here).
export function summaryToPushData(sessionId: string, summary: RunSummary): Record<string, any> {
  return {
    sessionId,
    exitCode: summary.exitCode,
    filesChanged: summary.filesChanged,
    editCount: summary.editCount,
    linesAdded: summary.linesAdded,
    linesRemoved: summary.linesRemoved,
    commandsRun: summary.commandsRun,
    ...(summary.lastCommand ? { lastCommand: summary.lastCommand } : {}),
    testStatus: summary.testStatus,
    ...(summary.testDetail ? { testDetail: summary.testDetail } : {}),
    durationMs: summary.durationMs,
  };
}
