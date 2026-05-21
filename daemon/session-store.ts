import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SESSIONS_DIR = "./sessions";

export interface SessionData {
  id: string;
  cli: string;
  cliPath: string;
  project: string;
  cliSessionId?: string;
  createdAt: string;
  lastActiveAt: string;
  mode?: string;
}

function ensureSessionsDir() {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR);
}

export function saveSession(session: SessionData): void {
  ensureSessionsDir();
  writeFileSync(join(SESSIONS_DIR, `${session.id}.json`), JSON.stringify(session, null, 2));
}

export function loadSession(id: string): SessionData | null {
  const path = join(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function listSessions(): SessionData[] {
  ensureSessionsDir();
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8")) as SessionData)
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}
