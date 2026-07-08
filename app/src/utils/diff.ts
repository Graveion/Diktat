// Parse the daemon's simple unified-style diff (see daemon/tool-preview.ts
// buildEditDiff: "- old" lines then "+ new" lines; MultiEdit adds "@@ edit i of
// n @@" separators). It is NOT an LCS-aligned diff, so we render per-line
// add/del/context with a marker gutter — no real file line numbers or
// word-level intra-line highlighting (the daemon doesn't emit the alignment
// those would need).

export type DiffRowKind = "add" | "del" | "ctx" | "sep";
export type DiffRow = { kind: DiffRowKind; text: string };

export function parseDiff(diff: string): DiffRow[] {
  return diff.split("\n").map((line): DiffRow => {
    // Daemon uses "+ "/"- " (prefix + space); tolerate a bare +/- too.
    if (line.startsWith("+ ")) return { kind: "add", text: line.slice(2) };
    if (line.startsWith("- ")) return { kind: "del", text: line.slice(2) };
    if (line.startsWith("@@") || line.startsWith("…")) return { kind: "sep", text: line };
    if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
    if (line.startsWith("-")) return { kind: "del", text: line.slice(1) };
    return { kind: "ctx", text: line };
  });
}

export function diffCounts(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { added, removed };
}

/**
 * Make leading indentation visible: replace the leading run of spaces/tabs with
 * middle-dots so nested edits don't look flush-left. Only the leading run is
 * touched; interior spacing is left alone. Purely cosmetic — the raw text is
 * still what gets copied.
 */
export function showLeadingWhitespace(s: string): string {
  const m = s.match(/^[ \t]+/);
  if (!m) return s;
  const dots = m[0].replace(/\t/g, "  ").replace(/ /g, "·");
  return dots + s.slice(m[0].length);
}
