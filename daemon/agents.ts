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

/**
 * Where/how an agent persists past conversations on disk, so we can list
 * sessions and replay history. Across the ecosystem the *content* almost
 * always lives in per-session JSONL; a SQLite DB, when present, is usually an
 * index over those files (e.g. Codex `threads.rollout_path`) rather than the
 * content store. Desktop apps are the exception — they bury content inside the
 * DB itself. `reader` flags whether the daemon actually implements this yet.
 */
export type HistorySource =
  | { kind: "none"; reader: false; notes?: string }
  | {
      // Content in per-session JSONL files we scan directly (Claude, Cursor CLI).
      kind: "jsonl-dir";
      reader: boolean;
      location: string;     // human-readable glob of the content files
      recordSchema: string; // shape of each JSONL line
      notes?: string;
    }
  | {
      // Content in JSONL, but listing/preview/cwd come from a SQLite index
      // that points at each file (Codex CLI: state_*.sqlite → rollout-*.jsonl).
      kind: "jsonl-indexed-by-sqlite";
      reader: boolean;
      location: string;
      recordSchema: string;
      index: {
        db: string;            // glob of the SQLite index
        table: string;
        idCol: string;
        pathCol: string;       // column holding the JSONL path
        previewCol?: string;
        cwdCol?: string;
      };
      notes?: string;
    }
  | {
      // Content lives *inside* a SQLite DB rather than JSONL — GitHub Copilot
      // (~/.copilot/session-store.db), Kiro (Amazon Q's data.sqlite3), and the
      // desktop apps (Cursor state.vscdb, Codex orbit.db).
      kind: "sqlite-blob";
      reader: boolean;
      db: string;
      notes?: string;
    };

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
  /** Where past conversations live on disk + whether we read them yet. */
  history: HistorySource;
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
    history: {
      kind: "jsonl-dir",
      reader: true, // claude-sessions.ts
      location: "~/.claude/projects/<encoded-cwd>/<session-id>.jsonl",
      recordSchema: "anthropic-messages (type:user|assistant, message.content blocks)",
    },
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
    history: {
      kind: "jsonl-dir",
      reader: true, // cursor-sessions.ts
      location: "~/.cursor/projects/<encoded-cwd>/agent-transcripts/<id>/<id>.jsonl",
      recordSchema: "role:user|assistant with content blocks (Anthropic-like; <user_query> wrappers)",
      notes: "The Cursor *desktop* app stores chats in a separate sqlite-blob (~/Library/Application Support/Cursor/**/state.vscdb, ItemTable) — not read here.",
    },
    modes: ["ask", "plan"],
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
    history: {
      kind: "sqlite-blob",
      reader: true, // copilot-sessions.ts (bun:sqlite)
      db: "~/.copilot/session-store.db",
      notes:
        "Content lives IN the DB (not JSONL). Verified schema: sessions(id,cwd,repository,branch,summary,created_at,updated_at); turns(session_id,turn_index,user_message,assistant_response,timestamp); forge_trajectory_events(session_id,tool_call_id,turn_index,event_type,command,output,exit_code,event_key,event_value) for tool calls; session_files(session_id,file_path,tool_name,turn_index); checkpoints(...) summaries; search_index* FTS. Reader = list from `sessions`, history from `turns` ORDER BY turn_index, tool cards from forge_trajectory_events. (Aux per-session dir at ~/.copilot/session-state/<id>/ holds workspace.yaml/checkpoints/files, not the transcript.)",
    },
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
    history: {
      kind: "sqlite-blob",
      reader: true, // kiro-sessions.ts (bun:sqlite); tolerates missing table
      db: "~/Library/Application Support/kiro-cli/data.sqlite3",
      notes:
        "Kiro CLI == Amazon Q Developer CLI rebranded (open source: github.com/aws/amazon-q-developer-cli). Conversations live in a `conversations(key,value)` table (migration 007) keyed by the absolute cwd; value = serde_json of ConversationState. Full source-verified value schema in kiro-conversation.ts (externally-tagged enums: user content {Prompt|ToolUseResults}, assistant {Response|ToolUse}). NB the `conversations` table may be absent until a chat persists one (the build here had only state/history/auth_kv) — a reader must tolerate 'no such table' (kiro-sessions.ts does).",
    },
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
    history: {
      kind: "jsonl-indexed-by-sqlite",
      reader: true, // codex-sessions.ts (parseCodexRollout / listCodexSessions)
      location: "~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl",
      recordSchema: "per-line {timestamp,type,payload}; type=session_meta|response_item|compacted|turn_context|event_msg. response_item payload carries its OWN nested type (message/function_call/function_call_output/reasoning/...). Full typed schema in codex-rollout.ts (derived from openai/codex Rust serde).",
      index: {
        db: "~/.codex/state_*.sqlite",
        table: "threads",
        idCol: "id",
        pathCol: "rollout_path",
        previewCol: "preview",
        cwdCol: "cwd",
      },
      notes: "The SQLite DB is an index, not the content store — `rollout_path` points at the JSONL; we read the JSONL directly (no DB dependency). Codex *desktop* (orbit.db) is a separate sqlite-blob store, not covered here. Conversation text + tool calls/results are exact; tool-argument previews are best-effort (the `arguments` JSON shape isn't in the schema) until an authed sample lands.",
    },
    login: { check: "~/.codex/auth.json or OPENAI_API_KEY", command: "codex login" },
    notes: "Non-interactive via `codex exec`. Multi-turn resume not wired yet.",
  },
};

