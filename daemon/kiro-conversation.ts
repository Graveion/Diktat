// ─── Kiro CLI conversation store — schema (types only, no reader yet) ────────
//
// Kiro CLI is Amazon Q Developer CLI rebranded (open source:
// github.com/aws/amazon-q-developer-cli). Source of truth = its Rust serde defs:
//   • DB layer / table:  crates/chat-cli/src/database/mod.rs
//   • conversations tbl:  crates/chat-cli/src/database/sqlite_migrations/007_conversations_table.sql
//   • value struct:       crates/chat-cli/src/cli/chat/conversation.rs (ConversationState, HistoryEntry)
//   • message/tool types: crates/chat-cli/src/cli/chat/message.rs
//
// Storage: ~/Library/Application Support/kiro-cli/data.sqlite3, table
//   CREATE TABLE conversations (key TEXT PRIMARY KEY, value TEXT);
// The KEY is the raw absolute working-directory path (no prefix/hash); `--resume`
// looks up the cwd. The VALUE is serde_json of ConversationState. Read with:
//   SELECT value FROM conversations WHERE key = <abs cwd>;  then JSON.parse.
//
// ⚠️ Gotchas:
//   • The `conversations` table is created by migration 007 and may be ABSENT
//     until the build runs that migration / a first chat persists a convo
//     (the installed kiro DB observed here had only state/history/auth_kv). A
//     reader must tolerate "no such table".
//   • The enums are serde's DEFAULT externally-tagged form: the variant name is
//     a wrapping JSON key, e.g. content: { "Prompt": { "prompt": "…" } }.
//   • ToolResultStatus serializes as the bare strings "Error" / "Success".
//
// Parser status: NOT written yet (agents.ts kiro.history.reader === false).

export interface StoredConversation {
  conversation_id: string;
  next_message: UserMessage | null;
  history: HistoryEntry[]; // VecDeque → JSON array
  valid_history_range: [number, number]; // Rust tuple → 2-elem array
  transcript: string[];
  tools: Record<string, unknown[]>;
  context_manager: unknown | null;
  context_message_length: number | null;
  latest_summary: [string, unknown] | null;
  model?: string; // omitted when None
  model_info?: unknown; // omitted when None
  file_line_tracker: Record<string, unknown>;
  checkpoint_manager: unknown | null;
  mcp_enabled: boolean; // defaults true if absent
  tangent_state?: unknown;
  // tool_manager / agents are #[serde(skip)] → never present
}

export interface HistoryEntry {
  user: UserMessage;
  assistant: AssistantMessage;
  request_metadata?: unknown | null;
}

export interface UserMessage {
  additional_context: string;
  env_context: { env_state: unknown | null };
  content: UserMessageContent;
  timestamp: string | null; // RFC3339 DateTime<FixedOffset>
  images: unknown[] | null;
}

// Externally tagged — exactly one key present.
export type UserMessageContent =
  | { Prompt: { prompt: string } }
  | { CancelledToolUses: { prompt: string | null; tool_use_results: ToolUseResult[] } }
  | { ToolUseResults: { tool_use_results: ToolUseResult[] } };

// Externally tagged.
export type AssistantMessage =
  | { Response: { message_id: string | null; content: string } }
  | { ToolUse: { message_id: string | null; content: string; tool_uses: AssistantToolUse[] } };

export interface AssistantToolUse {
  id: string;
  name: string;
  orig_name: string;
  args: unknown; // arbitrary JSON
  orig_args: unknown;
}

export interface ToolUseResult {
  tool_use_id: string;
  content: ToolUseResultBlock[];
  status: "Error" | "Success";
}

// Externally tagged.
export type ToolUseResultBlock = { Json: unknown } | { Text: string };
