import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { HistoryMessage } from "./claude-sessions";
import { toolDisplayName } from "./claude-sessions";
import { buildToolUsePreview, buildToolResultPreview } from "./tool-preview";
import { decodeCursorPath } from "./path-utils";
import { readHead, readTail } from "./file-read";

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

/**
 * Cursor wraps the real user turn in <user_query>…</user_query> and prepends
 * its own injected preamble — timestamps, plus agent instructions like
 * "Briefly inform the user…" — *outside* those tags. When the tags are present
 * the only user-authored text is inside them, so extract that and drop the rest
 * (else the injected preamble displays in place of the actual question). Falls
 * back to stripping bare <timestamp> wrappers when there is no <user_query>.
 */
export function stripCursorWrappers(text: string): string {
  const matches = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)];
  if (matches.length > 0) {
    return matches.map((m) => m[1]!).join("\n\n").trim();
  }
  return text.replace(/<timestamp>[^<]*<\/timestamp>\s*/g, "").trim();
}

export function readFirstUserMessage(filePath: string): string {
    const chunk = readHead(filePath);
    for (const line of chunk.split("\n").filter(Boolean)) {
      try {
        const json = JSON.parse(line);
        if (json.role === "user") {
          const content = json.message?.content ?? json.content ?? [];
          const text = Array.isArray(content)
            ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
            : typeof content === "string" ? content : "";
          if (text) {
            const clean = stripCursorWrappers(text);
            if (clean) return clean.slice(0, 120);
          }
        }
      } catch { /* incomplete line at chunk boundary */ }
    }
    return "";
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

      // Tail with a hard byte cap — we only render the last `limit` messages.
      const lines = readTail(filePath).split("\n").filter(Boolean);
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

          // Cursor streams a single assistant message as consecutive `text`
          // fragments within one entry. Concatenate them seamlessly ("") — the
          // model's own newlines are already inside the fragments, so trimming
          // each and joining with "\n\n" (the old behaviour) both dropped the
          // space at a mid-word split and injected spurious blank lines. Strip
          // [REDACTED] reasoning inline; trim only the final assembled text.
          let text = Array.isArray(content)
            ? content
                .filter((c: any) => c.type === "text")
                .map((c: any) => ((c.text ?? "") as string).replace(/\[REDACTED\]/gi, ""))
                .join("")
                .trim()
            : typeof content === "string"
              ? content.replace(/\[REDACTED\]/g, "").trim()
              : "";

          // User turns carry Cursor's <user_query> wrapper + injected preamble;
          // show only the user-authored text (same as the session-list preview).
          if (role === "user") text = stripCursorWrappers(text);

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
