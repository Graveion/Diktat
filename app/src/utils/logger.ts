export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  id: number;
  ts: string;
  level: LogLevel;
  tag: string;
  msg: string;
};

const MAX = 600;
let entries: LogEntry[] = [];
let counter = 0;
const listeners = new Set<(entries: LogEntry[]) => void>();

export function log(level: LogLevel, tag: string, msg: string) {
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8) + "." + String(now.getMilliseconds()).padStart(3, "0");
  const entry: LogEntry = { id: counter++, ts, level, tag, msg };
  if (entries.length >= MAX) entries = entries.slice(-MAX + 1);
  entries = [...entries, entry];
  listeners.forEach((fn) => fn(entries));
  const line = `[${ts}] [${tag}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const info  = (tag: string, msg: string) => log("info",  tag, msg);
export const warn  = (tag: string, msg: string) => log("warn",  tag, msg);
export const error = (tag: string, msg: string) => log("error", tag, msg);

export function getLogs() { return entries; }
export function clearLogs() { entries = []; listeners.forEach((fn) => fn(entries)); }

export function subscribeToLogs(fn: (entries: LogEntry[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function exportLogs(): string {
  return entries
    .map((e) => `${e.ts} [${e.tag}] ${e.level.toUpperCase().padEnd(5)} ${e.msg}`)
    .join("\n");
}
