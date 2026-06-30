import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

// True when running as a `bun build --compile` standalone binary: embedded files
// live under the virtual "/$bunfs" root, so import.meta.dir points there rather
// than at a real source directory.
export const COMPILED = import.meta.dir.startsWith("/$bunfs");

/**
 * Where the daemon keeps its data (config.json, sessions/, run-stats.jsonl).
 *
 * - Binary install: a fixed ~/.diktat — both the CLI and the daemon resolve the
 *   same absolute path regardless of the shell's cwd.
 * - Source/dev install: the daemon source directory, preserving the existing
 *   layout so current pairings keep working unchanged.
 */
export const DATA_DIR = COMPILED ? join(homedir(), ".diktat") : import.meta.dir;

/** Resolve a path inside the data dir. */
export function dataPath(...segments: string[]): string {
  return join(DATA_DIR, ...segments);
}

/** Ensure the data dir exists (lazily, before a write). */
export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}
