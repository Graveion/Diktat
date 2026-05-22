import { useState, useRef, useEffect, useCallback } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet,
  TextInput, KeyboardAvoidingView, Platform, Animated,
  ScrollView, DeviceEventEmitter, ActivityIndicator,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Markdown from "react-native-markdown-display";
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import * as Localization from "expo-localization";
import * as Speech from "expo-speech";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import type { DiktatMessage } from "../hooks/useDiktat";
import { useSettings } from "../hooks/useSettings";
import { AUTO_SEND_DURATIONS } from "../utils/settings";
import { SettingsSheet } from "../components/SettingsSheet";
import { colors, fonts } from "../theme";

// ─── Voice vocabulary ────────────────────────────────────────────────────────
// 50 general dev terms that general-purpose speech recognisers reliably mishear.
// Kept language-agnostic so they apply to any project.
const CODING_VOCAB_BASE = [
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
function buildContextualStrings(projectLabel?: string): string[] {
  const dynamic: string[] = [];
  if (projectLabel) dynamic.push(projectLabel);
  return [...CODING_VOCAB_BASE, ...dynamic].slice(0, 100);
}

// ─── Intent → command suggestions ────────────────────────────────────────────
// Maps natural-language phrases in the transcript to relevant slash commands.
// Only suggests commands that actually exist for the active CLI.
const INTENT_RULES: Array<{ patterns: RegExp[]; cmd: string }> = [
  { patterns: [/\b(plan|figure out|design|come up with|map out|think about|strategy)\b/i],     cmd: "/plan" },
  { patterns: [/\b(explore|explain|what is|how does|what does|tell me about|read only)\b/i],  cmd: "/ask" },
  { patterns: [/\b(start over|fresh start|reset)\b/i],                                         cmd: "/clear" },
  { patterns: [/\b(new chat|new session)\b/i],                                                 cmd: "/new-chat" },
  { patterns: [/\b(compact|condense)\b/i],                                                     cmd: "/compact" },
  { patterns: [/\b(compress|free context|free space)\b/i],                                     cmd: "/compress" },
];

// ─── Idle suggestions ────────────────────────────────────────────────────────
// Short follow-up prompts shown after a session has been idle for IDLE_DELAY_MS.
// Light context-awareness based on the last assistant message.
const IDLE_DELAY_MS = 30000;

function buildIdleSuggestions(lastAssistantText?: string): string[] {
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

// ─── Adaptive countdown ──────────────────────────────────────────────────────
// Adjusts the base countdown duration based on transcript characteristics.
// Returns a multiplier on the base duration, or 0 to suppress auto-send entirely.
function adaptiveCountdownMultiplier(text: string): number {
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

function suggestCommands(text: string, availableCmds: string[]): string[] {
  if (!text || text.trim().startsWith("/")) return [];
  const matched = new Set<string>();
  for (const rule of INTENT_RULES) {
    if (!availableCmds.includes(rule.cmd)) continue;
    if (rule.patterns.some((p) => p.test(text))) matched.add(rule.cmd);
    if (matched.size >= 2) break;
  }
  return Array.from(matched);
}

// ─── Post-transcript voice commands ─────────────────────────────────────────
// Short utterances heard while the review card is up are interpreted as commands
// rather than appended to the draft.
type VoiceCommand = "send" | "cancel" | "edit" | "plan";
function matchVoiceCommand(text: string): VoiceCommand | null {
  const lower = text.toLowerCase().trim().replace(/[.,!?]+$/, "");
  const words = lower.split(/\s+/);
  if (words.length > 4) return null; // too long — treat as additional dictation
  if (/^(yeah\s+|yes\s+|ok(ay)?\s+)?send(\s+it)?$/.test(lower) || lower === "submit" || lower === "go") return "send";
  if (["cancel", "discard", "scrap", "nevermind", "never mind", "no wait", "delete that", "nope", "stop"].includes(lower)) return "cancel";
  if (["edit", "edit it", "let me edit", "let me fix that", "let me fix it"].includes(lower)) return "edit";
  if (lower === "plan" || lower === "slash plan" || lower === "make a plan") return "plan";
  return null;
}

const COMMAND_VOCAB = ["send", "cancel", "discard", "edit", "scrap", "nevermind", "submit", "plan", "stop"];

const DRAFT_KEY = "diktat:draft";

const EXAMPLE_PROMPTS = [
  "What's in this codebase?",
  "Run the tests and tell me what fails",
  "Suggest a small improvement",
];

const COPIED_EVENT = "diktat:copied";
const emitCopied = () => DeviceEventEmitter.emit(COPIED_EVENT);

// ─── Tool labels & icons ────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  Read: "Reading", Write: "Writing", Edit: "Editing", MultiEdit: "Editing",
  Bash: "Running", Grep: "Searching", Glob: "Searching",
  WebSearch: "Searching", WebFetch: "Fetching",
  TodoWrite: "Updating plan", Task: "Sub-agent",
};
const TOOL_ICONS: Record<string, string> = {
  Read: "📄", Write: "✏️", Edit: "✏️", MultiEdit: "✏️",
  Bash: "⚡", Grep: "🔍", Glob: "🔍",
  WebSearch: "🌐", WebFetch: "🌐",
  TodoWrite: "📋", Task: "🤖",
};

function formatToolLabel(tool: string): { label: string; icon: string } {
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

// ─── Slash commands ──────────────────────────────────────────────────────────

const SLASH_COMMANDS: Record<string, Array<{ cmd: string; description: string }>> = {
  cursor: [
    { cmd: "/plan",     description: "Switch to plan mode" },
    { cmd: "/ask",      description: "Read-only exploration" },
    { cmd: "/compress", description: "Free context space" },
    { cmd: "/new-chat", description: "Start fresh chat" },
    { cmd: "/auto-run", description: "Toggle auto-run" },
    { cmd: "/max-mode", description: "Toggle max mode" },
    { cmd: "/model",    description: "Set model" },
  ],
  claude: [
    { cmd: "/clear",    description: "Clear context" },
    { cmd: "/compact",  description: "Compact context" },
    { cmd: "/model",    description: "Set model" },
  ],
};

// ─── Voice → slash command mapping ──────────────────────────────────────────

const VOICE_TO_SLASH: Array<{ patterns: string[]; command: string }> = [
  { patterns: ["slash plan", "plan mode", "switch to plan"],       command: "/plan" },
  { patterns: ["slash ask", "ask mode", "read only mode"],          command: "/ask" },
  { patterns: ["compress", "compress context", "free context"],    command: "/compress" },
  { patterns: ["new chat", "start fresh", "clear chat"],           command: "/new-chat" },
  { patterns: ["auto run", "enable auto run", "toggle auto run"],  command: "/auto-run" },
  { patterns: ["max mode", "enable max mode", "toggle max mode"],  command: "/max-mode" },
  { patterns: ["slash clear", "clear context"],                    command: "/clear" },
  { patterns: ["compact", "compact context"],                      command: "/compact" },
];

function detectSlashCommand(text: string): string {
  const lower = text.toLowerCase().trim();
  for (const { patterns, command } of VOICE_TO_SLASH) {
    if (patterns.some((p) => lower === p || lower.startsWith(p + " "))) return command;
  }
  return text;
}

// ─── Voice waveform ──────────────────────────────────────────────────────────

function VoiceWaveform() {
  const bars = [
    useRef(new Animated.Value(0.3)).current,
    useRef(new Animated.Value(0.6)).current,
    useRef(new Animated.Value(0.4)).current,
    useRef(new Animated.Value(0.8)).current,
    useRef(new Animated.Value(0.5)).current,
  ];

  useEffect(() => {
    const anims = bars.map((bar, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 80),
          Animated.timing(bar, { toValue: 0.9, duration: 200 + i * 40, useNativeDriver: false }),
          Animated.timing(bar, { toValue: 0.2, duration: 200 + i * 40, useNativeDriver: false }),
        ])
      )
    );
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, []);

  return (
    <View style={waveStyles.container}>
      {bars.map((bar, i) => (
        <Animated.View
          key={i}
          style={[waveStyles.bar, { height: bar.interpolate({ inputRange: [0, 1], outputRange: [4, 20] }) }]}
        />
      ))}
    </View>
  );
}

// ─── Typing indicator ────────────────────────────────────────────────────────

function TypingIndicator() {
  const dots = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];
  useEffect(() => {
    const anims = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(dot, { toValue: 1, duration: 250, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.3, duration: 250, useNativeDriver: true }),
          Animated.delay(500),
        ])
      )
    );
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, []);
  return (
    <View style={typingStyles.container}>
      {dots.map((dot, i) => (
        <Animated.View key={i} style={[typingStyles.dot, {
          opacity: dot,
          transform: [{ scale: dot.interpolate({ inputRange: [0.3, 1], outputRange: [0.7, 1] }) }],
        }]} />
      ))}
    </View>
  );
}

