// ─── Bounded file reads ──────────────────────────────────────────────────────
//
// Session JSONL files can grow unbounded (a long conversation is megabytes).
// Nothing here ever reads a whole file: callers either peek the head (to grab
// the first user message / cwd) or tail the end (to render the last N messages).
// Both have a hard byte ceiling, so cost is O(cap), independent of file size.

import { openSync, readSync, closeSync, statSync } from "fs";

/** Hard cap for head peeks (first-message / cwd extraction). */
export const HEAD_BYTES = 64 * 1024; // 64 KB
/** Hard cap for history tails. ~the last few hundred messages of context. */
export const TAIL_BYTES = 1024 * 1024; // 1 MB

/**
 * Read up to `maxBytes` from the **start** of a file. The returned string may
 * end mid-line; callers split on "\n" and tolerate a trailing partial line
 * (JSON.parse fails → skipped). Returns "" on any error.
 */
export function readHead(filePath: string, maxBytes = HEAD_BYTES): string {
  try {
    const size = statSync(filePath).size;
    const toRead = Math.min(size, maxBytes);
    if (toRead <= 0) return "";
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(toRead);
      const n = readSync(fd, buf, 0, toRead, 0);
      return buf.subarray(0, n).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * Read up to the last `maxBytes` of a file. If the file is larger than the cap
 * we start mid-file, so the **first** (partial) line is dropped to keep every
 * returned line whole. The tail of a JSONL file ends on a newline, so the last
 * line is clean. Returns "" on any error.
 */
export function readTail(filePath: string, maxBytes = TAIL_BYTES): string {
  try {
    const size = statSync(filePath).size;
    if (size <= 0) return "";
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, start);
      let s = buf.subarray(0, n).toString("utf-8");
      if (start > 0) {
        // Dropped into the middle of a line (and possibly a multibyte char) —
        // discard everything up to and including the first newline.
        const nl = s.indexOf("\n");
        s = nl >= 0 ? s.slice(nl + 1) : "";
      }
      return s;
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}
