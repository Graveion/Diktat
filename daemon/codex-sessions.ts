// ─── Codex CLI session reader ────────────────────────────────────────────────
//
// Codex writes one rollout JSONL per conversation under
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl. The line/item schema is
// source-verified in codex-rollout.ts. We read the JSONL directly (the
// state_*.sqlite `threads` table is only an index over these files, so we don't
// need it). Listing + history mirror claude-sessions.ts / cursor-sessions.ts.
//
// Verified from the rollout schema: message text, tool calls (function_call) and
// their outputs (function_call_output), and the call_id linkage. NOT in the
// schema: the *contents* of a tool call's `arguments` JSON (it's an opaque
// string), so tool-argument previews are best-effort and refine when we get a
// real authed sample. The conversation text is exact.

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { HistoryMessage } from "./claude-sessions";
import { toolDisplayName } from "./claude-sessions";
import { buildToolUsePreview, buildToolResultPreview } from "./tool-preview";
import { readHead, readTail } from "./file-read";
import type { RolloutLine, ContentItem, FunctionCallOutput } from "./codex-rollout";

export const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

export interface CodexSession {
  id: string;
  project: string;
  projectLabel: string;
  firstMessage: string;
  lastActiveAt: string;
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

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

/** Concatenate the text of a message's content blocks (input_text / output_text). */
function messageText(content: ContentItem[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "input_text" | "output_text"; text: string } =>
      !!c && (c.type === "input_text" || c.type === "output_text") && typeof (c as any).text === "string")
    .map((c) => c.text)
    .join("");
}

/** function_call_output.output is a bare string OR an array of content items. */
function outputToText(output: FunctionCallOutput | undefined): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .filter((b: any) => b && b.type === "input_text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

// Best-effort canonicalization of Codex tool names → our display tools. The
// rollout doesn't pin argument shapes, so this is heuristic (refine with a
// real sample). Names not listed pass through unchanged.
const CODEX_TOOL_CANONICAL: Record<string, string> = {
  shell: "Bash",
  local_shell: "Bash",
  bash: "Bash",
  exec: "Bash",
  apply_patch: "Edit",
  read_file: "Read",
  write_file: "Write",
};

/** Map a Codex function_call (name + JSON-string arguments) to {name, input}. */
function codexToolInput(rawName: string, argsJson: string | undefined): { name: string; input: any } {
  let args: any = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    args = {};
  }
  const name = CODEX_TOOL_CANONICAL[rawName] ?? rawName;
  // shell/exec: `command` is usually an array (["bash","-lc","…"]); flatten it.
  if (args && args.command !== undefined) {
    const cmd = Array.isArray(args.command) ? args.command.join(" ") : String(args.command);
    return { name: CODEX_TOOL_CANONICAL[rawName] ?? "Bash", input: { command: cmd } };
  }
  return { name, input: args };
}

/**
 * Parse a Codex rollout JSONL (raw text) into normalized history messages.
 * Exported separately from disk access so it's unit-testable with synthetic
 * rollout lines built straight from the verified codex-rollout.ts schema.
 */
export function parseCodexRollout(raw: string, limit = 20): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  const toolIndexById = new Map<string, number>();

  for (const line of raw.split("\n").filter(Boolean)) {
    let parsed: RolloutLine;
    try {
      parsed = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }
    if (parsed.type !== "response_item") continue;
    // The ResponseItem union has an open catch-all variant (unknown type tags),
    // which defeats TS discrimination — access fields dynamically. Shapes are
    // documented in codex-rollout.ts.
    const item = parsed.payload as any;

    switch (item.type) {
      case "message": {
        const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
        if (!role) continue; // skip system/other
        const text = messageText(item.content);
        if (text.trim()) messages.push({ role, text });
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const rawArgs = item.type === "function_call" ? item.arguments : item.input;
        const { name, input } = codexToolInput(item.name, rawArgs);
        const preview = buildToolUsePreview(name, input);
        messages.push({
          role: "tool",
          text: "",
          toolName: toolDisplayName(name, input),
          toolPath: pickToolPath(input),
          toolId: item.call_id,
          toolDiff: preview.diff,
          toolPreview: preview.preview,
          toolCommand: preview.command,
          toolTruncated: preview.truncated,
          toolFullSize: preview.fullSize,
        });
        if (item.call_id) toolIndexById.set(item.call_id, messages.length - 1);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const idx = toolIndexById.get(item.call_id);
        if (idx === undefined) continue;
        const text = outputToText(item.output);
        const result = buildToolResultPreview(text);
        if (!result) continue;
        const msg = messages[idx];
        if (msg) {
          msg.toolResult = result.preview;
          msg.toolResultTruncated = result.truncated;
          if (!msg.toolFullSize) msg.toolFullSize = result.fullSize;
        }
        break;
      }
      // reasoning / local_shell_call / web_search_call etc. are skipped in v1.
      default:
        break;
    }
  }

  return messages.slice(-limit);
}

