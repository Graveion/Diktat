// ─── GitHub Copilot CLI session reader ───────────────────────────────────────
//
// Copilot stores conversations IN a SQLite DB at ~/.copilot/session-store.db
// (verified schema — see agents.ts). Unlike Codex (DB = index over JSONL), the
// transcript content is in the DB itself, so we read it with bun:sqlite.
//
//   sessions(id, cwd, repository, branch, summary, created_at, updated_at)
//   turns(session_id, turn_index, user_message, assistant_response, timestamp)
//   forge_trajectory_events(session_id, tool_call_id, turn_index, event_type,
//                           command, output, exit_code, event_key, event_value)
//   session_files(session_id, file_path, tool_name, turn_index)
//
// Message text (user/assistant) is exact. Tool cards come from
// forge_trajectory_events rows that carry a `command` (mapped to a Bash-style
// card with its output/exit_code) — best-effort until we see authed sample rows.

import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Database } from "bun:sqlite";
import type { HistoryMessage } from "./claude-sessions";
import { buildToolUsePreview, buildToolResultPreview } from "./tool-preview";

export const COPILOT_DB_PATH = join(homedir(), ".copilot", "session-store.db");

export interface CopilotSession {
  id: string;
  project: string;
  projectLabel: string;
  firstMessage: string;
  lastActiveAt: string;
}

export interface CopilotTurnRow {
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
}

export interface CopilotTrajRow {
  turn_index: number | null;
  tool_call_id: string | null;
  event_type: string;
  command: string | null;
  output: string | null;
  exit_code: number | null;
}

function projectLabel(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
}

/** Open the DB read-only; null if missing/unreadable. Caller must close(). */
function openDb(dbPath: string): Database | null {
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

/**
 * Turn rows + trajectory (tool) rows → normalized history messages. Pure, so
 * it's unit-testable without a DB. Ordering per turn: user message, then any
 * tool cards (by turn_index), then the assistant response.
 */
export function rowsToHistory(turns: CopilotTurnRow[], events: CopilotTrajRow[], limit = 20): HistoryMessage[] {
  // Group tool events by turn_index (only rows that actually ran a command).
  const eventsByTurn = new Map<number, CopilotTrajRow[]>();
  for (const e of events) {
    if (e.turn_index == null || !e.command) continue;
    const arr = eventsByTurn.get(e.turn_index) ?? [];
    arr.push(e);
    eventsByTurn.set(e.turn_index, arr);
  }

  const messages: HistoryMessage[] = [];
  for (const turn of [...turns].sort((a, b) => a.turn_index - b.turn_index)) {
    if (turn.user_message && turn.user_message.trim()) {
      messages.push({ role: "user", text: turn.user_message });
    }
    for (const e of eventsByTurn.get(turn.turn_index) ?? []) {
      const preview = buildToolUsePreview("Bash", { command: e.command });
      const msg: HistoryMessage = {
        role: "tool",
        text: "",
        toolName: `Bash:${(e.command ?? "").slice(0, 35)}`,
        toolId: e.tool_call_id ?? undefined,
        toolCommand: preview.command,
        toolTruncated: preview.truncated,
        toolFullSize: preview.fullSize,
      };
      const resultText = e.output ?? (e.exit_code != null ? `exit ${e.exit_code}` : "");
      const result = resultText ? buildToolResultPreview(resultText) : null;
      if (result) {
        msg.toolResult = result.preview;
        msg.toolResultTruncated = result.truncated;
        if (!msg.toolFullSize) msg.toolFullSize = result.fullSize;
      }
      messages.push(msg);
    }
    if (turn.assistant_response && turn.assistant_response.trim()) {
      messages.push({ role: "assistant", text: turn.assistant_response });
    }
  }
  return messages.slice(-limit);
}

export function listCopilotSessions(dbPath = COPILOT_DB_PATH): CopilotSession[] {
  const db = openDb(dbPath);
  if (!db) return [];
  try {
    const rows = db
      .query("SELECT id, cwd, summary, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50")
      .all() as { id: string; cwd: string | null; summary: string | null; updated_at: string | null }[];
    const firstUserStmt = db.query("SELECT user_message FROM turns WHERE session_id = ? ORDER BY turn_index LIMIT 1");
    return rows.map((r) => {
      const project = r.cwd ?? homedir();
      let firstMessage = (r.summary ?? "").trim();
      if (!firstMessage) {
        const t = firstUserStmt.get(r.id) as { user_message: string | null } | null;
        firstMessage = (t?.user_message ?? "").slice(0, 120);
      }
      return {
        id: r.id,
        project,
        projectLabel: projectLabel(project),
        firstMessage: firstMessage.slice(0, 120),
        lastActiveAt: r.updated_at ?? "",
      };
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function readCopilotHistory(sessionId: string, limit = 20, dbPath = COPILOT_DB_PATH): HistoryMessage[] {
  const db = openDb(dbPath);
  if (!db) return [];
  try {
    const turns = db
      .query("SELECT turn_index, user_message, assistant_response FROM turns WHERE session_id = ? ORDER BY turn_index")
      .all(sessionId) as CopilotTurnRow[];
    let events: CopilotTrajRow[] = [];
    try {
      events = db
        .query("SELECT turn_index, tool_call_id, event_type, command, output, exit_code FROM forge_trajectory_events WHERE session_id = ? ORDER BY id")
        .all(sessionId) as CopilotTrajRow[];
    } catch {
      // forge_trajectory_events absent on older schema — text-only history.
    }
    return rowsToHistory(turns, events, limit);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function copilotSessionExists(sessionId: string, dbPath = COPILOT_DB_PATH): boolean {
  const db = openDb(dbPath);
  if (!db) return false;
  try {
    const row = db.query("SELECT 1 FROM sessions WHERE id = ? LIMIT 1").get(sessionId);
    return !!row;
  } catch {
    return false;
  } finally {
    db.close();
  }
}
