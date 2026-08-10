// ─── Codex CLI rollout JSONL — schema ────────────────────────────────────────
//
// Source of truth: derived from the openai/codex Rust source (serde attributes
// ARE the wire contract), not a captured sample:
//   • Line wrapper:   codex-rs/rollout/src/recorder.rs  (RolloutLineRef)
//   • Line variants:  codex-rs/protocol/src/protocol.rs (RolloutItem, SessionMeta,
//                     SessionMetaLine, TurnContextItem, CompactedItem, EventMsg)
//   • Response items: codex-rs/protocol/src/models.rs   (ResponseItem, ContentItem,
//                     FunctionCallOutputPayload)
//
// On disk: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl — one JSON
// object per line. The SQLite `state_*.sqlite` `threads` table indexes these
// files (threads.rollout_path → the JSONL); see agents.ts `history`.
//
// Parsed by codex-sessions.ts (parseCodexRollout / readCodexHistory). Gotchas:
//   • The OUTER line `type` and the response_item payload's OWN nested `type`
//     are different discriminators — don't conflate them.
//   • function_call_output.output serializes as a BARE string or array (its
//     {body,success} struct has a custom Serialize), never a {body,success} obj.
//   • Assistant text = content[].type === "output_text"; user text = "input_text".
//   • Unknown response-item `type`s must be tolerated (Rust maps them to Other).

// ── Top-level line wrapper ───────────────────────────────────────────────────
// RolloutItem is internally tagged (tag="type", content="payload"); the recorder
// flattens it next to `timestamp`.
export type RolloutLine =
  | { timestamp: string; type: "session_meta"; payload: SessionMetaLine }
  | { timestamp: string; type: "response_item"; payload: ResponseItem }
  | { timestamp: string; type: "compacted"; payload: CompactedItem }
  | { timestamp: string; type: "turn_context"; payload: TurnContextItem }
  | { timestamp: string; type: "event_msg"; payload: EventMsg };

/** Live UI/stream events; many variants, each tag="type" snake_case. Opaque here. */
export type EventMsg = { type: string; [k: string]: unknown };

// ── session_meta (SessionMetaLine flattens SessionMeta + adds `git`) ─────────
export interface GitInfo {
  commit_hash?: string; // GitSha serializes as a string
  branch?: string;
  repository_url?: string;
}

export interface SessionMetaLine {
  id: string; // ThreadId
  forked_from_id?: string;
  parent_thread_id?: string;
  timestamp: string;
  cwd: string;
  originator: string;
  cli_version: string;
  source?: unknown; // SessionSource
  thread_source?: unknown;
  agent_nickname?: string;
  agent_role?: string; // read-alias: "agent_type"
  agent_path?: string;
  model_provider: string | null;
  base_instructions: unknown | null; // BaseInstructions (not a plain string)
  dynamic_tools?: unknown[];
  memory_mode?: string;
  multi_agent_version?: unknown;
  git?: GitInfo;
}

// ── response_item (payload has its OWN nested tag="type", snake_case) ─────────
export type ContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string }
  | { type: "output_text"; text: string };

// function_call_output.output: bare string OR array of these items.
export type FunctionCallOutputContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string }
  | { type: "encrypted_content"; encrypted_content: string };
export type FunctionCallOutput = string | FunctionCallOutputContentItem[];

export type ReasoningSummary = { type: "summary_text"; text: string };
export type ReasoningContent =
  | { type: "reasoning_text"; text: string }
  | { type: "text"; text: string };

export type ResponseItem =
  | { type: "message"; role: string; content: ContentItem[]; phase?: unknown } // id not serialized
  | { type: "reasoning"; summary: ReasoningSummary[]; content?: ReasoningContent[]; encrypted_content: string | null }
  | { type: "function_call"; name: string; namespace?: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: FunctionCallOutput }
  | { type: "custom_tool_call"; status?: string; call_id: string; name: string; input: string }
  | { type: "custom_tool_call_output"; call_id: string; name?: string; output: FunctionCallOutput }
  | { type: "local_shell_call"; call_id: string | null; status: unknown; action: unknown }
  | { type: "web_search_call"; status?: string; action?: unknown }
  // also: agent_message, tool_search_call, tool_search_output, image_generation_call,
  //       compaction, compaction_trigger, context_compaction
  | { type: string; [k: string]: unknown }; // ResponseItem::Other catch-all

// ── turn_context ─────────────────────────────────────────────────────────────
export interface TurnContextItem {
  turn_id?: string;
  cwd: string;
  workspace_roots?: string[];
  current_date?: string;
  timezone?: string;
  approval_policy: unknown; // AskForApproval
  sandbox_policy: unknown; // SandboxPolicy
  permission_profile?: unknown;
  network?: unknown;
  // + file_system_sandbox_policy and possibly more (source view was truncated)
}

// ── compacted ────────────────────────────────────────────────────────────────
export interface CompactedItem {
  message: string;
  replacement_history?: ResponseItem[];
}
