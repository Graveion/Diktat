// ─── Kiro CLI (Amazon Q) session reader ──────────────────────────────────────
//
// Kiro CLI == Amazon Q Developer CLI rebranded. Conversations live in
// ~/Library/Application Support/kiro-cli/data.sqlite3, table
// conversations(key, value) where key = absolute cwd and value = serde_json of
// ConversationState. Full value schema (externally-tagged enums) is in
// kiro-conversation.ts. The `conversations` table may be ABSENT until a chat
// persists one — every query tolerates that.

import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Database } from "bun:sqlite";
import type { HistoryMessage } from "./claude-sessions";
import { toolDisplayName } from "./claude-sessions";
import { buildToolUsePreview, buildToolResultPreview } from "./tool-preview";
import type { StoredConversation, HistoryEntry, ToolUseResultBlock } from "./kiro-conversation";

export const KIRO_DB_PATH = join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3");

export interface KiroSession {
  id: string; // conversation_id
  project: string; // the cwd key
  projectLabel: string;
  firstMessage: string;
  lastActiveAt: string;
}

function projectLabel(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
}

function pickToolPath(input: any): string | undefined {
  if (!input) return undefined;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  return undefined;
}

function openDb(dbPath: string): Database | null {
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

/** SELECT key,value FROM conversations — [] if the table doesn't exist yet. */
function readConversationRows(db: Database): { key: string; value: string }[] {
  try {
    return db.query("SELECT key, value FROM conversations").all() as { key: string; value: string }[];
  } catch {
    return []; // "no such table: conversations"
  }
}

// Best-effort map of Amazon Q tool names → our display tools (refine w/ sample).
const KIRO_TOOL_CANONICAL: Record<string, string> = {
  execute_bash: "Bash",
  fs_read: "Read",
  fs_write: "Write",
  use_aws: "Bash",
};

/** Map a Kiro tool_use (name + args JSON) to {name, input} for previews. */
function kiroToolInput(rawName: string, args: any): { name: string; input: any } {
  const a = args && typeof args === "object" ? args : {};
  const canonical = KIRO_TOOL_CANONICAL[rawName] ?? rawName;
  if (rawName === "execute_bash" || rawName === "use_aws") {
    const cmd = typeof a.command === "string" ? a.command : Array.isArray(a.command) ? a.command.join(" ") : "";
    return { name: "Bash", input: { command: cmd } };
  }
  if (rawName === "fs_read") {
    return { name: "Read", input: { file_path: a.path ?? a.file_path } };
  }
  if (rawName === "fs_write") {
    // str_replace → Edit (old/new); create/append with file_text → Write.
    if (typeof a.old_str === "string" || typeof a.new_str === "string") {
      return { name: "Edit", input: { file_path: a.path ?? a.file_path, old_string: a.old_str, new_string: a.new_str } };
    }
    return { name: "Write", input: { file_path: a.path ?? a.file_path, content: a.file_text ?? a.content } };
  }
  return { name: canonical, input: a };
}

/** Tool result blocks → a single text string. */
function resultBlocksToText(blocks: ToolUseResultBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => ("Text" in b ? b.Text : "Json" in b ? JSON.stringify(b.Json) : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Parse a stored ConversationState (object or JSON string) into normalized
 * history messages. Pure → unit-testable without a DB.
 */
export function parseKiroConversation(value: string | StoredConversation, limit = 20): HistoryMessage[] {
  let conv: StoredConversation;
  try {
    conv = typeof value === "string" ? (JSON.parse(value) as StoredConversation) : value;
  } catch {
    return [];
  }
  const history: HistoryEntry[] = Array.isArray(conv?.history) ? conv.history : [];

  const messages: HistoryMessage[] = [];
  const toolIndexById = new Map<string, number>();

  for (const entry of history) {
    // ── user side ──
    const uc: any = entry?.user?.content;
    if (uc?.Prompt && typeof uc.Prompt.prompt === "string") {
      if (uc.Prompt.prompt.trim()) messages.push({ role: "user", text: uc.Prompt.prompt });
    } else {
      // ToolUseResults / CancelledToolUses → attach to prior tool cards.
      const results = uc?.ToolUseResults?.tool_use_results ?? uc?.CancelledToolUses?.tool_use_results ?? [];
      for (const r of results) {
        const idx = toolIndexById.get(r?.tool_use_id);
        if (idx === undefined) continue;
        const text = resultBlocksToText(r?.content);
        const result = text ? buildToolResultPreview(text) : null;
        if (!result) continue;
        const msg = messages[idx];
        if (msg) {
          msg.toolResult = result.preview;
          msg.toolResultTruncated = result.truncated;
          if (!msg.toolFullSize) msg.toolFullSize = result.fullSize;
        }
      }
    }

    // ── assistant side ──
    const a: any = entry?.assistant;
    if (a?.Response && typeof a.Response.content === "string") {
      if (a.Response.content.trim()) messages.push({ role: "assistant", text: a.Response.content });
    } else if (a?.ToolUse) {
      if (typeof a.ToolUse.content === "string" && a.ToolUse.content.trim()) {
        messages.push({ role: "assistant", text: a.ToolUse.content });
      }
      for (const tu of a.ToolUse.tool_uses ?? []) {
        const rawName = tu?.orig_name || tu?.name || "tool";
        const { name, input } = kiroToolInput(rawName, tu?.args);
        const preview = buildToolUsePreview(name, input);
        messages.push({
          role: "tool",
          text: "",
          toolName: toolDisplayName(name, input),
          toolPath: pickToolPath(input),
          toolId: tu?.id,
          toolDiff: preview.diff,
          toolPreview: preview.preview,
          toolCommand: preview.command,
          toolTruncated: preview.truncated,
          toolFullSize: preview.fullSize,
        });
        if (tu?.id) toolIndexById.set(tu.id, messages.length - 1);
      }
    }
  }

  return messages.slice(-limit);
}

/** Latest user-message timestamp in a conversation, for sorting. */
function latestTimestamp(conv: StoredConversation): string {
  let latest = "";
  for (const entry of conv?.history ?? []) {
    const ts = entry?.user?.timestamp;
    if (typeof ts === "string" && ts > latest) latest = ts;
  }
  return latest;
}

function firstPrompt(conv: StoredConversation): string {
  for (const entry of conv?.history ?? []) {
    const uc: any = entry?.user?.content;
    if (uc?.Prompt && typeof uc.Prompt.prompt === "string" && uc.Prompt.prompt.trim()) {
      return uc.Prompt.prompt.slice(0, 120);
    }
  }
  return "";
}

export function listKiroSessions(dbPath = KIRO_DB_PATH): KiroSession[] {
  const db = openDb(dbPath);
  if (!db) return [];
  try {
    const rows = readConversationRows(db);
    const sessions: KiroSession[] = [];
    for (const { key, value } of rows) {
      let conv: StoredConversation;
      try {
        conv = JSON.parse(value) as StoredConversation;
      } catch {
        continue;
      }
      const id = conv?.conversation_id;
      if (!id) continue;
      sessions.push({
        id,
        project: key,
        projectLabel: projectLabel(key),
        firstMessage: firstPrompt(conv),
        lastActiveAt: latestTimestamp(conv),
      });
    }
    return sessions.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)).slice(0, 50);
  } finally {
    db.close();
  }
}

export function readKiroHistory(sessionId: string, limit = 20, dbPath = KIRO_DB_PATH): HistoryMessage[] {
  const db = openDb(dbPath);
  if (!db) return [];
  try {
    for (const { value } of readConversationRows(db)) {
      try {
        const conv = JSON.parse(value) as StoredConversation;
        if (conv?.conversation_id === sessionId) return parseKiroConversation(conv, limit);
      } catch {
        // skip malformed row
      }
    }
    return [];
  } finally {
    db.close();
  }
}

export function kiroSessionExists(sessionId: string, dbPath = KIRO_DB_PATH): boolean {
  const db = openDb(dbPath);
  if (!db) return false;
  try {
    for (const { value } of readConversationRows(db)) {
      try {
        if ((JSON.parse(value) as StoredConversation)?.conversation_id === sessionId) return true;
      } catch { /* skip */ }
    }
    return false;
  } finally {
    db.close();
  }
}
