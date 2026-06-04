// ─── Voice vocabulary ────────────────────────────────────────────────────────
// 50 general dev terms that general-purpose speech recognisers reliably mishear.
// Kept language-agnostic so they apply to any project.
export const CODING_VOCAB_BASE = [
  // Auth & security
  "authentication", "authorization", "OAuth", "JSON web token",
  // Testing
  "unit test", "integration test", "end to end test", "test case",
  "assertion", "mock", "stub", "fixture",
  // Architecture & patterns
  "interface", "dependency injection", "singleton", "middleware",
  "repository", "factory", "observer", "decorator",
  // API & networking
  "endpoint", "REST API", "WebSocket", "request payload", "response body",
  "GraphQL", "webhook",
  // Database
  "migration", "schema", "transaction", "query",
  // Dev workflow
  "refactor", "debug", "deploy", "pull request", "code review",
  "merge conflict", "environment variable",
  // Code structure
  "component", "service", "module", "utility", "config",
  "callback", "event handler", "error handling",
  // State & data
  "loading state", "error state", "data fetching", "state management",
  // General technical
  "validation", "serialization", "encryption", "pagination",
  "caching", "rate limiting",
];

// Build final list: static vocab + up to 10 dynamic project-specific slots.
export function buildContextualStrings(projectLabel?: string): string[] {
  const dynamic: string[] = [];
  if (projectLabel) dynamic.push(projectLabel);
  return [...CODING_VOCAB_BASE, ...dynamic].slice(0, 100);
}

// ─── Voice → slash command mapping ──────────────────────────────────────────

export const VOICE_TO_SLASH: Array<{ patterns: string[]; command: string }> = [
  { patterns: ["slash plan", "plan mode", "switch to plan"],       command: "/plan" },
  { patterns: ["slash ask", "ask mode", "read only mode"],          command: "/ask" },
  { patterns: ["compress", "compress context", "free context"],    command: "/compress" },
  { patterns: ["new chat", "start fresh", "clear chat"],           command: "/new-chat" },
  { patterns: ["auto run", "enable auto run", "toggle auto run"],  command: "/auto-run" },
  { patterns: ["max mode", "enable max mode", "toggle max mode"],  command: "/max-mode" },
  { patterns: ["slash clear", "clear context"],                    command: "/clear" },
  { patterns: ["compact", "compact context"],                      command: "/compact" },
];

export function detectSlashCommand(text: string): string {
  const lower = text.toLowerCase().trim();
  for (const { patterns, command } of VOICE_TO_SLASH) {
    if (patterns.some((p) => lower === p || lower.startsWith(p + " "))) return command;
  }
  return text;
}
