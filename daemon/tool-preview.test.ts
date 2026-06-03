import { test, expect } from "bun:test";
import { buildToolUsePreview, buildToolResultPreview } from "./tool-preview";

// Constants read from tool-preview.ts:
//   MAX_DIFF_LINES = 24, MAX_DIFF_BYTES = 2048
//   MAX_PREVIEW_LINES = 40, MAX_PREVIEW_BYTES = 2048
//   MAX_RESULT_BYTES = 4096, MAX_RESULT_HEAD_LINES = 60
//   MAX_BASH_CMD_CHARS = 500

// ---------------------------------------------------------------------------
// buildToolUsePreview — Edit
// ---------------------------------------------------------------------------

test("buildToolUsePreview Edit: diff has - old lines and + new lines", () => {
  const r = buildToolUsePreview("Edit", {
    old_string: "let a = 1\nlet b = 2",
    new_string: "let a = 10",
  });
  expect(r.diff).toBe("- let a = 1\n- let b = 2\n+ let a = 10");
  expect(r.truncated).toBe(false);
  expect(r.fullSize).toBe(Buffer.byteLength(r.diff!, "utf-8"));
});

test("buildToolUsePreview Edit: empty old+new returns {}", () => {
  expect(buildToolUsePreview("Edit", { old_string: "", new_string: "" })).toEqual({});
});

test("buildToolUsePreview Edit: only new_string still produces diff", () => {
  const r = buildToolUsePreview("Edit", { new_string: "added" });
  // old "" → "- ", new "added" → "+ added"
  expect(r.diff).toBe("- \n+ added");
});

test("buildToolUsePreview Edit: line cap (MAX_DIFF_LINES=24) truncates", () => {
  // 20 old + 20 new = 40 diff lines → over the 24-line cap
  const old = Array.from({ length: 20 }, (_, i) => `o${i}`).join("\n");
  const neu = Array.from({ length: 20 }, (_, i) => `n${i}`).join("\n");
  const r = buildToolUsePreview("Edit", { old_string: old, new_string: neu });
  expect(r.truncated).toBe(true);
  expect(r.diff!.split("\n")).toHaveLength(24);
});

// ---------------------------------------------------------------------------
// buildToolUsePreview — MultiEdit
// ---------------------------------------------------------------------------

test("buildToolUsePreview MultiEdit: renders multiple edits with headers", () => {
  const r = buildToolUsePreview("MultiEdit", {
    edits: [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ],
  });
  expect(r.diff).toContain("@@ edit 1 of 2 @@");
  expect(r.diff).toContain("@@ edit 2 of 2 @@");
  expect(r.diff).toContain("- a");
  expect(r.diff).toContain("+ d");
});

test("buildToolUsePreview MultiEdit: caps rendered edits at 4 with 'more edits' suffix", () => {
  const edits = Array.from({ length: 7 }, (_, i) => ({
    old_string: `old${i}`,
    new_string: `new${i}`,
  }));
  const r = buildToolUsePreview("MultiEdit", { edits });
  expect(r.diff).toContain("@@ edit 4 of 7 @@");
  expect(r.diff).not.toContain("@@ edit 5 of 7 @@");
  expect(r.diff).toContain("… +3 more edits");
});

test("buildToolUsePreview MultiEdit: no edits array → {}-ish diff of empty", () => {
  const r = buildToolUsePreview("MultiEdit", { edits: [] });
  // blocks empty → join "" → clampString("") → text ""
  expect(r.diff).toBe("");
  expect(r.truncated).toBe(false);
});

// ---------------------------------------------------------------------------
// buildToolUsePreview — Write
// ---------------------------------------------------------------------------

test("buildToolUsePreview Write: short content not truncated", () => {
  const r = buildToolUsePreview("Write", { content: "hello\nworld" });
  expect(r.preview).toBe("hello\nworld");
  expect(r.truncated).toBe(false);
  expect(r.fullSize).toBe(11);
});

test("buildToolUsePreview Write: empty content → {}", () => {
  expect(buildToolUsePreview("Write", { content: "" })).toEqual({});
});

test("buildToolUsePreview Write: line truncation (MAX_PREVIEW_LINES=40)", () => {
  const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
  const r = buildToolUsePreview("Write", { content });
  expect(r.truncated).toBe(true);
  expect(r.preview!.split("\n")).toHaveLength(40);
  expect(r.fullSize).toBe(Buffer.byteLength(content, "utf-8"));
});

test("buildToolUsePreview Write: byte truncation (MAX_PREVIEW_BYTES=2048)", () => {
  // One long single line, no newlines, well over 2048 bytes
  const content = "x".repeat(5000);
  const r = buildToolUsePreview("Write", { content });
  expect(r.truncated).toBe(true);
  expect(Buffer.byteLength(r.preview!, "utf-8")).toBeLessThanOrEqual(2048);
  expect(r.fullSize).toBe(5000);
});

// ---------------------------------------------------------------------------
// buildToolUsePreview — Bash
// ---------------------------------------------------------------------------

test("buildToolUsePreview Bash: short command passes through", () => {
  const r = buildToolUsePreview("Bash", { command: "npm test" });
  expect(r.command).toBe("npm test");
  expect(r.truncated).toBe(false);
  expect(r.fullSize).toBe(8);
});

test("buildToolUsePreview Bash: empty command → {}", () => {
  expect(buildToolUsePreview("Bash", { command: "" })).toEqual({});
});

