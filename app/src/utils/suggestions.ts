// ─── Intent → command suggestions ────────────────────────────────────────────
// Maps natural-language phrases in the transcript to relevant slash commands.
// Only suggests commands that actually exist for the active CLI.
export const INTENT_RULES: Array<{ patterns: RegExp[]; cmd: string }> = [
  { patterns: [/\b(plan|figure out|design|come up with|map out|think about|strategy)\b/i],     cmd: "/plan" },
  { patterns: [/\b(explore|explain|what is|how does|what does|tell me about|read only)\b/i],  cmd: "/ask" },
  { patterns: [/\b(start over|fresh start|reset)\b/i],                                         cmd: "/clear" },
  { patterns: [/\b(new chat|new session)\b/i],                                                 cmd: "/new-chat" },
  { patterns: [/\b(compact|condense)\b/i],                                                     cmd: "/compact" },
  { patterns: [/\b(compress|free context|free space)\b/i],                                     cmd: "/compress" },
];

export function suggestCommands(text: string, availableCmds: string[]): string[] {
  if (!text || text.trim().startsWith("/")) return [];
  const matched = new Set<string>();
  for (const rule of INTENT_RULES) {
    if (!availableCmds.includes(rule.cmd)) continue;
    if (rule.patterns.some((p) => p.test(text))) matched.add(rule.cmd);
    if (matched.size >= 2) break;
  }
  return Array.from(matched);
}

// ─── Idle suggestions ────────────────────────────────────────────────────────
// Short follow-up prompts shown after a session has been idle for IDLE_DELAY_MS.
// Light context-awareness based on the last assistant message.
export const IDLE_DELAY_MS = 30000;

export function buildIdleSuggestions(lastAssistantText?: string): string[] {
  const base = ["Continue", "Explain what you did"];
  if (!lastAssistantText) return [...base, "What's next?"];
  const lower = lastAssistantText.toLowerCase();
  const extra: string[] = [];
  if (/\btest|spec\b/.test(lower)) extra.push("Run the tests");
  if (/\bcommit|stage|git\b/.test(lower)) extra.push("Commit this");
  if (/\berror|fail|broken|issue\b/.test(lower)) extra.push("Try a different approach");
  if (/\bplan|todo|next step\b/.test(lower)) extra.push("Start on step one");
  if (extra.length === 0) extra.push("What's next?");
  return [...extra.slice(0, 2), base[0]].slice(0, 3);
}
