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

test("buildPlist embeds the program argv, workdir, label and keep-alive keys", () => {
  const p = buildPlist(["/Users/me/.bun/bin/bun", "/Users/me/diktat/index.ts"], "/Users/me/diktat", "/Users/me/.diktat/daemon.log");
  expect(p).toContain(`<string>${SERVICE_LABEL}</string>`);
  expect(p).toContain("<string>/Users/me/.bun/bin/bun</string>");
  expect(p).toContain("<string>/Users/me/diktat/index.ts</string>");
  expect(p).toContain("<key>WorkingDirectory</key><string>/Users/me/diktat</string>");
  expect(p).toContain("<key>RunAtLoad</key><true/>");
  expect(p).toContain("<key>KeepAlive</key><true/>");
  expect(p).toContain("/Users/me/.diktat/daemon.log");
});

test("buildPlist supports a compiled-binary daemon-mode argv", () => {
  const p = buildPlist(["/Users/me/.local/bin/diktat", "__daemon"], "/Users/me/.diktat", "/l");
  expect(p).toContain("<string>/Users/me/.local/bin/diktat</string>");
  expect(p).toContain("<string>__daemon</string>");
  expect(p).toContain("<key>WorkingDirectory</key><string>/Users/me/.diktat</string>");
});

test("buildPlist puts the executable dir + Homebrew on PATH", () => {
  const p = buildPlist(["/Users/me/.bun/bin/bun", "x"], "/d", "/l");
  expect(p).toContain("/Users/me/.bun/bin");
  expect(p).toContain("/opt/homebrew/bin");
});

test("buildPlist prepends the inherited PATH (so CLI shims are found) and dedupes", () => {
  const p = buildPlist(["/Users/me/.bun/bin/bun", "x"], "/d", "/l", "/Users/me/.volta/bin:/usr/bin");
  // Extract the PATH string from the plist.
  const path = p.match(/<key>PATH<\/key><string>([^<]+)<\/string>/)![1]!;
  const parts = path.split(":");
  expect(parts[0]).toBe("/Users/me/.volta/bin"); // inherited entry comes first
  expect(parts.filter((x) => x === "/usr/bin").length).toBe(1); // deduped vs fallback
});

test("buildPlist escapes paths containing XML-special characters", () => {
  const p = buildPlist(["/Users/a&b/bun", "/Users/a&b/diktat/index.ts"], "/Users/a&b/diktat", "/l");
  expect(p).toContain("/Users/a&amp;b/bun");
  expect(p).not.toContain("/Users/a&b/bun"); // raw ampersand must not survive
});

test("plistPath targets the per-user LaunchAgents directory", () => {
  expect(plistPath()).toContain("/Library/LaunchAgents/");
  expect(plistPath()).toContain(`${SERVICE_LABEL}.plist`);
});
