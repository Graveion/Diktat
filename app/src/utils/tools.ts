// ─── Tool labels & icons ────────────────────────────────────────────────────

export const TOOL_LABELS: Record<string, string> = {
  Read: "Reading", Write: "Writing", Edit: "Editing", MultiEdit: "Editing",
  Bash: "Running", Grep: "Searching", Glob: "Searching",
  WebSearch: "Searching", WebFetch: "Fetching",
  TodoWrite: "Updating plan", Task: "Sub-agent",
};
export const TOOL_ICONS: Record<string, string> = {
  Read: "📄", Write: "✏️", Edit: "✏️", MultiEdit: "✏️",
  Bash: "⚡", Grep: "🔍", Glob: "🔍",
  WebSearch: "🌐", WebFetch: "🌐",
  TodoWrite: "📋", Task: "🤖",
};

export function formatToolLabel(tool: string): { label: string; icon: string } {
  const colon = tool.indexOf(":");
  if (colon === -1) {
    return { label: TOOL_LABELS[tool] ?? tool, icon: TOOL_ICONS[tool] ?? "🔧" };
  }
  const name = tool.slice(0, colon);
  const file = tool.slice(colon + 1);
  return {
    label: `${TOOL_LABELS[name] ?? name} ${file}`,
    icon: TOOL_ICONS[name] ?? "🔧",
  };
}
