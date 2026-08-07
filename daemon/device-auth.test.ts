import { test, expect } from "bun:test";
import {
  parseDeviceCode,
  hasVerificationPrompt,
  classifyAuthOutput,
  DeviceCodeScanner,
} from "./device-auth";

// ---------------------------------------------------------------------------
// parseDeviceCode — extract URL / code / expiry from real-ish device-flow output
// ---------------------------------------------------------------------------

test("parseDeviceCode: GitHub Copilot device flow", () => {
  const out =
    "! First copy your one-time code: WDJB-MJHT\n" +
    "Press Enter to open github.com in your browser...\n" +
    "Open https://github.com/login/device in your browser\n";
  const info = parseDeviceCode(out);
  expect(info.verificationUrl).toBe("https://github.com/login/device");
  expect(info.userCode).toBe("WDJB-MJHT");
});

test("parseDeviceCode: Codex device-auth with expiry in seconds", () => {
  const out =
    "To sign in, open https://auth.openai.com/device and enter code ABCD-1234.\n" +
    "This code expires in 900 seconds.\n";
  const info = parseDeviceCode(out);
  expect(info.verificationUrl).toBe("https://auth.openai.com/device");
  expect(info.userCode).toBe("ABCD-1234");
  expect(info.expiresInSec).toBe(900);
});

test("parseDeviceCode: AWS Builder ID (Kiro) with minutes expiry, lower-case code normalized", () => {
  const out =
    "Confirm the following code in the browser\n" +
    "Code: sggh-kwsl\n" +
    "Open the following URL: https://device.sso.us-east-1.amazonaws.com/\n" +
    "The code will expire in 15 minutes.\n";
  const info = parseDeviceCode(out);
  expect(info.verificationUrl).toBe("https://device.sso.us-east-1.amazonaws.com/");
  expect(info.userCode).toBe("SGGH-KWSL"); // normalized to upper-case
  expect(info.expiresInSec).toBe(15 * 60);
});

test("parseDeviceCode: trailing punctuation is stripped from the URL", () => {
  expect(parseDeviceCode("Visit https://github.com/login/device.").verificationUrl).toBe(
    "https://github.com/login/device",
  );
  expect(parseDeviceCode("(see https://example.com/x)").verificationUrl).toBe("https://example.com/x");
});

test("hasVerificationPrompt: needs at least a URL", () => {
  expect(hasVerificationPrompt({})).toBe(false);
  expect(hasVerificationPrompt({ userCode: "WDJB-MJHT" })).toBe(false);
  expect(hasVerificationPrompt({ verificationUrl: "https://x.dev" })).toBe(true);
});

// ---------------------------------------------------------------------------
// classifyAuthOutput — terminal success/failure detection
// ---------------------------------------------------------------------------

test("classifyAuthOutput: success phrases", () => {
  for (const s of [
    "✓ Logged in as octocat",
    "Login successful.",
    "Successfully authenticated with AWS Builder ID",
    "You are now signed in.",
    "Authentication complete.",
  ]) {
    expect(classifyAuthOutput(s)).toBe("success");
  }
});

test("classifyAuthOutput: failure phrases", () => {
  for (const s of [
    "Login failed: the device code has expired",
    "Authentication failed.",
    "Error: access denied",
    "The authorization request timed out.",
    "User cancelled the login.",
  ]) {
    expect(classifyAuthOutput(s)).toBe("failed");
  }
});

test("classifyAuthOutput: the benign 'expires in N' prompt is NOT a failure", () => {
  expect(classifyAuthOutput("This code expires in 900 seconds.")).toBe(null);
  expect(classifyAuthOutput("Open https://github.com/login/device and enter WDJB-MJHT")).toBe(null);
});

// ---------------------------------------------------------------------------
// DeviceCodeScanner — stateful accumulation across chunk boundaries
// ---------------------------------------------------------------------------

test("DeviceCodeScanner: fields can arrive in separate chunks; ready flips once URL seen", () => {
  const s = new DeviceCodeScanner();
  let r = s.push("Your one-time code: WDJB-MJHT\n");
  expect(r.ready).toBe(false); // code but no URL yet
  expect(r.info.userCode).toBe("WDJB-MJHT");

  r = s.push("Open https://github.com/login/device\n");
  expect(r.ready).toBe(true);
  expect(r.info.verificationUrl).toBe("https://github.com/login/device");
  expect(r.info.userCode).toBe("WDJB-MJHT"); // retained from the earlier chunk
  expect(r.outcome).toBe(null);
});

test("DeviceCodeScanner: reassembles a URL split across a chunk boundary", () => {
  const s = new DeviceCodeScanner();
  s.push("Open https://github.com/log");
  const r = s.push("in/device and enter WDJB-MJHT\n");
  expect(r.info.verificationUrl).toBe("https://github.com/login/device");
});

test("DeviceCodeScanner: records the terminal outcome and never downgrades it", () => {
  const s = new DeviceCodeScanner();
  s.push("Open https://github.com/login/device — code WDJB-MJHT\n");
  expect(s.terminalOutcome).toBe(null);
  s.push("✓ Logged in as octocat\n");
  expect(s.terminalOutcome).toBe("success");
  // A later stray line must not flip an already-decided outcome.
  s.push("some error text\n");
  expect(s.terminalOutcome).toBe("success");
});
