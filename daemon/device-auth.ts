// ─── Device-code re-authentication parsing ───────────────────────────────────
//
// When an agent CLI's own provider auth has expired, some CLIs offer a device
// authorization flow (RFC 8628): the CLI prints a verification URL + a short
// user code, the user opens that URL on ANY device and enters the code, and the
// CLI polls until authorized. No secret is ever typed into the daemon or the
// phone — the user completes sign-in on the provider's own web page — which is
// what makes it safe to drive remotely.
//
// This module is the PURE, testable core: it scans the CLI's stdout/stderr for
// the verification URL, the user code, and (best-effort) an expiry, and it
// classifies terminal success/failure lines. The PTY orchestration that feeds
// it lives in session.ts (it can't be unit-tested without a live CLI).
//
// SECURITY: the verification URL + user code are single-use credentials scoped
// to this login attempt. This module never logs them; callers must not either.

/** What we can extract from a device-flow login's output. */
export interface DeviceCodeInfo {
  /** The provider page the user opens (e.g. https://github.com/login/device). */
  verificationUrl?: string;
  /** The short code the user enters on that page (e.g. WDJB-MJHT). */
  userCode?: string;
  /** Best-effort code lifetime, normalized to seconds, when the CLI prints it. */
  expiresInSec?: number;
}

// First http(s) URL in the text. Device flows print exactly one verification
// URL; trailing punctuation (., ), ], >, quotes) is excluded from the capture.
// The scanner only ever runs this on COMPLETE lines, so a URL split across a
// chunk boundary is never captured truncated.
const URL_RE = /(https?:\/\/[^\s'"<>)\]]+[^\s'"<>)\].,])/i;

// User code shapes seen across GitHub (XXXX-XXXX), AWS Builder ID (XXXX-XXXX),
// and OpenAI device flows — 4+4 alphanumeric with a hyphen. Case-insensitive
// match, normalized to upper-case (providers display upper-case).
const CODE_RE = /\b([A-Za-z0-9]{4}-[A-Za-z0-9]{4})\b/;

// Best-effort expiry, e.g. "expires in 900 seconds" / "code expires in 15 minutes".
// The unit allows an optional trailing "s" (seconds/minutes/hours).
const EXPIRES_RE = /expir\w*(?:\s+in)?\s*[:=]?\s*(\d+)\s*(second|sec|minute|min|hour|s|m|h)s?\b/i;

// Terminal success — the CLI confirms the session is authenticated.
const SUCCESS_RE =
  /(logged in|login succeeded|login successful|successfully (?:logged|authenticated|signed)|authentication (?:complete|succeeded|successful)|you(?:'re| are) (?:now )?(?:logged|signed) in|authorization complete)/i;

// Terminal failure — an explicit auth failure. Deliberately NOT matching a bare
// "expired"/"error", so the benign "expires in N" prompt text can't trip it.
const FAILURE_RE =
  /(login failed|authentication failed|failed to (?:log|sign|authenticate)|authoriz\w+ (?:denied|failed|expired)|device (?:code|authorization) (?:has )?expired|request expired|timed out|access denied|too many attempts|user (?:cancell?ed|denied))/i;

function toSeconds(n: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return n * 3600;
  if (u === "m" || u.startsWith("min")) return n * 60;
  return n; // seconds
}

/**
 * Extract whatever device-code fields are present in a blob of output. Pure —
 * pass the accumulated text (URL and code can arrive on separate lines).
 */
export function parseDeviceCode(text: string): DeviceCodeInfo {
  const info: DeviceCodeInfo = {};
  const url = text.match(URL_RE);
  if (url) info.verificationUrl = url[1];
  const code = text.match(CODE_RE);
  if (code) info.userCode = code[1]!.toUpperCase();
  const exp = text.match(EXPIRES_RE);
  if (exp) info.expiresInSec = toSeconds(Number(exp[1]), exp[2]!);
  return info;
}

/** True once we have enough to prompt the user (a URL is the minimum). */
export function hasVerificationPrompt(info: DeviceCodeInfo): boolean {
  return typeof info.verificationUrl === "string" && info.verificationUrl.length > 0;
}

/**
 * Classify a chunk of output as a terminal auth outcome, or null if it's still
 * in progress. Success takes precedence over failure (a CLI may print "code
 * expired, retrying" then succeed).
 */
export function classifyAuthOutput(text: string): "success" | "failed" | null {
  if (SUCCESS_RE.test(text)) return "success";
  if (FAILURE_RE.test(text)) return "failed";
  return null;
}

/**
 * Stateful accumulator over a login's streamed output. Not a singleton — one is
 * constructed per device-auth attempt in session.ts. Kept here (next to the
 * regexes) so its behaviour is unit-testable without spawning a process.
 */
export class DeviceCodeScanner {
  private info: DeviceCodeInfo = {};
  private carry = ""; // trailing partial line not yet terminated by a newline
  private seen = ""; // accumulated COMPLETE lines (capped)
  private outcome: "success" | "failed" | null = null;

  /**
   * Feed a chunk. Only complete lines are parsed — the verification URL and
   * user code print on their own lines, so waiting for the terminating newline
   * avoids capturing a URL that's been split across a pipe read. Returns the
   * current best-known info, whether a prompt is ready, and any terminal outcome.
   */
  push(chunk: string): { info: DeviceCodeInfo; ready: boolean; outcome: "success" | "failed" | null } {
    this.carry += chunk;
    const nl = this.carry.lastIndexOf("\n");
    if (nl >= 0) {
      const complete = this.carry.slice(0, nl + 1);
      this.carry = this.carry.slice(nl + 1);
      // Cap the retained text — device-flow prompts are tiny; enough to match a
      // URL/code across the handful of lines they span.
      this.seen = (this.seen + complete).slice(-8192);
      const found = parseDeviceCode(this.seen);
      // Only ever fill in fields, never clear them (poll spinners re-print lines
      // and the URL may scroll out of the retained window later).
      if (found.verificationUrl && !this.info.verificationUrl) this.info.verificationUrl = found.verificationUrl;
      if (found.userCode && !this.info.userCode) this.info.userCode = found.userCode;
      if (found.expiresInSec && !this.info.expiresInSec) this.info.expiresInSec = found.expiresInSec;
      if (!this.outcome) this.outcome = classifyAuthOutput(complete);
    }
    return { info: { ...this.info }, ready: hasVerificationPrompt(this.info), outcome: this.outcome };
  }

  get current(): DeviceCodeInfo {
    return { ...this.info };
  }
  get ready(): boolean {
    return hasVerificationPrompt(this.info);
  }
  get terminalOutcome(): "success" | "failed" | null {
    return this.outcome;
  }
}
