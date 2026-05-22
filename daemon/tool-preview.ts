// Build compact previews of tool inputs and results for the phone UI.
// Output is meant to be tapped-to-expand on the phone, so we cap aggressively.

const MAX_DIFF_LINES = 24;
const MAX_DIFF_BYTES = 2048;
const MAX_PREVIEW_LINES = 40;
const MAX_PREVIEW_BYTES = 2048;
const MAX_RESULT_BYTES = 4096;
const MAX_RESULT_HEAD_LINES = 60;
const MAX_BASH_CMD_CHARS = 500;

export interface ToolUsePreview {
  diff?: string;       // unified-style +/- for Edit/MultiEdit
  preview?: string;    // truncated content for Write
  command?: string;    // command text for Bash
  truncated?: boolean;
  fullSize?: number;
}

export interface ToolResultPreview {
  preview: string;
  truncated: boolean;
  fullSize: number;    // bytes
}

function clampString(s: string, maxBytes: number, maxLines: number): { text: string; truncated: boolean; fullSize: number } {
  const bytes = Buffer.byteLength(s, "utf-8");
  if (bytes <= maxBytes) {
    const lines = s.split("\n");
    if (lines.length <= maxLines) return { text: s, truncated: false, fullSize: bytes };
    return { text: lines.slice(0, maxLines).join("\n"), truncated: true, fullSize: bytes };
  }
  // Cut on a UTF-8 safe boundary by slicing chars until under budget
  let out = "";
  let outBytes = 0;
  for (const ch of s) {
    const chBytes = Buffer.byteLength(ch, "utf-8");
    if (outBytes + chBytes > maxBytes) break;
    out += ch;
    outBytes += chBytes;
  }
  const lines = out.split("\n");
  if (lines.length > maxLines) out = lines.slice(0, maxLines).join("\n");
  return { text: out, truncated: true, fullSize: bytes };
}

function buildEditDiff(oldStr: string, newStr: string): string {
  // Simple unified-style block: dash the old lines, plus the new lines.
  // (Not a real LCS diff — old_string is already the targeted region.)
  const oldLines = oldStr.split("\n").map((l) => `- ${l}`);
  const newLines = newStr.split("\n").map((l) => `+ ${l}`);
  return [...oldLines, ...newLines].join("\n");
}

export function buildToolUsePreview(name: string, input: any): ToolUsePreview {
  if (!input || typeof input !== "object") return {};
  switch (name) {
    case "Edit": {
      const oldS = typeof input.old_string === "string" ? input.old_string : "";
      const newS = typeof input.new_string === "string" ? input.new_string : "";
      if (!oldS && !newS) return {};
      const diff = buildEditDiff(oldS, newS);
      const c = clampString(diff, MAX_DIFF_BYTES, MAX_DIFF_LINES);
      return { diff: c.text, truncated: c.truncated, fullSize: c.fullSize };
    }
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const blocks = edits.slice(0, 4).map((e: any, i: number) => {
        const oldS = typeof e?.old_string === "string" ? e.old_string : "";
        const newS = typeof e?.new_string === "string" ? e.new_string : "";
        return `@@ edit ${i + 1} of ${edits.length} @@\n${buildEditDiff(oldS, newS)}`;
      });
      if (edits.length > 4) blocks.push(`… +${edits.length - 4} more edits`);
      const c = clampString(blocks.join("\n\n"), MAX_DIFF_BYTES, MAX_DIFF_LINES);
      return { diff: c.text, truncated: c.truncated, fullSize: c.fullSize };
    }
    case "Write": {
      const content = typeof input.content === "string" ? input.content : "";
      if (!content) return {};
      const c = clampString(content, MAX_PREVIEW_BYTES, MAX_PREVIEW_LINES);
      return { preview: c.text, truncated: c.truncated, fullSize: c.fullSize };
    }
    case "Bash": {
      const cmd = typeof input.command === "string" ? input.command : "";
      if (!cmd) return {};
      const truncated = cmd.length > MAX_BASH_CMD_CHARS;
      const text = truncated ? cmd.slice(0, MAX_BASH_CMD_CHARS) + "…" : cmd;
      return { command: text, truncated, fullSize: Buffer.byteLength(cmd, "utf-8") };
    }
    default:
      return {};
  }
}

// Tool results live in the *next* user entry of the JSONL (or stream).
// `result` is either a string or an array of content blocks; we coerce to string.
export function buildToolResultPreview(result: any): ToolResultPreview | null {
  let text = "";
  if (typeof result === "string") {
    text = result;
  } else if (Array.isArray(result)) {
    text = result
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  } else if (result && typeof result === "object" && typeof (result as any).text === "string") {
    text = (result as any).text;
  }
  if (!text) return null;
  // Drop the "The file has been updated successfully" boilerplate for Edit/Write — useless.
  if (/^the file .+ has been (created|updated)/i.test(text.trim())) return null;
  const c = clampString(text, MAX_RESULT_BYTES, MAX_RESULT_HEAD_LINES);
  return { preview: c.text, truncated: c.truncated, fullSize: c.fullSize };
}