test("buildToolUsePreview Bash: command truncated at MAX_BASH_CMD_CHARS=500 with ellipsis", () => {
  const cmd = "a".repeat(600);
  const r = buildToolUsePreview("Bash", { command: cmd });
  expect(r.truncated).toBe(true);
  expect(r.command).toBe("a".repeat(500) + "…");
  expect(r.fullSize).toBe(600);
});

// ---------------------------------------------------------------------------
// buildToolUsePreview — unknown / invalid
// ---------------------------------------------------------------------------

test("buildToolUsePreview Read (unhandled tool) → {}", () => {
  expect(buildToolUsePreview("Read", { file_path: "/a/b.ts" })).toEqual({});
});

test("buildToolUsePreview unknown tool → {}", () => {
  expect(buildToolUsePreview("Whatever", { foo: 1 })).toEqual({});
});

test("buildToolUsePreview null/non-object input → {} (early return)", () => {
  expect(buildToolUsePreview("Edit", null)).toEqual({});
  expect(buildToolUsePreview("Edit", undefined)).toEqual({});
  expect(buildToolUsePreview("Edit", "string")).toEqual({});
});

// ---------------------------------------------------------------------------
// buildToolResultPreview
// ---------------------------------------------------------------------------

test("buildToolResultPreview: plain string passthrough", () => {
  const r = buildToolResultPreview("just some output");
  expect(r).not.toBeNull();
  expect(r!.preview).toBe("just some output");
  expect(r!.truncated).toBe(false);
  expect(r!.fullSize).toBe(16);
});

test("buildToolResultPreview: array of text blocks joined, non-text skipped", () => {
  const r = buildToolResultPreview([
    { type: "text", text: "line one" },
    { type: "image", source: "..." },
    { type: "text", text: "line two" },
  ]);
  expect(r!.preview).toBe("line one\nline two");
});

test("buildToolResultPreview: {text:...} object coercion", () => {
  const r = buildToolResultPreview({ text: "coerced" });
  expect(r!.preview).toBe("coerced");
});

test("buildToolResultPreview: boilerplate 'has been updated successfully' → null", () => {
  expect(buildToolResultPreview("The file /foo/bar.ts has been updated successfully.")).toBeNull();
});

test("buildToolResultPreview: boilerplate 'has been created' → null", () => {
  expect(buildToolResultPreview("The file /x/y.ts has been created")).toBeNull();
});

test("buildToolResultPreview: empty/null/[]/{} → null", () => {
  expect(buildToolResultPreview("")).toBeNull();
  expect(buildToolResultPreview(null)).toBeNull();
  expect(buildToolResultPreview(undefined)).toBeNull();
  expect(buildToolResultPreview([])).toBeNull();
  expect(buildToolResultPreview({})).toBeNull();
  // array with only non-text blocks → joined "" → null
  expect(buildToolResultPreview([{ type: "image" }])).toBeNull();
});

test("buildToolResultPreview: long string truncated + fullSize is full byte length", () => {
  const text = "y".repeat(10000); // > MAX_RESULT_BYTES (4096)
  const r = buildToolResultPreview(text);
  expect(r!.truncated).toBe(true);
  expect(Buffer.byteLength(r!.preview, "utf-8")).toBeLessThanOrEqual(4096);
  expect(r!.fullSize).toBe(10000);
});

test("buildToolResultPreview: line-count truncation (MAX_RESULT_HEAD_LINES=60)", () => {
  const text = Array.from({ length: 100 }, (_, i) => `r${i}`).join("\n");
  const r = buildToolResultPreview(text);
  expect(r!.truncated).toBe(true);
  expect(r!.preview.split("\n")).toHaveLength(60);
});

// ---------------------------------------------------------------------------
// UTF-8 multibyte boundary
// ---------------------------------------------------------------------------

test("buildToolResultPreview: multibyte chars near byte limit are not broken", () => {
  // "😀" is 4 bytes. Build a string that exceeds MAX_RESULT_BYTES (4096).
  const emoji = "😀";
  const count = 2000; // 8000 bytes total, far over 4096
  const text = emoji.repeat(count);
  const r = buildToolResultPreview(text);
  expect(r!.truncated).toBe(true);
  // fullSize is the true byte length of the input
  expect(r!.fullSize).toBe(Buffer.byteLength(text, "utf-8"));
  // The preview must be valid UTF-8 with no broken/replacement characters.
  expect(r!.preview).not.toContain("�");
  // Re-encoding then decoding the preview must round-trip cleanly (no partial char).
  const reencoded = Buffer.from(r!.preview, "utf-8").toString("utf-8");
  expect(reencoded).toBe(r!.preview);
  // Every char should still be a full emoji.
  expect([...r!.preview].every((ch) => ch === emoji)).toBe(true);
  // And it stays within budget.
  expect(Buffer.byteLength(r!.preview, "utf-8")).toBeLessThanOrEqual(4096);
});

test("buildToolUsePreview Write: multibyte content stays within byte budget unbroken", () => {
  const content = "界".repeat(2000); // 3 bytes each = 6000 bytes
  const r = buildToolUsePreview("Write", { content });
  expect(r.truncated).toBe(true);
  expect(Buffer.byteLength(r.preview!, "utf-8")).toBeLessThanOrEqual(2048);
  expect(r.preview).not.toContain("�");
  expect([...r.preview!].every((ch) => ch === "界")).toBe(true);
  expect(r.fullSize).toBe(6000);
});
