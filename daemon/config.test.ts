import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "./config";

const tmpDirs: string[] = [];

function tmpConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "diktat-config-"));
  tmpDirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, contents, "utf-8");
  return path;
}

afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test("loadConfig: parses a valid config file", () => {
  const path = tmpConfig(JSON.stringify({ port: 9000, projects: ["/a", "/b"] }));
  const cfg = loadConfig(path);
  expect(cfg.port).toBe(9000);
  expect(cfg.projects).toEqual(["/a", "/b"]);
});

test("loadConfig: missing file calls process.exit(1)", () => {
  const realExit = process.exit;
  let exitCode: number | undefined;
  // Throw out of the stubbed exit so control doesn't fall through to readFileSync.
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error("process.exit called");
  }) as typeof process.exit;
  try {
    expect(() => loadConfig(join(tmpdir(), "definitely-does-not-exist-config.json"))).toThrow(
      "process.exit called",
    );
    expect(exitCode).toBe(1);
  } finally {
    process.exit = realExit;
  }
});

test("loadConfig: invalid JSON throws (surfaced to caller)", () => {
  const path = tmpConfig("{ not valid json");
  expect(() => loadConfig(path)).toThrow();
});
