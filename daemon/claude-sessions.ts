import { readdirSync, readFileSync, statSync } from "fs";
import { join, homedir } from "path";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface ClaudeSession {
  id: string;
  project: string;
  projectLabel: string;
  firstMessage: string;
  lastActiveAt: string;
}

function decodeProjectPath(encoded: string): string {
  // Encoded path replaces '/' with '-', leading '-' is the root '/'
  // e.g. '-Users-tim-Documents-myproject' -> '/Users/tim/Documents/myproject'
  // Best-effort: replace leading '-' with '/' then try to match home dir
  const home = homedir();
  const homeEncoded = home.replace(/\//g, "-");
  if (encoded.startsWith(homeEncoded)) {
    return home + encoded.slice(homeEncoded.length).replace(/-/g, "/");
  }
  return "/" + encoded.slice(1).replace(/-/g, "/");
}

function projectLabel(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
}

function readFirstMessage(filePath: string): string {
  try {
    const firstLine = readFileSync(filePath, "utf-8").split("\n")[0];
    const json = JSON.parse(firstLine);
    return json.content ?? json.message ?? "";
  } catch {
    return "";
  }
}

export function listClaudeSessions(): ClaudeSession[] {
  const sessions: ClaudeSession[] = [];

  try {
    const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const dir of projectDirs) {
      const dirPath = join(CLAUDE_PROJECTS_DIR, dir);
      if (!statSync(dirPath).isDirectory()) continue;

      const project = decodeProjectPath(dir);
      const label = projectLabel(project);

      const files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
      for (const file of files) {
        const filePath = join(dirPath, file);
        const id = file.replace(".jsonl", "");
        const stat = statSync(filePath);
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

  return sessions.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}
