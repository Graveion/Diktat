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

// ─── Adaptive countdown ──────────────────────────────────────────────────────
// Adjusts the base countdown duration based on transcript characteristics.
// Returns a multiplier on the base duration, or 0 to suppress auto-send entirely.
export function adaptiveCountdownMultiplier(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/);
  // Hesitation markers → don't auto-send, user is still thinking
  if (/\b(uh|uhm|um+|hmm+|err+|wait|hold on|let me think|actually)\b/i.test(trimmed)) return 0;
  // Single word → likely a false trigger or pending more
  if (words.length === 1) return 0;
  // Ends with a question mark → user likely wants to re-read it
  if (/\?$/.test(trimmed)) return 1.5;
  // Long utterance → more to review
  if (words.length > 30) return 1.4;
  // Short, decisive → ship it
  if (words.length < 5) return 0.7;
  return 1.0;
}

// ─── Post-transcript voice commands ─────────────────────────────────────────
// Short utterances heard while the review card is up are interpreted as commands
// rather than appended to the draft.
export type VoiceCommand = "send" | "cancel" | "edit" | "plan";
export function matchVoiceCommand(text: string): VoiceCommand | null {
  const lower = text.toLowerCase().trim().replace(/[.,!?]+$/, "");
  const words = lower.split(/\s+/);
  if (words.length > 4) return null; // too long — treat as additional dictation
  if (/^(yeah\s+|yes\s+|ok(ay)?\s+)?send(\s+it)?$/.test(lower) || lower === "submit" || lower === "go") return "send";
  if (["cancel", "discard", "scrap", "nevermind", "never mind", "no wait", "delete that", "nope", "stop"].includes(lower)) return "cancel";
  if (["edit", "edit it", "let me edit", "let me fix that", "let me fix it"].includes(lower)) return "edit";
  if (lower === "plan" || lower === "slash plan" || lower === "make a plan") return "plan";
  return null;
}

export const COMMAND_VOCAB = ["send", "cancel", "discard", "edit", "scrap", "nevermind", "submit", "plan", "stop"];

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