// ─── Message bubble ──────────────────────────────────────────────────────────

// Strip markdown for TTS — speech engines stumble over symbols like # * ` etc.
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "code block") // fenced code → placeholder
    .replace(/`[^`]+`/g, "")                    // inline code → drop
    .replace(/^#{1,6}\s+/gm, "")                // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1")          // bold
    .replace(/\*([^*]+)\*/g, "$1")              // italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")    // links → text only
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")       // images
    .replace(/^[\s-]*[-*+]\s+/gm, ". ")         // bullets → pause
    .replace(/\n{2,}/g, ". ")                   // paragraphs → period
    .replace(/\n/g, " ")
    .trim();
}

function ToolPreviewDrawer({
  message, onCopy,
}: {
  message: DiktatMessage;
  onCopy: () => void;
}) {
  const blocks: Array<{ kind: "diff" | "preview" | "command" | "result"; text: string; truncated?: boolean }> = [];
  if (message.toolCommand) blocks.push({ kind: "command", text: message.toolCommand, truncated: message.toolTruncated });
  if (message.toolDiff) blocks.push({ kind: "diff", text: message.toolDiff, truncated: message.toolTruncated });
  if (message.toolPreview) blocks.push({ kind: "preview", text: message.toolPreview, truncated: message.toolTruncated });
  if (message.toolResult) blocks.push({ kind: "result", text: message.toolResult, truncated: message.toolResultTruncated });

  return (
    <View style={toolDrawerStyles.container}>
      {blocks.map((b, i) => (
        <View key={i} style={toolDrawerStyles.block}>
          <View style={toolDrawerStyles.header}>
            <Text style={toolDrawerStyles.headerLabel}>{
              b.kind === "diff" ? "diff" :
              b.kind === "preview" ? "preview" :
              b.kind === "command" ? "command" :
              "output"
            }</Text>
            <TouchableOpacity
              onPress={() => { Clipboard.setStringAsync(b.text); onCopy(); }}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={toolDrawerStyles.copyText}>copy</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            style={toolDrawerStyles.bodyScrollV}
            nestedScrollEnabled
          >
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={toolDrawerStyles.bodyContent}
            >
              {b.kind === "diff" ? (
                <Text style={toolDrawerStyles.line}>
                  {b.text.split("\n").map((line, li, arr) => (
                    <Text
                      key={li}
                      style={
                        line.startsWith("+") ? toolDrawerStyles.lineAdd :
                        line.startsWith("-") ? toolDrawerStyles.lineDel :
                        line.startsWith("@@") ? toolDrawerStyles.lineHunk :
                        toolDrawerStyles.lineCtx
                      }
                    >
                      {line}{li < arr.length - 1 ? "\n" : ""}
                    </Text>
                  ))}
                </Text>
              ) : (
                <Text style={[toolDrawerStyles.line, toolDrawerStyles.lineCtx]}>
                  {b.text}
                </Text>
              )}
            </ScrollView>
          </ScrollView>
          {b.truncated ? (
            <Text style={toolDrawerStyles.truncated}>
              truncated · {message.toolFullSize ? `${(message.toolFullSize / 1024).toFixed(1)} KB total` : "more available"}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function MessageBubble({
  message, ttsEnabled, isSpeaking, onSpeak,
}: {
  message: DiktatMessage;
  ttsEnabled: boolean;
  isSpeaking: boolean;
  onSpeak: () => void;
}) {
  const handleLongPress = useCallback(() => {
    Clipboard.setStringAsync(message.text);
    emitCopied();
  }, [message.text]);

  if (message.role === "tool") {
    const { label, icon } = formatToolLabel(message.toolName ?? "Tool");
    return (
      <View style={[bubbleStyles.row, bubbleStyles.assistantRow]}>
        <View style={styles.toolBubble}>
          <Text style={styles.toolIcon}>{icon}</Text>
          <Text style={styles.toolText}>{label}</Text>
        </View>
      </View>
    );
  }

  if (message.role === "user") {
    return (
      <TouchableOpacity
        style={[bubbleStyles.row, bubbleStyles.userRow]}
        onLongPress={handleLongPress}
        activeOpacity={0.85}
        delayLongPress={400}
      >
        <View style={[bubbleStyles.bubble, bubbleStyles.userBubble]}>
          <Text style={bubbleStyles.userText}>{message.text}</Text>
        </View>
      </TouchableOpacity>
    );
  }

  // Assistant
  return (
    <TouchableOpacity
      style={[bubbleStyles.row, bubbleStyles.assistantRow]}
      onLongPress={handleLongPress}
      activeOpacity={1}
      delayLongPress={400}
    >
      <View style={bubbleStyles.assistantBubble}>
        <Markdown style={markdownStyles} rules={markdownRules}>
          {message.text}
        </Markdown>
      </View>
      {ttsEnabled && message.text.trim().length > 0 ? (
        <TouchableOpacity
          style={bubbleStyles.speakerBtn}
          onPress={onSpeak}
          activeOpacity={0.6}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Text style={bubbleStyles.speakerIcon}>
            {isSpeaking ? "■ Stop" : "🔊 Read aloud"}
          </Text>
        </TouchableOpacity>
      ) : null}
    </TouchableOpacity>
  );
}

// Markdown rules — all use plain RN components (no HTML elements like <code>/<span>
// which crash on the new architecture)
const markdownRules = {
  code_inline: (node: any, _c: any, _p: any, styles_: any) => (
    <Text key={node.key} style={styles_.code_inline}>{node.content}</Text>
  ),
  fence: (node: any) => (
    <View key={node.key} style={codeBlockStyles.wrapper}>
      <ScrollView
        horizontal
        style={codeBlockStyles.scroll}
        contentContainerStyle={codeBlockStyles.content}
        showsHorizontalScrollIndicator={false}
      >
        <Text style={codeBlockStyles.text}>{(node.content ?? "").trimEnd()}</Text>
      </ScrollView>
      <TouchableOpacity
        style={codeBlockStyles.copyBtn}
        onPress={() => {
          Clipboard.setStringAsync((node.content ?? "").trimEnd());
          emitCopied();
        }}
        activeOpacity={0.7}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Text style={codeBlockStyles.copyBtnText}>copy</Text>
      </TouchableOpacity>
    </View>
  ),
};

// ─── Props ───────────────────────────────────────────────────────────────────

type Props = {
  messages: DiktatMessage[];
  streaming: boolean;
  currentTool: string | null;
  reconnecting: boolean;
  historyLoading: boolean;
  activeSessionId: string | null;
  sessionCli?: string;
  onSend: (text: string) => void;
  onCancel: (sessionId: string) => void;
  onBack: () => void;
  onRetryConnect?: () => void;
  sessionLabel?: string;
};

// ─── Main component ──────────────────────────────────────────────────────────

export function ChatScreen({
  messages, streaming, currentTool, reconnecting, historyLoading,
  activeSessionId, sessionCli, onSend, onCancel, onBack, onRetryConnect, sessionLabel,
}: Props) {
  type Mode = "idle" | "listening" | "reviewing";
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("idle");
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  // Tracks whether the user has deliberately scrolled up during the current
  // streaming response. While streaming we ignore isAtBottom (which thrashes
  // false due to scrollToEnd against stale contentSize) UNLESS the user
  // explicitly scrolled away.
  const userScrolledAwayRef = useRef(false);
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [speakingIdx, setSpeakingIdx] = useState<number | null>(null);
  const [showIdle, setShowIdle] = useState(false);
  const idleOpacity = useRef(new Animated.Value(0)).current;
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { settings, update: updateSettings } = useSettings();

  // Load persisted draft on mount
  useEffect(() => {
    AsyncStorage.getItem(DRAFT_KEY).then((saved) => {
      if (saved) setInput(saved);
    });
  }, []);

  const saveDraft = useCallback((text: string) => {
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      if (text.trim()) {
        AsyncStorage.setItem(DRAFT_KEY, text);
      } else {
        AsyncStorage.removeItem(DRAFT_KEY);
      }
    }, 500);
  }, []);
  const listRef = useRef<ScrollView>(null);
  // Set true when history loads; cleared once we've actually scrolled to the bottom.
  const wantScrollToBottom = useRef(false);
  // Exact viewport height from the ScrollView's onLayout — needed to compute offset.
  const viewportHeight = useRef(0);
  const inputRef = useRef<TextInput>(null);
  const sendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownProgress = useRef(new Animated.Value(1)).current;
  const listeningPhaseRef = useRef<"initial" | "commands">("initial");
  const prevStreaming = useRef(streaming);
  const inputHistory = useRef<string[]>([]);
  const historyIdx = useRef(-1);

  const autoSendDuration = AUTO_SEND_DURATIONS[settings.autoSendMode];
  const listening = mode === "listening";
  const reviewing = mode === "reviewing";

  // Completion haptic
  useEffect(() => {
    if (prevStreaming.current && !streaming && messages.length > 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    prevStreaming.current = streaming;
  }, [streaming]);

  // Idle suggestions: show after IDLE_DELAY_MS of no activity post-response
  useEffect(() => {
    if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
    if (showIdle) {
      // Going from visible → hidden: snap-hide (no fade-out, mirrors original behavior)
      idleOpacity.setValue(0);
      setShowIdle(false);
    }
    if (streaming || mode !== "idle" || messages.length === 0 || input.length > 0) return;
    idleTimerRef.current = setTimeout(() => {
      setShowIdle(true);
      Animated.timing(idleOpacity, { toValue: 1, duration: 280, useNativeDriver: true }).start();
    }, IDLE_DELAY_MS);
    return () => {
      if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
    };
  }, [streaming, mode, messages.length, input]);

  // ─── Countdown / send orchestration ──────────────────────────────────────
  const clearCountdown = useCallback(() => {
    if (sendTimeoutRef.current) { clearTimeout(sendTimeoutRef.current); sendTimeoutRef.current = null; }
    countdownProgress.stopAnimation();
  }, [countdownProgress]);

  const startCountdown = useCallback(() => {
    clearCountdown();
    if (autoSendDuration === 0) {
      // Manual mode — no auto-send. Keep the progress bar visually empty.
      countdownProgress.setValue(0);
      return;
    }
    // Smart adaptive: adjust base duration based on transcript characteristics.
    // Multiplier of 0 means "don't auto-send, wait for explicit action".
    const multiplier = adaptiveCountdownMultiplier(inputRef2.current);
    if (multiplier === 0) {
      countdownProgress.setValue(0);
      return;
    }
    const duration = Math.round(autoSendDuration * multiplier);
    countdownProgress.setValue(1);
    Animated.timing(countdownProgress, {
      toValue: 0,
      duration,
      useNativeDriver: false,
    }).start();
    sendTimeoutRef.current = setTimeout(() => {
      sendDraftRef.current?.();
    }, duration);
  }, [clearCountdown, countdownProgress, autoSendDuration]);

  // Use refs to avoid stale closures — handlers reference *current* state
  const inputRef2 = useRef(input);
  inputRef2.current = input;
  const sendDraftRef = useRef<() => void>(() => {});
  const discardDraftRef = useRef<() => void>(() => {});
  const editDraftRef = useRef<() => void>(() => {});

  const stopAllVoice = useCallback(() => {
    try { ExpoSpeechRecognitionModule.abort(); } catch { /* not running */ }
  }, []);

  const sendDraft = useCallback(() => {
    clearCountdown();
    stopAllVoice();
    const text = inputRef2.current.trim();
    setMode("idle");
    if (text) onSend(text);
    setInput("");
    AsyncStorage.removeItem(DRAFT_KEY);
  }, [clearCountdown, stopAllVoice, onSend]);

  const discardDraft = useCallback(() => {
    clearCountdown();
    stopAllVoice();
    setInput("");
    setMode("idle");
    AsyncStorage.removeItem(DRAFT_KEY);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [clearCountdown, stopAllVoice]);

  const editDraft = useCallback(() => {
    clearCountdown();
    stopAllVoice();
    setMode("idle");
    // input stays — user can edit / type freely
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [clearCountdown, stopAllVoice]);

  sendDraftRef.current = sendDraft;
  discardDraftRef.current = discardDraft;
  editDraftRef.current = editDraft;

  const startCommandPhase = useCallback(() => {
    listeningPhaseRef.current = "commands";
    try {
      const locale = Localization.getLocales()[0]?.languageTag ?? "en-US";
      ExpoSpeechRecognitionModule.start({
        lang: locale,
        interimResults: false,
        continuous: false,
        contextualStrings: [...COMMAND_VOCAB, ...buildContextualStrings(sessionLabel)],
      });
    } catch { /* recognizer busy — will retry on next end */ }
  }, [sessionLabel]);

  const enterReviewMode = useCallback(() => {
    setMode("reviewing");
    startCountdown();
    Haptics.selectionAsync();
    // Briefly delay so the previous recognition session has time to release
    setTimeout(() => startCommandPhase(), 350);
  }, [startCountdown, startCommandPhase]);

  const prefixSlash = useCallback((cmd: string) => {
    setInput((cur) => {
      const trimmed = cur.trim();
      // If already prefixed with a slash command, replace it
      if (trimmed.startsWith("/")) {
        const rest = trimmed.split(" ").slice(1).join(" ");
        return rest ? `${cmd} ${rest}` : `${cmd} `;
      }
      return trimmed ? `${cmd} ${trimmed}` : `${cmd} `;
    });
    startCountdown(); // user took an action — reset the timer
    Haptics.selectionAsync();
  }, [startCountdown]);

  // ─── Voice event handlers ────────────────────────────────────────────────
  useSpeechRecognitionEvent("result", (e) => {
    const text = e.results[0]?.transcript ?? "";
    if (!text) return;

    if (listeningPhaseRef.current === "initial") {
      if (!e.isFinal) {
        setInput(text);
      } else {
        setInput(detectSlashCommand(text));
      }
      return;
    }

    // Command phase — only act on final results
    if (!e.isFinal) return;
    const cmd = matchVoiceCommand(text);
    if (cmd === "send") { sendDraftRef.current(); return; }
    if (cmd === "cancel") { discardDraftRef.current(); return; }
    if (cmd === "edit") { editDraftRef.current(); return; }
    if (cmd === "plan") { prefixSlash("/plan"); return; }
    // Not a command — append to the draft as additional dictation
    setInput((cur) => `${cur} ${text}`.trim());
    startCountdown();
  });

  useSpeechRecognitionEvent("end", () => {
    if (listeningPhaseRef.current === "initial") {
      // First dictation done — enter review if we have content
      if (inputRef2.current.trim()) {
        enterReviewMode();
      } else {
        setMode("idle");
      }
    } else {
      // Command phase ended without a match — restart so we keep listening
      if (mode === "reviewing") {
        setTimeout(() => {
          if (mode === "reviewing") startCommandPhase();
        }, 150);
      }
    }
  });

  useSpeechRecognitionEvent("error", () => {
    if (listeningPhaseRef.current === "initial") {
      setMode("idle");
      clearCountdown();
    }
    // Errors in command phase are non-fatal — review card stays up
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAllVoice();
      clearCountdown();
      Speech.stop();
    };
  }, [stopAllVoice, clearCountdown]);

  const toggleSpeak = useCallback((idx: number, text: string) => {
    if (speakingIdx === idx) {
      Speech.stop();
      setSpeakingIdx(null);
      return;
    }
    Speech.stop();
    const cleaned = stripMarkdown(text);
    if (!cleaned) return;
    setSpeakingIdx(idx);
    Speech.speak(cleaned, {
      onDone: () => setSpeakingIdx((cur) => (cur === idx ? null : cur)),
      onStopped: () => setSpeakingIdx((cur) => (cur === idx ? null : cur)),
      onError: () => setSpeakingIdx((cur) => (cur === idx ? null : cur)),
    });
  }, [speakingIdx]);

  // ─── Scroll to bottom logic ──────────────────────────────────────────────
  //
  // Three cases:
  // 1. History load (messages go from 0 → N): set wantScrollToBottom=true.
  //    onContentSizeChange fires with the exact content height → compute
  //    the precise offset and scroll. No timers, no guessing.
  //
  // 2. Streaming (text appending to last bubble, length unchanged):
  //    onContentSizeChange fires on each token → follow unless user scrolled away.
  //
  // 3. New user/assistant bubble appended (length +1):
  //    If we were at the bottom, scroll to follow.

  const prevLengthRef = useRef(0);

  useEffect(() => {
    if (messages.length === 0) {
      prevLengthRef.current = 0;
      wantScrollToBottom.current = false;
      userScrolledAwayRef.current = false;
      isAtBottomRef.current = true;
      listRef.current?.scrollTo({ y: 0, animated: false });
      return;
    }
    const isHistory = messages.length - prevLengthRef.current > 1;
    prevLengthRef.current = messages.length;
    if (isHistory) {
      wantScrollToBottom.current = true;
      // Fallback: if onContentSizeChange already fired before this effect
      // (possible in Fabric when effects are deferred), scroll explicitly.
      requestAnimationFrame(() => {
        if (wantScrollToBottom.current) {
          const offset = Math.max(0, viewportHeight.current > 0
            ? 99999  // viewportHeight known → use large-y clamp as exact fallback
            : 0);
          listRef.current?.scrollTo({ y: offset, animated: false });
        }
      });
    } else if (isAtBottomRef.current) {
      listRef.current?.scrollTo({ y: 99999, animated: false });
    }
  }, [messages.length]);

  // Streaming: follow as text grows (length doesn't change, content does).
  useEffect(() => {
    if (!streamingRef.current) return;
    if (userScrolledAwayRef.current) return;
    const id = requestAnimationFrame(() => listRef.current?.scrollTo({ y: 99999, animated: false }));
    return () => cancelAnimationFrame(id);
  }, [messages, currentTool]);

  const startInitialListening = useCallback(() => {
    setInput("");
    listeningPhaseRef.current = "initial";
    setMode("listening");
    const locale = Localization.getLocales()[0]?.languageTag ?? "en-US";
    try {
      ExpoSpeechRecognitionModule.start({
        lang: locale,
        interimResults: true,
        contextualStrings: buildContextualStrings(sessionLabel),
      });
    } catch {
      setMode("idle");
    }
  }, [sessionLabel]);

  const stopInitialListening = useCallback(() => {
    try { ExpoSpeechRecognitionModule.stop(); } catch { /* not running */ }
  }, []);

  // Tap-to-toggle behavior (used when settings.micMode === "toggle")
  const toggleListening = () => {
    if (mode === "listening") { stopInitialListening(); return; }
    if (mode === "reviewing") {
      // Tap mic during review = discard and re-record
      discardDraft();
      setTimeout(() => startInitialListening(), 100);
      return;
    }
    startInitialListening();
  };

  // Press-and-hold behavior (used when settings.micMode === "hold")
  const onMicPressIn = () => {
    if (mode === "reviewing") {
      // Press during review = discard, then start hold-to-talk
      discardDraft();
      setTimeout(() => startInitialListening(), 100);
      return;
    }
    if (mode === "idle") startInitialListening();
  };
  const onMicPressOut = () => {
    if (mode === "listening") stopInitialListening();
  };

  const handleSend = useCallback(() => {
    clearCountdown();
    const text = input.trim();
    if (!text || streaming) return;
    // Save to history
    if (inputHistory.current[0] !== text) {
      inputHistory.current = [text, ...inputHistory.current].slice(0, 50);
    }
    historyIdx.current = -1;
    onSend(text);
    setInput("");
    AsyncStorage.removeItem(DRAFT_KEY);
  }, [input, streaming, clearCountdown, onSend]);

  const handleInputChange = (text: string) => {
    clearCountdown();
    historyIdx.current = -1;
    setInput(text);
    saveDraft(text);
  };

  const cycleHistory = useCallback((dir: 1 | -1) => {
    const hist = inputHistory.current;
    if (hist.length === 0) return;
    const next = historyIdx.current + dir;
    if (next < -1) return;
    if (next >= hist.length) return;
    historyIdx.current = next;
    setInput(next === -1 ? "" : hist[next]);
  }, []);

  // Slash command rail — always visible when commands exist for the session's CLI.
  // When the user types `/`, the rail filters to matching commands.
  const slashCommands = sessionCli ? (SLASH_COMMANDS[sessionCli] ?? []) : [];
  const availableCmdNames = slashCommands.map((c) => c.cmd);
  const railCommands = input.startsWith("/")
    ? slashCommands.filter((c) => c.cmd.startsWith(input.split(" ")[0]))
    : slashCommands;
  const showRail = railCommands.length > 0 && !listening;

  // Intent-based suggestions for the review card
  const intentSuggestions = reviewing
    ? suggestCommands(input, availableCmdNames)
    : [];

  const applyCommand = (cmd: string) => {
    // If user already typed a slash prefix, replace it; otherwise prefix it.
    const trimmed = input.trim();
    if (trimmed.startsWith("/")) {
      const rest = trimmed.split(" ").slice(1).join(" ");
      setInput(rest ? `${cmd} ${rest}` : `${cmd} `);
    } else {
      setInput(trimmed ? `${cmd} ${trimmed}` : `${cmd} `);
    }
    Haptics.selectionAsync();
  };

  const [peekPath, setPeekPath] = useState<string | null>(null);
  const [expandedToolIdx, setExpandedToolIdx] = useState<number | null>(null);

  // Copy-confirmation toast: shown briefly after any copy action.
  const copyToastOpacity = useRef(new Animated.Value(0)).current;
  const copyToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashCopied = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (copyToastTimer.current) clearTimeout(copyToastTimer.current);
    Animated.timing(copyToastOpacity, { toValue: 1, duration: 120, useNativeDriver: true }).start();
    copyToastTimer.current = setTimeout(() => {
      Animated.timing(copyToastOpacity, { toValue: 0, duration: 280, useNativeDriver: true }).start();
    }, 1100);
  }, [copyToastOpacity]);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(COPIED_EVENT, flashCopied);
    return () => sub.remove();
  }, [flashCopied]);

  const showTyping = streaming && messages[messages.length - 1]?.role !== "assistant";
  // currentTool live indicator: only show if the last message isn't already a tool card
  const lastMsg = messages[messages.length - 1];
  const showLiveTool = currentTool && lastMsg?.role !== "tool";
  const data: (DiktatMessage | { role: "typing" } | { role: "tool"; name: string })[] = [
    ...messages,
    ...(showLiveTool ? [{ role: "tool" as const, name: currentTool! }] : []),
    ...(showTyping && !showLiveTool ? [{ role: "typing" as const }] : []),
  ];

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {sessionLabel ?? "Session"}
        </Text>
        <View style={styles.headerRight}>
          {streaming && activeSessionId ? (
            <TouchableOpacity onPress={() => onCancel(activeSessionId)} style={styles.cancelButton}>
              <Text style={styles.cancelText}>Stop</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={() => setSettingsOpen(true)} style={styles.settingsBtn}>
              <Text style={styles.settingsIcon}>⚙</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {reconnecting ? (
        <View style={styles.reconnectingBanner}>
          <Text style={styles.reconnectingText}>Reconnecting…</Text>
          {onRetryConnect ? (
            <TouchableOpacity
              onPress={() => { Haptics.selectionAsync(); onRetryConnect(); }}
              style={styles.reconnectingRetry}
              activeOpacity={0.7}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={styles.reconnectingRetryText}>Retry</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {/* Message list */}
      <View style={{ flex: 1 }}>
        <ScrollView
          ref={listRef}
          contentContainerStyle={styles.messages}
          keyboardDismissMode="on-drag"
          onLayout={({ nativeEvent }) => {
            viewportHeight.current = nativeEvent.layout.height;
          }}
          onScroll={({ nativeEvent: { layoutMeasurement, contentOffset, contentSize } }) => {
            const threshold = streamingRef.current ? 240 : 60;
            const atBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - threshold;
            setIsAtBottom(atBottom);
            isAtBottomRef.current = atBottom;
            if (atBottom) userScrolledAwayRef.current = false;
            if (streamingRef.current && !atBottom) userScrolledAwayRef.current = true;
          }}
          onContentSizeChange={(_w, contentHeight) => {
            if (wantScrollToBottom.current) {
              // Exact offset: content height minus viewport height, clamped to 0.
              // This is deterministic — no stale refs, no race with partial layouts.
              const offset = Math.max(0, contentHeight - viewportHeight.current);
              listRef.current?.scrollTo({ y: offset, animated: false });
              wantScrollToBottom.current = false;
              isAtBottomRef.current = true;
              return;
            }
            if (streamingRef.current && !userScrolledAwayRef.current) {
              listRef.current?.scrollTo({ y: 99999, animated: false });
            }
          }}
          scrollEventThrottle={100}
        >
          {data.length === 0 ? (
            historyLoading ? (
              // History is in-flight — show a subtle loader rather than the
              // "Session ready" placeholder, which would flash and then vanish.
              <View style={styles.historyLoadingContainer}>
                <ActivityIndicator color={colors.textMuted} size="small" />
              </View>
            ) : (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyTitle}>Session ready</Text>
                <Text style={styles.emptyHint}>Tap the mic and describe what you want to build, fix, or change.</Text>
                <View style={styles.emptyExamples}>
                  {EXAMPLE_PROMPTS.map((p) => (
                    <TouchableOpacity
                      key={p}
                      style={styles.emptyExampleChip}
                      onPress={() => {
                        Haptics.selectionAsync();
                        onSend(p);
                      }}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.emptyExampleText}>{p}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )
          ) : data.map((item, index) => {
            if (item.role === "typing") {
              return (
                <View key={`typing-${index}`} style={[bubbleStyles.row, bubbleStyles.assistantRow]}>
                  <View style={styles.typingBubble}>
                    <TypingIndicator />
                  </View>
                </View>
              );
            }
            if (item.role === "tool") {
              const toolItem = item as DiktatMessage & { name?: string };
              const toolStr = toolItem.toolName ?? toolItem.name ?? "";
              const { label, icon } = formatToolLabel(toolStr);
              const fullPath = (toolItem as DiktatMessage).toolPath;
              const isLive = !toolItem.toolName;
              const tm = toolItem as DiktatMessage;
              const hasPreview = !!(tm.toolDiff || tm.toolPreview || tm.toolCommand || tm.toolResult);
              const expanded = expandedToolIdx === index;
              return (
                <View key={`tool-${index}`} style={[bubbleStyles.row, bubbleStyles.assistantRow]}>
                  <TouchableOpacity
                    style={styles.toolBubble}
                    onPress={() => {
                      if (hasPreview) {
                        Haptics.selectionAsync();
                        setExpandedToolIdx(expanded ? null : index);
                      } else if (fullPath) {
                        Haptics.selectionAsync();
                        setPeekPath(fullPath);
                      }
                    }}
                    activeOpacity={hasPreview || fullPath ? 0.6 : 1}
                  >
                    <Text style={styles.toolIcon}>{icon}</Text>
                    <Text style={styles.toolText} numberOfLines={1} ellipsizeMode="middle">
                      {label}{isLive ? "…" : ""}
                    </Text>
                    {hasPreview ? (
                      <Text style={styles.toolChevron}>{expanded ? "▾" : "▸"}</Text>
                    ) : fullPath ? (
                      <Text style={styles.toolChevron}>›</Text>
                    ) : null}
                  </TouchableOpacity>
                  {expanded && hasPreview ? (
                    <ToolPreviewDrawer message={tm} onCopy={emitCopied} />
                  ) : null}
                </View>
              );
            }
            const msg = item as DiktatMessage;
            return (
              <MessageBubble
                key={`msg-${index}`}
                message={msg}
                ttsEnabled={settings.ttsEnabled && msg.role === "assistant"}
                isSpeaking={speakingIdx === index}
                onSpeak={() => toggleSpeak(index, msg.text)}
              />
            );
          })}
        </ScrollView>

        {/* Top fade — older messages dissolve upward */}
        <LinearGradient
          colors={[colors.bg, "transparent"]}
          style={styles.fadeTop}
          pointerEvents="none"
        />

        {/* Scroll-to-bottom button */}
        {!isAtBottom && (
          <TouchableOpacity
            style={styles.scrollToBottom}
            onPress={() => listRef.current?.scrollToEnd({ animated: true })}
          >
            <Text style={styles.scrollToBottomIcon}>↓</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Review card — replaces rail + input row when reviewing */}
      {reviewing ? (
        <View style={styles.reviewCard}>
          {/* Countdown progress bar at the top edge */}
          <Animated.View
            style={[
              styles.reviewProgress,
              {
                width: countdownProgress.interpolate({
                  inputRange: [0, 1],
                  outputRange: ["0%", "100%"],
                }),
              },
            ]}
          />

          {/* Transcript — scrollable for long dictations; hint below is tap-to-edit */}
          <ScrollView
            style={styles.reviewTranscriptScroll}
            contentContainerStyle={styles.reviewTranscriptContent}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.reviewText} selectable>{input}</Text>
          </ScrollView>
          <TouchableOpacity activeOpacity={0.7} onPress={editDraft}>
            <Text style={styles.reviewEditHint}>
              {autoSendDuration === 0
                ? "Manual mode · tap Send when ready"
                : "tap to edit · say \"send\" or \"cancel\""}
            </Text>
          </TouchableOpacity>

          {/* Intent suggestions — highlighted chips */}
          {intentSuggestions.length > 0 && (
            <View style={styles.suggestionRow}>
              {intentSuggestions.map((cmd) => (
                <TouchableOpacity
                  key={cmd}
                  style={styles.suggestionChip}
                  onPress={() => prefixSlash(cmd)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.suggestionText}>✨ {cmd}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Modifier chips */}
          {slashCommands.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.reviewChipsContent}
              keyboardShouldPersistTaps="always"
              style={styles.reviewChipsRow}
            >
              {slashCommands.map((c) => (
                <TouchableOpacity
                  key={c.cmd}
                  style={styles.reviewChip}
                  onPress={() => prefixSlash(c.cmd)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.reviewChipText}>{c.cmd}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {/* Action buttons */}
          <View style={styles.reviewActions}>
            <TouchableOpacity
              style={[styles.reviewActionBtn, styles.reviewCancelBtn]}
              onPress={discardDraft}
              activeOpacity={0.7}
            >
              <Text style={styles.reviewCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.reviewActionBtn, styles.reviewSendBtn]}
              onPress={sendDraft}
              activeOpacity={0.85}
            >
              <Text style={styles.reviewSendText}>Send ↑</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <>
          {/* Idle suggestions — fade in after 30s of no activity */}
          {showIdle && (
            <Animated.View style={[styles.idleRow, { opacity: idleOpacity }]}>
              {buildIdleSuggestions(
                [...messages].reverse().find((m) => m.role === "assistant")?.text,
              ).map((suggestion, i) => (
                <TouchableOpacity
                  key={i}
                  style={styles.idleChip}
                  onPress={() => {
                    idleOpacity.setValue(0);
                    setShowIdle(false);
                    onSend(suggestion);
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={styles.idleChipText}>{suggestion}</Text>
                </TouchableOpacity>
              ))}
            </Animated.View>
          )}

          {/* Command rail — horizontal scrollable chips */}
          {showRail && (
            <View style={styles.rail}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.railContent}
                keyboardShouldPersistTaps="always"
              >
                {railCommands.map((c) => (
                  <TouchableOpacity
                    key={c.cmd}
                    style={styles.chip}
                    onPress={() => applyCommand(c.cmd)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.chipCmd}>{c.cmd}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <LinearGradient
                colors={["transparent", colors.bg]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={styles.railFade}
                pointerEvents="none"
              />
            </View>
          )}

          {/* Input area */}
          <View style={styles.inputRow}>
            <TouchableOpacity
              style={[styles.micButton, listening && styles.micButtonActive]}
              onPress={settings.micMode === "toggle" ? toggleListening : undefined}
              onPressIn={settings.micMode === "hold" ? onMicPressIn : undefined}
              onPressOut={settings.micMode === "hold" ? onMicPressOut : undefined}
              disabled={streaming}
              activeOpacity={0.7}
            >
              <Text style={styles.micIcon}>
                {listening ? "🔴" : "🎙"}
              </Text>
            </TouchableOpacity>

            <View style={styles.inputWrap}>
              {listening ? (
                <View style={styles.listeningBox}>
                  <VoiceWaveform />
                  {input ? <Text style={styles.listeningText} numberOfLines={1}>{input}</Text> : null}
                </View>
              ) : (
                <TextInput
                  ref={inputRef}
                  style={styles.input}
                  value={input}
                  onChangeText={handleInputChange}
                  placeholder="Message…"
                  placeholderTextColor="#444"
                  multiline
                  editable={!streaming}
                  returnKeyType="default"
                  autoCorrect={false}
                  autoCapitalize="none"
                  spellCheck={false}
                />
              )}
            </View>

            <TouchableOpacity
              style={[styles.sendButton, (!input.trim() || streaming) && styles.sendDisabled]}
              onPress={handleSend}
              disabled={!input.trim() || streaming}
            >
              <Text style={styles.sendIcon}>↑</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Copy confirmation toast */}
      <Animated.View
        pointerEvents="none"
        style={[styles.copyToast, { opacity: copyToastOpacity }]}
      >
        <Text style={styles.copyToastText}>Copied</Text>
      </Animated.View>

      {/* Settings sheet */}
      <SettingsSheet
        visible={settingsOpen}
        settings={settings}
        onUpdate={updateSettings}
        onClose={() => setSettingsOpen(false)}
      />

      {/* File path peek modal */}
      {peekPath ? (
        <TouchableOpacity
          style={styles.peekOverlay}
          activeOpacity={1}
          onPress={() => setPeekPath(null)}
        >
          <View style={styles.peekCard}>
            <Text style={styles.peekLabel}>File path</Text>
            <Text style={styles.peekPath}>{peekPath}</Text>
            <TouchableOpacity
              onPress={() => { Clipboard.setStringAsync(peekPath); emitCopied(); setPeekPath(null); }}
              style={styles.peekCopy}
            >
              <Text style={styles.peekCopyText}>Copy path</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      ) : null}
    </KeyboardAvoidingView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingTop: 56, paddingBottom: 14, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: colors.borderFaint,
  },
  backButton: { padding: 4, marginRight: 10 },
  backText: { color: colors.accent, fontSize: 22 },
  headerTitle: { flex: 1, fontFamily: fonts.bodySemi, color: colors.text, fontSize: 15 },
  headerRight: { minWidth: 48, alignItems: "flex-end" },
  cancelButton: {
    backgroundColor: colors.accentFaint, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 5,
    borderWidth: 1, borderColor: colors.accentDim,
  },
  cancelText: { fontFamily: fonts.bodyMedium, color: colors.error, fontSize: 12 },
  settingsBtn: { padding: 6 },
  settingsIcon: { color: colors.textSub, fontSize: 18 },
  reconnectingBanner: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12,
    backgroundColor: colors.accentFaint, paddingVertical: 5, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  reconnectingText: { fontFamily: fonts.body, color: colors.accent, fontSize: 11 },
  reconnectingRetry: {
    borderWidth: 1, borderColor: colors.accent, borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 1,
  },
  reconnectingRetryText: { fontFamily: fonts.bodySemi, color: colors.accent, fontSize: 11 },
  messages: { padding: 14, paddingBottom: 8 },
  historyLoadingContainer: { alignItems: "center", marginTop: 100 },
  emptyContainer: { alignItems: "center", marginTop: 100, paddingHorizontal: 48 },
  emptyTitle: { fontFamily: fonts.bodySemi, color: colors.textSub, fontSize: 15, marginBottom: 8 },
  emptyHint: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 13, textAlign: "center", lineHeight: 20 },
  emptyExamples: {
    marginTop: 22,
    gap: 8,
    alignSelf: "stretch",
  },
  emptyExampleChip: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: "center",
  },
  emptyExampleText: {
    fontFamily: fonts.body,
    color: colors.textSub,
    fontSize: 13,
  },

  typingBubble: { paddingHorizontal: 12, paddingVertical: 10 },

  toolBubble: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: colors.accentFaint, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6,
    borderWidth: 1, borderColor: colors.accentDim,
    alignSelf: "flex-start",
  },
  toolIcon: { fontSize: 11 },
  toolText: { fontFamily: fonts.bodyMedium, color: colors.accentBright, fontSize: 12, flex: 1 },
  toolChevron: { color: colors.textSub, fontSize: 14, marginLeft: 4 },

  copyToast: {
    position: "absolute",
    top: 110, alignSelf: "center", left: 0, right: 0,
    alignItems: "center",
  },
  copyToastText: {
    fontFamily: fonts.bodySemi,
    color: "#fff",
    fontSize: 12,
    backgroundColor: "rgba(0,0,0,0.78)",
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: 14,
    overflow: "hidden",
  },
  peekOverlay: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end",
  },
  peekCard: {
    backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 24, paddingBottom: 40, borderTopWidth: 1, borderColor: colors.border,
  },
  peekLabel: { fontFamily: fonts.bodyMedium, color: colors.textSub, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 },
  peekPath: { fontFamily: fonts.mono, color: colors.text, fontSize: 13, lineHeight: 20, marginBottom: 16 },
  peekCopy: { backgroundColor: colors.input, borderRadius: 10, padding: 12, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  peekCopyText: { fontFamily: fonts.bodySemi, color: colors.accent, fontSize: 14 },

  fadeTop: {
    position: "absolute", top: 0, left: 0, right: 0, height: 72,
  },

  scrollToBottom: {
    position: "absolute", bottom: 12, right: 14,
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    justifyContent: "center", alignItems: "center",
    shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
  },
  scrollToBottomIcon: { color: colors.textSub, fontSize: 15 },

  rail: {
    position: "relative",
    paddingTop: 8,
    paddingBottom: 6,
    backgroundColor: colors.bg,
  },
  railContent: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingRight: 36, // leave room for the fade
  },
  railFade: {
    position: "absolute",
    top: 0, bottom: 0, right: 0,
    width: 32,
  },
  chip: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    height: 30,
    justifyContent: "center",
  },
  idleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
  },
  idleChip: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  idleChipText: {
    fontFamily: fonts.body,
    color: colors.textSub,
    fontSize: 13,
  },
  chipCmd: {
    fontFamily: fonts.bodyMedium,
    color: colors.accent,
    fontSize: 13,
  },

  inputRow: {
    flexDirection: "row", alignItems: "flex-end",
    paddingHorizontal: 10, paddingTop: 8, paddingBottom: 32,
    borderTopWidth: 1, borderTopColor: colors.borderFaint,
    backgroundColor: colors.bg, gap: 6,
  },
  inputWrap: { flex: 1 },
  input: {
    fontFamily: fonts.body,
    backgroundColor: colors.card, color: colors.text,
    borderRadius: 22, paddingHorizontal: 14, paddingVertical: 11,
    fontSize: 15, maxHeight: 120, lineHeight: 21,
    borderWidth: 1, borderColor: colors.border,
  },
  listeningBox: {
    backgroundColor: colors.accentFaint, borderRadius: 22,
    paddingHorizontal: 14, paddingVertical: 11,
    borderWidth: 1, borderColor: colors.accentDim,
    minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10,
  },
  listeningText: { fontFamily: fonts.body, color: colors.accent, fontSize: 14, flex: 1 },

  micButton: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.card, justifyContent: "center", alignItems: "center",
    borderWidth: 1, borderColor: colors.border,
  },
  micButtonActive: { backgroundColor: colors.accentFaint, borderColor: colors.accentDim },
  micIcon: { fontSize: 18 },

  sendButton: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.accent, justifyContent: "center", alignItems: "center",
  },
  sendDisabled: { opacity: 0.2 },
  sendIcon: { color: "#fff", fontSize: 17, fontWeight: "700" },

  // ─── Review card ─────────────────────────────────────────────────────────
  reviewCard: {
    backgroundColor: colors.card,
    borderTopWidth: 1, borderTopColor: colors.border,
    paddingTop: 14,
    paddingHorizontal: 18,
    paddingBottom: 32,
    position: "relative",
  },
  reviewProgress: {
    position: "absolute",
    top: 0, left: 0,
    height: 3,
    backgroundColor: colors.accent,
  },
  reviewTranscriptScroll: {
    maxHeight: 180,
    marginTop: 4,
    marginBottom: 6,
  },
  reviewTranscriptContent: {
    paddingBottom: 2,
  },
  reviewText: {
    fontFamily: fonts.body,
    color: colors.text,
    fontSize: 17,
    lineHeight: 24,
  },
  reviewEditHint: {
    fontFamily: fonts.body,
    color: colors.textMuted,
    fontSize: 11,
    marginBottom: 10,
  },
  suggestionRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
    flexWrap: "wrap",
  },
  suggestionChip: {
    backgroundColor: colors.accentFaint,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  suggestionText: {
    fontFamily: fonts.bodySemi,
    color: colors.accent,
    fontSize: 12,
  },
  reviewChipsRow: {
    maxHeight: 38,
    marginBottom: 12,
  },
  reviewChipsContent: {
    flexDirection: "row",
    gap: 8,
    paddingRight: 16,
  },
  reviewChip: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 5,
    justifyContent: "center",
  },
  reviewChipText: {
    fontFamily: fonts.bodyMedium,
    color: colors.accent,
    fontSize: 12,
  },
  reviewActions: {
    flexDirection: "row",
    gap: 10,
  },
  reviewActionBtn: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  reviewCancelBtn: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  reviewCancelText: {
    fontFamily: fonts.bodyMedium,
    color: colors.textSub,
    fontSize: 15,
  },
  reviewSendBtn: {
    backgroundColor: colors.accent,
    flex: 1.5,
  },
  reviewSendText: {
    fontFamily: fonts.bodySemi,
    color: "#fff",
    fontSize: 15,
  },
});

const bubbleStyles = StyleSheet.create({
  row: { marginBottom: 8, maxWidth: "85%" },
  userRow: { alignSelf: "flex-end" },
  assistantRow: { alignSelf: "flex-start", maxWidth: "94%" },
  bubble: { borderRadius: 18 },
  userBubble: {
    backgroundColor: colors.userBubble,
    borderBottomRightRadius: 5,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  assistantBubble: {
    paddingLeft: 12, paddingRight: 2, paddingVertical: 2,
    borderLeftWidth: 2, borderLeftColor: colors.border,
  },
  assistantText: { fontFamily: fonts.body, color: colors.text, fontSize: 15, lineHeight: 22 },
  userText: { fontFamily: fonts.body, color: "#fff", fontSize: 15, lineHeight: 22 },
  speakerBtn: {
    marginTop: 4,
    marginLeft: 14,
    alignSelf: "flex-start",
    paddingVertical: 2,
    paddingHorizontal: 0,
  },
  speakerIcon: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.textMuted,
  },
});

const markdownStyles: any = {
  body: { fontFamily: fonts.body, color: colors.text, fontSize: 15, lineHeight: 24 },
  code_inline: {
    backgroundColor: colors.card, color: "#c9d1d9",
    fontFamily: fonts.mono, fontSize: 13, borderRadius: 4,
  },
  link: { color: colors.accent },
  strong: { fontFamily: fonts.bodyBold, color: colors.text },
  em: { color: colors.textSub },
  heading1: { fontFamily: fonts.display, color: colors.text, fontSize: 20, marginBottom: 8, marginTop: 4 },
  heading2: { fontFamily: fonts.display, color: colors.text, fontSize: 17, marginBottom: 6, marginTop: 2 },
  heading3: { fontFamily: fonts.bodySemi, color: colors.textSub, fontSize: 15, marginBottom: 4 },
  blockquote: { borderLeftColor: colors.border, borderLeftWidth: 3, paddingLeft: 10, opacity: 0.75 },
  bullet_list: { marginLeft: 4 },
  ordered_list: { marginLeft: 4 },
  list_item: { color: colors.text, marginBottom: 2 },
  hr: { backgroundColor: colors.border, height: 1 },
  fence: { marginVertical: 4 },
};

const typingStyles = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.textSub },
});

const codeBlockStyles = StyleSheet.create({
  wrapper: { marginVertical: 6, position: "relative" },
  scroll: { backgroundColor: "#161b22", borderRadius: 8 },
  content: { padding: 12 },
  text: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12, lineHeight: 18, color: "#c9d1d9",
  },
  copyBtn: {
    position: "absolute", top: 6, right: 8,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3,
  },
  copyBtnText: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 10, color: "#8b949e",
  },
});

const toolDrawerStyles = StyleSheet.create({
  container: {
    marginTop: 6,
    marginLeft: 4,
    alignSelf: "stretch",
    gap: 8,
  },
  block: {
    backgroundColor: "#0d1117",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#21262d",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#21262d",
  },
  headerLabel: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 10,
    color: "#7d8590",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  copyText: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 10,
    color: "#58a6ff",
  },
  bodyScrollV: { maxHeight: 320 },
  bodyContent: { padding: 10 },
  line: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 11,
    lineHeight: 16,
  },
  lineCtx: { color: "#c9d1d9" },
  lineAdd: { color: "#7ee787", backgroundColor: "rgba(46,160,67,0.12)" },
  lineDel: { color: "#ffa198", backgroundColor: "rgba(248,81,73,0.12)" },
  lineHunk: { color: "#8b949e" },
  truncated: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: "#7d8590",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: "#21262d",
  },
});

const waveStyles = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "center", gap: 3, height: 24 },
  bar: { width: 3, borderRadius: 2, backgroundColor: colors.accent },
});
