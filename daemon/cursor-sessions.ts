import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { HistoryMessage } from "./claude-sessions";
import { toolDisplayName } from "./claude-sessions";
import { buildToolUsePreview, buildToolResultPreview } from "./tool-preview";
import { decodeCursorPath } from "./path-utils";

function extractToolPath(input: any): string | undefined {
  if (!input) return undefined;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  return undefined;
}

export const CURSOR_PROJECTS_DIR = join(homedir(), ".cursor", "projects");

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

export function readFirstUserMessage(filePath: string): string {
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

export function listCursorSessions(projectsDir = CURSOR_PROJECTS_DIR): CursorSession[] {
  const sessions: CursorSession[] = [];

  try {
    const projectDirs = readdirSync(projectsDir);
    for (const dir of projectDirs) {
      const transcriptsDir = join(projectsDir, dir, "agent-transcripts");
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

export function readCursorHistory(sessionId: string, limit = 20, projectsDir = CURSOR_PROJECTS_DIR): HistoryMessage[] {
  try {
    const projectDirs = readdirSync(projectsDir);
    for (const dir of projectDirs) {
      const filePath = join(projectsDir, dir, "agent-transcripts", sessionId, `${sessionId}.jsonl`);
      if (!existsSync(filePath)) continue;

      const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
      const messages: HistoryMessage[] = [];
      const toolIndexById = new Map<string, number>();

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const role = entry.role;
          if (role !== "user" && role !== "assistant") continue;

          const content = entry.message?.content ?? entry.content ?? [];

          if (Array.isArray(content)) {
            for (const block of content) {
              if (role === "assistant" && block?.type === "tool_use") {
                const preview = buildToolUsePreview(block.name, block.input);
                messages.push({
                  role: "tool",
                  text: "",
                  toolName: toolDisplayName(block.name, block.input),
                  toolPath: extractToolPath(block.input),
                  toolId: block.id,
                  toolDiff: preview.diff,
                  toolPreview: preview.preview,
                  toolCommand: preview.command,
                  toolTruncated: preview.truncated,
                  toolFullSize: preview.fullSize,
                });
                if (block.id) toolIndexById.set(block.id, messages.length - 1);
              } else if (role === "user" && block?.type === "tool_result") {
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
          }

          const text = Array.isArray(content)
            ? content
                .filter((c: any) => c.type === "text")
                .map((c: any) => ((c.text ?? "") as string).replace(/\[REDACTED\]/gi, "").trim())
                .filter(Boolean)
                .join("\n\n")
            : typeof content === "string"
              ? content.replace(/\[REDACTED\]/g, "").trim()
              : "";

          if (text.trim()) messages.push({ role, text });
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