/** name → `which` target. Detection (cli-detector) is driven by this. */
export const KNOWN_CLIS: Record<string, string> = Object.fromEntries(
  Object.values(AGENT_CONTRACTS).map((a) => [a.id, a.binary]),
);

// ─── Model + permission selection (drives the app's dropdowns) ───────────────
//
// Every supported CLI takes a `--model` flag and exposes permissions as flags,
// so we surface two dropdowns. Their options live here (single source of truth)
// and ship to the app in the `connected` payload via agentSelectionData().

export interface AgentModel {
  id: string; // "" → use the CLI's own default (we omit --model)
  label: string;
}

/** Normalized, CLI-agnostic permission tiers (mapped to real flags below). */
export type PermissionModeId = "plan" | "auto" | "full";
export interface PermissionMode {
  id: PermissionModeId;
  label: string;
}
export const PERMISSION_MODES: PermissionMode[] = [
  { id: "plan", label: "Plan · read-only" },
  { id: "auto", label: "Auto-accept edits" },
  { id: "full", label: "Full access" },
];
export const DEFAULT_PERMISSION_MODE: PermissionModeId = "auto";

// Curated model lists. ids drift per CLI version — edit here. "" = CLI default
// (always safe). Claude aliases are stable; others kept minimal on purpose.
export const AGENT_MODELS: Record<string, AgentModel[]> = {
  claude: [
    { id: "", label: "Default" },
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
    { id: "haiku", label: "Haiku" },
  ],
  cursor: [
    { id: "", label: "Default" },
    { id: "auto", label: "Auto" },
  ],
  copilot: [
    { id: "", label: "Default" },
    { id: "auto", label: "Auto" },
  ],
  kiro: [{ id: "", label: "Default" }],
  codex: [{ id: "", label: "Default" }],
};

/** `--model` flags for a chosen model id ("" / undefined → none). */
export function modelFlags(modelId: string | undefined): string[] {
  return modelId ? ["--model", modelId] : [];
}

/**
 * Map a normalized permission tier → the chosen CLI's real flags. These are the
 * verified per-CLI flags (see each CLI's --help). Tiers:
 *   plan = read/plan only, no edits · auto = edits allowed · full = unrestricted.
 */
export function permissionFlags(cli: string, mode: PermissionModeId): string[] {
  switch (cli) {
    case "claude":
      return ["--permission-mode", mode === "plan" ? "plan" : mode === "auto" ? "acceptEdits" : "bypassPermissions"];
    case "cursor":
      // --trust lets it run shell; plan stays read-only via --mode plan.
      // "agent" is not a valid --mode value; "ask" is the most permissive valid mode.
      return mode === "plan" ? ["--mode", "plan"] : ["--trust", "--mode", "ask"];
    case "copilot":
      // Headless can't prompt; plan = no auto-grant (limited), else allow all.
      return mode === "plan" ? [] : ["--allow-all-tools"];
    case "kiro":
      return mode === "plan" ? ["--trust-tools="] : ["--trust-all-tools"];
    case "codex":
      if (mode === "plan") return ["--ask-for-approval", "never", "--sandbox", "read-only"];
      if (mode === "auto") return ["--ask-for-approval", "never", "--sandbox", "workspace-write"];
      return ["--dangerously-bypass-approvals-and-sandbox"];
    default:
      return [];
  }
}

/** Per-CLI selection options for the app's dropdowns (shipped in `connected`). */
export function agentSelectionData(): Record<string, { displayName: string; models: AgentModel[]; permissionModes: PermissionMode[] }> {
  return Object.fromEntries(
    Object.values(AGENT_CONTRACTS).map((a) => [
      a.id,
      { displayName: a.displayName, models: AGENT_MODELS[a.id] ?? [{ id: "", label: "Default" }], permissionModes: PERMISSION_MODES },
    ]),
  );
}
