import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { readHead, readTail } from "./file-read";

export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface ClaudeSession {
  id: string;
  project: string;
  projectLabel: string;
  firstMessage: string;
  lastActiveAt: string;
}

// Read the cwd directly from the JSONL file — every entry has a "cwd" field
// that is the exact project path Claude used. No encoding/decoding needed.
export function readProjectCwd(filePath: string): string | null {
  const chunk = readHead(filePath);
  for (const line of chunk.split("\n").filter(Boolean)) {
    try {
      const json = JSON.parse(line);
      if (json.cwd) return json.cwd as string;
    } catch { /* incomplete line at chunk boundary */ }
  }
  return null;
}

function projectLabel(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
}

export function readFirstMessage(filePath: string): string {
  const chunk = readHead(filePath);
  for (const line of chunk.split("\n").filter(Boolean)) {
    try {
      const json = JSON.parse(line);
      if (json.type === "user" && typeof json.message?.content === "string") {
        return json.message.content.slice(0, 120);
      }
    } catch { /* incomplete line at chunk boundary */ }
  }
  return "";
}

import { buildToolUsePreview, buildToolResultPreview } from "./tool-preview";

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  toolPath?: string;
  // Enrichment for tool messages (all optional)
  toolId?: string;
  toolDiff?: string;
  toolPreview?: string;
  toolCommand?: string;
  toolResult?: string;
  toolTruncated?: boolean;
  toolResultTruncated?: boolean;
  toolFullSize?: number;
}

function extractToolPath(_name: string, input: any): string | undefined {
  if (!input) return undefined;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  return undefined;
}

// Build the same "Name:filename" string that live tool_use events produce.
// Canonical display names for tool variants across Claude and Cursor CLIs.
const TOOL_CANONICAL: Record<string, string> = {
  // Cursor aliases for standard tools
  ReadFile: "Read",
  StrReplace: "Edit",
  ApplyPatch: "Edit",
  rg: "Grep",
  AwaitShell: "Bash",
  ReadLints: "Bash",
  Delete: "Write",
  call_mcp_tool: "Task",
  CallMcpTool: "Task",
};

export function toolDisplayName(name: string, input: any): string {
  const canonical = TOOL_CANONICAL[name] ?? name;
  if (!input) return canonical;
  const path: string | undefined = input.file_path ?? input.path ?? undefined;
  if (path) return `${canonical}:${path.split("/").pop() ?? path}`;
  if ((canonical === "Bash" || name === "AwaitShell") && typeof input.command === "string") {
    return `${canonical}:${input.command.slice(0, 35)}`;
  }
  return canonical;
}

export function readHistory(sessionId: string, limit = 20, projectsDir = CLAUDE_PROJECTS_DIR): HistoryMessage[] {
  try {
    const projectDirs = readdirSync(projectsDir);
    for (const dir of projectDirs) {
      const filePath = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (!existsSync(filePath)) continue;

      // Tail the file (hard byte cap) rather than slurping the whole thing —
      // we only render the last `limit` messages anyway.
      const lines = readTail(filePath).split("\n").filter(Boolean);
      const messages: HistoryMessage[] = [];
      // tool_use id → index in `messages` so tool_result can update it
      const toolIndexById = new Map<string, number>();

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "user") {
            const content = entry.message?.content;
            if (typeof content === "string") {
              messages.push({ role: "user", text: content });
            } else if (Array.isArray(content)) {
              // User entries can contain tool_result blocks (after tool execution)
              // and/or text blocks (when actually a user message). Handle both.
              for (const block of content) {
                if (block?.type === "tool_result") {
                  const idx = toolIndexById.get(block.tool_use_id);
                  if (idx === undefined) continue;
                  const result = buildToolResultPreview(block.content);
                  if (!result) continue;
                  const msg = messages[idx];
                  if (msg) {
                    msg.toolResult = result.preview;
                    msg.toolResultTruncated = result.truncated;
                    if (!msg.toolFullSize) msg.toolFullSize = result.fullSize;
                  }
                }
              }
              const text = content
                .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                .map((c: any) => c.text)
                .join("");
              if (text) messages.push({ role: "user", text });
            }
          } else if (entry.type === "assistant") {
            const content = entry.message?.content;
            if (!Array.isArray(content)) continue;
            for (const block of content) {
              if (block?.type !== "tool_use") continue;
              const preview = buildToolUsePreview(block.name, block.input);
              const msg: HistoryMessage = {
                role: "tool",
                text: "",
                toolName: toolDisplayName(block.name, block.input),
                toolPath: extractToolPath(block.name, block.input),
                toolId: block.id,
                toolDiff: preview.diff,
                toolPreview: preview.preview,
                toolCommand: preview.command,
                toolTruncated: preview.truncated,
                toolFullSize: preview.fullSize,
              };
              messages.push(msg);
              if (block.id) toolIndexById.set(block.id, messages.length - 1);
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

export function claudeSessionExists(sessionId: string, projectsDir = CLAUDE_PROJECTS_DIR): boolean {
  try {
    const projectDirs = readdirSync(projectsDir);
    for (const dir of projectDirs) {
      if (existsSync(join(projectsDir, dir, `${sessionId}.jsonl`))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

export function listClaudeSessions(projectsDir = CLAUDE_PROJECTS_DIR): ClaudeSession[] {
  const sessions: ClaudeSession[] = [];

  try {
    const projectDirs = readdirSync(projectsDir);
    for (const dir of projectDirs) {
      const dirPath = join(projectsDir, dir);
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
