import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readHead, readTail } from "./file-read";

function withTempFile(content: string | Buffer, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "diktat-fr-"));
  const path = join(dir, "f.jsonl");
  writeFileSync(path, content);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readHead: returns whole file when smaller than cap", () => {
  withTempFile("line1\nline2\n", (p) => {
    expect(readHead(p, 1024)).toBe("line1\nline2\n");
  });
});

test("readHead: caps the number of bytes read", () => {
  withTempFile("x".repeat(10_000), (p) => {
    expect(readHead(p, 100).length).toBe(100);
  });
});

test("readHead: missing file returns empty string", () => {
  expect(readHead("/no/such/file.jsonl")).toBe("");
});

test("readHead: empty file returns empty string", () => {
  withTempFile("", (p) => expect(readHead(p)).toBe(""));
});

test("readTail: returns whole file when smaller than cap", () => {
  withTempFile("a\nb\nc\n", (p) => {
    expect(readTail(p, 1024)).toBe("a\nb\nc\n");
  });
});

test("readTail: drops the partial first line when starting mid-file", () => {
  // 3 lines; cap small enough that we start inside line 1.
  const content = "AAAAAAAAAA\nBBBB\nCCCC\n";
  withTempFile(content, (p) => {
    // Cap of 12 bytes => start at offset (21-12)=9, inside line 1; first
    // partial line is dropped, leaving whole lines only.
    const tail = readTail(p, 12);
    expect(tail.startsWith("AAAA")).toBe(false);
    // Every returned line must be parseable as a whole (no partial head).
    expect(tail).toBe("BBBB\nCCCC\n");
  });
});

test("readTail: a huge JSONL only reads the cap, last line intact", () => {
  // 5000 json lines; only the last few should survive a small cap.
  const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ n: i }));
  withTempFile(lines.join("\n") + "\n", (p) => {
    const tail = readTail(p, 200);
    const parsed = tail.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    // Last entry is intact and is the final line.
    expect(parsed[parsed.length - 1]).toEqual({ n: 4999 });
    expect(tail.length).toBeLessThanOrEqual(200);
  });
});

test("readTail: missing file returns empty string", () => {
  expect(readTail("/no/such/file.jsonl")).toBe("");
});
