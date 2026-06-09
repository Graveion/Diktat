// ─── Agent contracts — single source of truth ───────────────────────────────
//
// Every agentic CLI Diktat can drive is described here. This file is the
// authoritative list of "what's available":
//
//   • cli-detector.ts derives KNOWN_CLIS from it (detection is driven by this).
//   • session.ts `buildArgs()` owns the exact argv per CLI (it needs runtime
//     conditionals the table can't express) but MUST stay consistent with the
//     `invocation` recorded here — treat this file as the contract it implements.
//   • The app mirrors `displayName` in src/screens/SessionsScreen.tsx (separate
//     RN package, can't import this module).
//
// When adding a CLI: add a contract entry here first, then implement its argv
// in buildArgs and (when known) its output parser. See AGENT-SUPPORT.md for the
// adapter-registry refactor that will eventually fold buildArgs/parse in too.

/** How the user's prompt text is passed to the CLI. */
export type PromptStyle =
  | "flag:-p"        // `<bin> -p "<prompt>"`
  | "positional";    // `<bin> [subcommand] "<prompt>"`

/** How a follow-up turn continues the same conversation. */
export type ResumeStyle =
  | { kind: "none" }                              // stateless; each turn is fresh
  | { kind: "owned-uuid"; flag: string }          // we mint + pass the id (Copilot)
  | { kind: "server-id"; flag: string }           // capture id from output, pass it back (Claude/Cursor)
  | { kind: "resume-dir"; flag: string };         // most-recent conversation in cwd (Kiro)

/** What the daemon currently parses from the CLI's stdout. */
export type OutputFormat = "stream-json" | "text";

export interface AgentContract {
  id: string;                 // internal key + value of session `cli`
  displayName: string;        // shown in the app
  binary: string;             // `which` target
  subcommand: string | null;  // non-interactive subcommand, if any (e.g. chat/exec)
  prompt: PromptStyle;
  /** Flags that let the agent run tools headlessly without prompting. */
  trustFlags: string[];
  /** Other always-on flags for a non-interactive run. */
  extraFlags: string[];
  output: OutputFormat;
  /** True → rich tool_use/tool_result previews; false → plain text passthrough. */
  structuredEvents: boolean;
  /** Forward stdout through the ANSI stripper before sending to the app. */
  stripAnsi: boolean;
  resume: ResumeStyle;
  /** Optional ordered modes (e.g. Cursor: agent/plan/ask). */
  modes?: string[];
  /** Auth: how `diktat setup` checks it, and how the user logs in. */
  login: { check: string; command: string };
  notes?: string;
}

export const AGENT_CONTRACTS: Record<string, AgentContract> = {
  claude: {
    id: "claude",
    displayName: "Claude Code",
    binary: "claude",
    subcommand: null,
    prompt: "flag:-p",
    trustFlags: [],
    extraFlags: ["--output-format", "stream-json", "--verbose"],
    output: "stream-json",
    structuredEvents: true,
    stripAnsi: false,
    resume: { kind: "server-id", flag: "--resume" },
    login: { check: "claude -p hi (stderr)", command: "claude login" },
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    binary: "agent", // the standalone `agent` binary
    subcommand: null,
    prompt: "flag:-p",
    trustFlags: ["--trust"],
    extraFlags: ["--output-format", "stream-json", "--stream-partial-output"],
    output: "stream-json",
    structuredEvents: true,
    stripAnsi: false,
    resume: { kind: "server-id", flag: "--resume=" }, // note: `=` form
    modes: ["agent", "plan", "ask"],
    login: { check: "IDE-managed", command: "(sign in via the Cursor app)" },
  },
  copilot: {
    id: "copilot",
    displayName: "GitHub Copilot",
    binary: "copilot",
    subcommand: null,
    prompt: "flag:-p",
    trustFlags: ["--allow-all-tools"],
    extraFlags: ["--silent", "--no-color"],
    output: "text",
    structuredEvents: false, // JSONL via --output-format json — parser TODO
    stripAnsi: false,
    resume: { kind: "owned-uuid", flag: "--session-id" },
    login: { check: "copilot -p hi (stderr)", command: "copilot login (or GITHUB_TOKEN)" },
    notes: "We own the session UUID via --session-id (sets new / resumes).",
  },
  kiro: {
    id: "kiro",
    displayName: "Kiro",
    binary: "kiro-cli",
    subcommand: "chat",
    prompt: "positional",
    trustFlags: ["--trust-all-tools"],
    extraFlags: ["--no-interactive"],
    output: "text",
    structuredEvents: false, // chat has no JSON event stream (-f json is list-only)
    stripAnsi: true,
    resume: { kind: "resume-dir", flag: "--resume" },
    login: { check: "kiro-cli whoami", command: "kiro-cli login" },
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    binary: "codex",
    subcommand: "exec",
    prompt: "positional",
    // Autonomous but sandboxed: run without prompting, allow workspace writes.
    // (The nuclear option is --dangerously-bypass-approvals-and-sandbox.)
    trustFlags: ["--ask-for-approval", "never", "--sandbox", "workspace-write"],
    extraFlags: [],
    output: "text",
    structuredEvents: false, // `codex exec --json` JSONL — parser TODO
    stripAnsi: true,
    resume: { kind: "none" }, // v1 stateless; codex exec resume / --json TODO
    login: { check: "~/.codex/auth.json or OPENAI_API_KEY", command: "codex login" },
    notes: "Non-interactive via `codex exec`. Multi-turn resume not wired yet.",
  },
};

/** name → `which` target. Detection (cli-detector) is driven by this. */
export const KNOWN_CLIS: Record<string, string> = Object.fromEntries(
  Object.values(AGENT_CONTRACTS).map((a) => [a.id, a.binary]),
);