/** Recursively collect rollout-*.jsonl paths with their mtime (depth-guarded). */
function collectRolloutFiles(dir: string, depth = 0, acc: { path: string; mtimeMs: number }[] = []): { path: string; mtimeMs: number }[] {
  if (depth > 5) return acc;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectRolloutFiles(full, depth + 1, acc);
    } else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
      acc.push({ path: full, mtimeMs: st.mtimeMs });
    }
  }
  return acc;
}

/** Read just enough of a rollout to extract {id, cwd, firstUserMessage}. */
function readRolloutMeta(filePath: string): { id: string | null; cwd: string | null; firstMessage: string } {
  const head = readHead(filePath);
  let id: string | null = null;
  let cwd: string | null = null;
  let firstMessage = "";
  for (const line of head.split("\n").filter(Boolean)) {
    let parsed: RolloutLine;
    try {
      parsed = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }
    if (parsed.type === "session_meta") {
      id = parsed.payload.id ?? id;
      cwd = parsed.payload.cwd ?? cwd;
    } else if (parsed.type === "response_item") {
      const item = parsed.payload as any;
      if (!firstMessage && item.type === "message" && item.role === "user") {
        firstMessage = messageText(item.content).slice(0, 120);
      }
    }
    if (id && cwd && firstMessage) break;
  }
  return { id, cwd, firstMessage };
}

export function listCodexSessions(sessionsDir = CODEX_SESSIONS_DIR): CodexSession[] {
  if (!existsSync(sessionsDir)) return [];
  // Sort by mtime first; only read the head of the 50 most-recent files.
  const files = collectRolloutFiles(sessionsDir).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 50);

  const sessions: CodexSession[] = [];
  const seen = new Set<string>();
  for (const { path, mtimeMs } of files) {
    const base = path.split("/").pop() ?? path;
    const meta = readRolloutMeta(path);
    const id = meta.id ?? base.match(UUID_RE)?.[0] ?? null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const project = meta.cwd ?? homedir();
    sessions.push({
      id,
      project,
      projectLabel: projectLabel(project),
      firstMessage: meta.firstMessage,
      lastActiveAt: new Date(mtimeMs).toISOString(),
    });
  }
  return sessions;
}

/** Locate a rollout file by session id (the uuid embedded in its filename). */
export function findCodexRollout(sessionId: string, sessionsDir = CODEX_SESSIONS_DIR): string | null {
  if (!existsSync(sessionsDir)) return null;
  for (const { path } of collectRolloutFiles(sessionsDir)) {
    const base = path.split("/").pop() ?? "";
    if (base.includes(sessionId)) return path;
  }
  return null;
}

export function readCodexHistory(sessionId: string, limit = 20, sessionsDir = CODEX_SESSIONS_DIR): HistoryMessage[] {
  const filePath = findCodexRollout(sessionId, sessionsDir);
  if (!filePath) return [];
  return parseCodexRollout(readTail(filePath), limit);
}

export function codexSessionExists(sessionId: string, sessionsDir = CODEX_SESSIONS_DIR): boolean {
  return findCodexRollout(sessionId, sessionsDir) !== null;
}
