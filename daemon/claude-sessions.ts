import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";



const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface ClaudeSession {
  id: string;
  project: string;
  projectLabel: string;
  firstMessage: string;
  lastActiveAt: string;
}

// Read the cwd directly from the JSONL file — every entry has a "cwd" field
// that is the exact project path Claude used. No encoding/decoding needed.
function readProjectCwd(filePath: string): string | null {
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
        if (json.cwd) return json.cwd as string;
      } catch { /* incomplete line */ }
    }
  } catch { /* unreadable */ }
  return null;
}

function projectLabel(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
}

function readFirstMessage(filePath: string): string {
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
        if (json.type === "user" && typeof json.message?.content === "string") {
          return json.message.content.slice(0, 120);
        }
      } catch { /* incomplete line at chunk boundary */ }
    }
    return "";
  } catch {
    return "";
  }
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
}

export function readHistory(sessionId: string, limit = 20): HistoryMessage[] {
  try {
    const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const dir of projectDirs) {
      const filePath = join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (!existsSync(filePath)) continue;

      const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
      const messages: HistoryMessage[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "user" && typeof entry.message?.content === "string") {
            messages.push({ role: "user", text: entry.message.content });
          } else if (entry.type === "assistant") {
            const content = entry.message?.content;
            if (!Array.isArray(content)) continue;
            const toolUses = content.filter((c: any) => c.type === "tool_use");
            for (const tool of toolUses) {
              messages.push({ role: "tool", toolName: tool.name, text: "" });
            }
            const text = content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("");
            if (text) messages.push({ role: "assistant", text });
          }
        } catch {
          // skip malformed lines
        }
      }

      return messages.slice(-limit);
    }
  } catch {
    // ~/.claude/projects not readable
  }
  return [];
}

export function claudeSessionExists(sessionId: string): boolean {
  try {
    const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const dir of projectDirs) {
      if (existsSync(join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

export function listClaudeSessions(): ClaudeSession[] {
  const sessions: ClaudeSession[] = [];

  try {
    const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const dir of projectDirs) {
      const dirPath = join(CLAUDE_PROJECTS_DIR, dir);
      if (!statSync(dirPath).isDirectory()) continue;

      // Only top-level .jsonl files — skip subagent subdirectories
      const files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
      for (const file of files) {
        const filePath = join(dirPath, file);
        const id = file.replace(".jsonl", "");
        const stat = statSync(filePath);
        // Read the real project path directly from the JSONL — no encoding/decoding
        const project = readProjectCwd(filePath) ?? homedir();
        const label = projectLabel(project);
        sessions.push({
          id,
          project,
          projectLabel: label,
          firstMessage: readFirstMessage(filePath),
          lastActiveAt: stat.mtime.toISOString(),
        });
      }
    }
  } catch {
    // ~/.claude/projects doesn't exist or isn't readable
  }

  const seen = new Set<string>();
  const unique = sessions.filter((s) => seen.has(s.id) ? false : (seen.add(s.id), true));
  return unique.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)).slice(0, 50);
}
