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
