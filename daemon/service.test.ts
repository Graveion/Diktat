/**
 * Tests for the launchd plist builder. The launchctl calls themselves can't run
 * in CI, so we cover the pure plist construction + XML escaping here.
 */
import { test, expect } from "bun:test";
import { buildPlist, xmlEscape, plistPath, SERVICE_LABEL } from "./service";

test("xmlEscape escapes the five XML predefined entities", () => {
  expect(xmlEscape(`a & b < c > d " e ' f`)).toBe(
    `a &amp; b &lt; c &gt; d &quot; e &apos; f`,
  );
});

test("buildPlist embeds interpreter, index.ts, label and keep-alive keys", () => {
  const p = buildPlist("/Users/me/.bun/bin/bun", "/Users/me/diktat", "/Users/me/.diktat/daemon.log");
  expect(p).toContain(`<string>${SERVICE_LABEL}</string>`);
  expect(p).toContain("<string>/Users/me/.bun/bin/bun</string>");
  expect(p).toContain("<string>/Users/me/diktat/index.ts</string>");
  expect(p).toContain("<key>RunAtLoad</key><true/>");
  expect(p).toContain("<key>KeepAlive</key><true/>");
  expect(p).toContain("/Users/me/.diktat/daemon.log");
});

test("buildPlist puts the interpreter dir + Homebrew on PATH", () => {
  const p = buildPlist("/Users/me/.bun/bin/bun", "/d", "/l");
  expect(p).toContain("/Users/me/.bun/bin");
  expect(p).toContain("/opt/homebrew/bin");
});

test("buildPlist escapes paths containing XML-special characters", () => {
  const p = buildPlist("/Users/a&b/bun", "/Users/a&b/diktat", "/l");
  expect(p).toContain("/Users/a&amp;b/bun");
  expect(p).not.toContain("/Users/a&b/bun"); // raw ampersand must not survive
});

test("plistPath targets the per-user LaunchAgents directory", () => {
  expect(plistPath()).toContain("/Library/LaunchAgents/");
  expect(plistPath()).toContain(`${SERVICE_LABEL}.plist`);
});
