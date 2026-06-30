import type { DiktatMessage } from "../hooks/useDiktat";

export type RunStats = {
  files: number;
  edits: number;
  commands: number;
  added: number;
  removed: number;
};

// Count "+ " / "- " prefixed lines in a buildEditDiff-style block (mirrors the
// daemon's countDiffLines so the app's derived numbers match the real diffs).
function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+ ")) added++;
    else if (line.startsWith("- ")) removed++;
  }
  return { added, removed };
}

const toolKind = (name?: string): "edit" | "bash" | "other" => {
  if (!name) return "other";
  if (name.startsWith("Edit") || name.startsWith("Write")) return "edit";
  if (name.startsWith("Bash")) return "bash";
  return "other";
};

/**
 * Derive a compact run summary from the tool messages of a single run. Computed
 * client-side from the message stream the app already receives (the daemon only
 * transmits the rich summary via push) — so it never needs a daemon change.
 * Returns null when nothing actionable happened.
 */
export function computeRunStats(messages: DiktatMessage[]): RunStats | null {
  const files = new Set<string>();
  let edits = 0;
  let commands = 0;
  let added = 0;
  let removed = 0;

  for (const m of messages) {
    if (m.role !== "tool") continue;
    const kind = toolKind(m.toolName);
    if (kind === "edit") {
      edits++;
      if (m.toolPath) files.add(m.toolPath);
      if (m.toolDiff) {
        const c = countDiffLines(m.toolDiff);
        added += c.added;
        removed += c.removed;
      }
    } else if (kind === "bash") {
      commands++;
    }
  }

  if (edits === 0 && commands === 0) return null;
  return { files: files.size, edits, commands, added, removed };
}

/** Compact duration like "45s", "1m20s", "2m". */
export function formatRunDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m${rem}s` : `${m}m`;
}
