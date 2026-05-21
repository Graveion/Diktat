import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { HistoryMessage } from "./claude-sessions";
import { decodeCursorPath } from "./path-utils";

const CURSOR_PROJECTS_DIR = join(homedir(), ".cursor", "projects");

export interface CursorSession {
  id: string;
  project: string;
  projectLabel: string;
  firstMessage: string;
  lastActiveAt: string;
}

function projectLabel(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
}

function readFirstUserMessage(filePath: string): string {
  try {
    const buf = Buffer.alloc(4096);
    const fs = require("fs");
    const fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const chunk = buf.subarray(0, bytesRead).toString("utf-8");
    for (const line of chunk.split("\n").filter(Boolean)) {
      try {
        const json = JSON.parse(line);
        if (json.role === "user") {
          const content = json.message?.content ?? json.content ?? [];
          const text = Array.isArray(content)
            ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
            : typeof content === "string" ? content : "";
          if (text) {
            // Strip Cursor's <timestamp> and <user_query> wrapper tags
            const clean = text.replace(/<timestamp>[^<]*<\/timestamp>\s*/g, "")
              .replace(/<user_query>\s*/g, "").replace(/<\/user_query>/g, "").trim();
            return clean.slice(0, 120);
          }
        }
      } catch { /* incomplete line at chunk boundary */ }
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

      const project = decodeCursorPath(dir);
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

  const seen = new Set<string>();
  const unique = sessions.filter((s) => seen.has(s.id) ? false : (seen.add(s.id), true));
  return unique.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)).slice(0, 50);
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
          const role = entry.role;
          if (role !== "user" && role !== "assistant") continue;

          const content = entry.message?.content ?? entry.content ?? [];
          const text = Array.isArray(content)
            ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
            : typeof content === "string" ? content : "";

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
