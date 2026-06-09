// Pure data-transform helpers extracted from useDiktat.ts.
// No React / react-native imports — safe to unit-test in isolation.

import type { DiktatSession, DiktatMessage } from "../hooks/useDiktat";

/**
 * Raw session inputs as received in the "connected" daemon message.
 * Each is `any[]` in the source; we keep them loose here to mirror that the
 * shapes are daemon-provided and only `id`/`cliSessionId`/`cli` are inspected.
 */
export type MergeSessionsInput = {
  sessions?: any[];
  claudeSessions?: any[];
  cursorSessions?: any[];
  codexSessions?: any[];
  copilotSessions?: any[];
  kiroSessions?: any[];
};

/**
 * Combine daemon + native (claude/cursor/codex/copilot/kiro) sessions, tag each
 * with `source`, and drop daemon sessions whose `cliSessionId` collides with a
 * native session id. Ordering: claude, cursor, codex, copilot, kiro, then the
 * filtered daemon sessions.
 */
export function mergeSessions(input: MergeSessionsInput): DiktatSession[] {
  const daemonSessions: any[] = (input.sessions ?? []).map((s: any) => ({ ...s, source: "daemon" }));
  const claudeSessions: any[] = (input.claudeSessions ?? []).map((s: any) => ({ ...s, source: "claude", cli: "claude" }));
  const cursorSessions: any[] = (input.cursorSessions ?? []).map((s: any) => ({ ...s, source: "cursor", cli: "cursor" }));
  const codexSessions: any[] = (input.codexSessions ?? []).map((s: any) => ({ ...s, source: "codex", cli: "codex" }));
  const copilotSessions: any[] = (input.copilotSessions ?? []).map((s: any) => ({ ...s, source: "copilot", cli: "copilot" }));
  const kiroSessions: any[] = (input.kiroSessions ?? []).map((s: any) => ({ ...s, source: "kiro", cli: "kiro" }));
  const native = [...claudeSessions, ...cursorSessions, ...codexSessions, ...copilotSessions, ...kiroSessions];
  const nativeIds = new Set(native.map((s) => s.id));
  const filteredDaemon = daemonSessions.filter((s) => !s.cliSessionId || !nativeIds.has(s.cliSessionId));
  return [...native, ...filteredDaemon];
}

/**
 * Build the tool display string: `name:basename` when a path is present,
 * otherwise just `name` (or null if name is absent). Mirrors lines 172-174.
 *
 * Quirk: a trailing-slash path (e.g. "a/b/") yields an empty last segment from
 * split("/").pop() === "", which is NOT nullish, so `?? path` does not kick in —
 * the result is `name:` with an empty basename.
 */
export function toolDisplayString(name?: string | null, path?: string | null): string | null {
  return path
    ? `${name}:${path.split("/").pop() ?? path}`
    : (name ?? null);
}

/**
 * Coalesce a streamed output chunk into the messages array. If the last message
 * is an assistant bubble, concatenate the text into it; otherwise push a new
 * assistant bubble. Mirrors lines 230-234.
 */
export function appendOutput(prev: DiktatMessage[], text: string): DiktatMessage[] {
  const last = prev[prev.length - 1];
  if (last?.role === "assistant") {
    return [...prev.slice(0, -1), { role: "assistant", text: last.text + text }];
  }
  return [...prev, { role: "assistant", text }];
}
