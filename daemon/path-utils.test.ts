import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { decodeClaudePath, decodeCursorPath } from "./path-utils";

// decodeClaudePath / decodeCursorPath walk the real filesystem to disambiguate
// segments. The FS walk only kicks in when the encoded path starts with the
// home-dir prefix, so to exercise the longest-match walk we create real temp
// directories *under the actual home directory* and tear them down afterward.

const home = homedir();
const homeEncodedClaude = home.replace(/[^a-zA-Z0-9]/g, "-"); // leading '-'
const homeEncodedCursor = homeEncodedClaude.replace(/^-/, ""); // no leading '-'

// A unique sandbox directory living directly under $HOME.
const sandboxName = `diktat-pathtest-${Date.now()}`;
const sandboxAbs = join(home, sandboxName);

beforeAll(() => {
  // Create $HOME/<sandbox>/my-app/sub.dir  — note real hyphen + real dot.
  mkdirSync(join(sandboxAbs, "my-app", "sub.dir"), { recursive: true });
});

afterAll(() => {
  try {
    rmSync(sandboxAbs, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

function encodeClaude(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, "-");
}
function encodeCursor(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-/, "");
}

// ---------------------------------------------------------------------------
// Fallback: non-existent path → naive dash→slash replacement
// ---------------------------------------------------------------------------

test("decodeClaudePath: non-home prefix falls back to naive dash→slash", () => {
  // Does not start with homeEncoded → straight replacement, drop leading '-'.
  const encoded = "-opt-some-nonexistent-place";
  expect(decodeClaudePath(encoded)).toBe("/opt/some/nonexistent/place");
});

test("decodeCursorPath: non-home prefix falls back to naive dash→slash", () => {
  const encoded = "opt-some-nonexistent-place";
  expect(decodeCursorPath(encoded)).toBe("/opt/some/nonexistent/place");
});

test("decodeClaudePath: home-prefixed but non-existent child → naive replacement of remainder", () => {
  // Home prefix matches, but the child segments don't exist on disk.
  // resolveEncodedRelative finds no candidates → joins remainder with '/'.
  const encoded = homeEncodedClaude + "-no-such-dir-here-xyz";
  expect(decodeClaudePath(encoded)).toBe(join(home, "no/such/dir/here/xyz"));
});

// ---------------------------------------------------------------------------
// Round-trip: encode a real path, decode back to the real path
// ---------------------------------------------------------------------------

test("decodeClaudePath: round-trips a real nested path via FS walk", () => {
  const real = join(sandboxAbs, "my-app", "sub.dir");
  const decoded = decodeClaudePath(encodeClaude(real));
  expect(decoded).toBe(real);
});

test("decodeCursorPath: round-trips a real nested path via FS walk", () => {
  const real = join(sandboxAbs, "my-app", "sub.dir");
  const decoded = decodeCursorPath(encodeCursor(real));
  expect(decoded).toBe(real);
});

// ---------------------------------------------------------------------------
// Real-hyphen segment: "my-app" must decode as one segment, not "my/app"
// ---------------------------------------------------------------------------

test("decodeClaudePath: real hyphen in 'my-app' is preserved (not split)", () => {
  const real = join(sandboxAbs, "my-app");
  const decoded = decodeClaudePath(encodeClaude(real));
  expect(decoded).toBe(real);
  expect(decoded).not.toContain("my/app");
});

test("decodeCursorPath: real hyphen in 'my-app' is preserved (not split)", () => {
  const real = join(sandboxAbs, "my-app");
  const decoded = decodeCursorPath(encodeCursor(real));
  expect(decoded).toBe(real);
  expect(decoded).not.toContain("my/app");
});

test("decodeClaudePath: real dot in 'sub.dir' is preserved", () => {
  const real = join(sandboxAbs, "my-app", "sub.dir");
  const decoded = decodeClaudePath(encodeClaude(real));
  expect(decoded.endsWith("sub.dir")).toBe(true);
});

// ---------------------------------------------------------------------------
// Home-prefix vs non-home-prefix dispatch
// ---------------------------------------------------------------------------

test("decodeClaudePath: bare home prefix decodes to home dir itself", () => {
  // encoded == homeEncoded exactly → remainder empty → returns home.
  expect(decodeClaudePath(homeEncodedClaude)).toBe(home);
});

test("decodeCursorPath: bare home prefix decodes to home dir itself", () => {
  expect(decodeCursorPath(homeEncodedCursor)).toBe(home);
});

test("decodeClaudePath vs decodeCursorPath: differ only by leading '-' handling for non-home paths", () => {
  expect(decodeClaudePath("-var-log-system")).toBe("/var/log/system");
  expect(decodeCursorPath("var-log-system")).toBe("/var/log/system");
});
