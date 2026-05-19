import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { HistoryMessage } from "./claude-sessions";

const CURSOR_PROJECTS_DIR = join(homedir(), ".cursor", "projects");

export interface CursorSession {
  id: string;
  project: string;
  projectLabel: string;
  firstMessage: string;
  lastActiveAt: string;
}

function decodeProjectPath(slug: string): string {
  // Cursor slug: 'Users-timothygreen-Documents-Pacer' -> '/Users/timothygreen/Documents/Pacer'
  return "/" + slug.replace(/-/g, "/");
}

function projectLabel(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
}

function readFirstUserMessage(filePath: string): string {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      const json = JSON.parse(line);
      if (json.role === "user" || json.type === "user") {
        return typeof json.content === "string" ? json.content : json.message ?? "";
      }
    }
    return "";
  } catch {
    return "";
  }
}

export function listCursorSessions(): CursorSession[] {
  const sessions: CursorSession[] = [];

  try {
    const projectDirs = readdirSync(CURSOR_PROJECTS_DIR);
    for (const dir of projectDirs) {
      const transcriptsDir = join(CURSOR_PROJECTS_DIR, dir, "agent-transcripts");
      if (!existsSync(transcriptsDir)) continue;

      const project = decodeProjectPath(dir);
      const label = projectLabel(project);

      const sessionDirs = readdirSync(transcriptsDir);
      for (const sessionId of sessionDirs) {
        const filePath = join(transcriptsDir, sessionId, `${sessionId}.jsonl`);
        if (!existsSync(filePath)) continue;

        const stat = statSync(filePath);
        sessions.push({
          id: sessionId,
          project,
          projectLabel: label,
          firstMessage: readFirstUserMessage(filePath),
          lastActiveAt: stat.mtime.toISOString(),
        });
      }
    }
  } catch {
    // ~/.cursor/projects doesn't exist
  }

  return sessions.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}

export function readCursorHistory(sessionId: string, limit = 20): HistoryMessage[] {
  try {
    const projectDirs = readdirSync(CURSOR_PROJECTS_DIR);
    for (const dir of projectDirs) {
      const filePath = join(CURSOR_PROJECTS_DIR, dir, "agent-transcripts", sessionId, `${sessionId}.jsonl`);
      if (!existsSync(filePath)) continue;

      const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
      const messages: HistoryMessage[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const role = entry.role ?? entry.type;
          if (role !== "user" && role !== "assistant") continue;

          const text = typeof entry.content === "string"
            ? entry.content
            : Array.isArray(entry.content)
              ? entry.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
              : entry.message ?? "";

          if (text) messages.push({ role, text });
        } catch {
          // skip malformed lines
        }
      }

      return messages.slice(-limit);
    }
  } catch {
    // not found
  }
  return [];
}
