import { useState, useRef, useEffect, useCallback, memo } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet,
  TextInput, KeyboardAvoidingView, Platform, Animated,
  ScrollView, DeviceEventEmitter, ActivityIndicator, Keyboard,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Markdown from "react-native-markdown-display";
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import Reanimated, { FadeIn, FadeInDown, FadeInUp, FadeOut, SlideInDown, ZoomIn, useReducedMotion, useSharedValue, useAnimatedStyle, withTiming, withRepeat } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import * as Localization from "expo-localization";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import type { DiktatMessage, AgentSelectionMap, PermissionModeId, RunSummary, StatsTotals } from "../hooks/useDiktat";
import { useSettings } from "../hooks/useSettings";
import {
  buildContextualStrings, detectSlashCommand,
} from "../utils/voice";
import { formatToolLabel } from "../utils/tools";
import { computeRunStats, formatRunDuration, type RunStats } from "../utils/runStats";
import { SettingsSheet } from "../components/SettingsSheet";
import { colors, fonts } from "../theme";

const DRAFT_KEY = "diktat:draft";

// Composer permission labels (compact pill text) + fallback list.
const PERMISSION_LABEL: Record<string, string> = { plan: "Plan", auto: "Auto", full: "Full access" };
const PERMISSION_FALLBACK: { id: PermissionModeId; label: string }[] = [
  { id: "plan", label: "Plan · read-only" },
  { id: "auto", label: "Auto-accept edits" },
  { id: "full", label: "Full access" },
];

// Caret that rotates 180° when its selector is open. Replaces the old "▾" text
// glyph (which sat off the text baseline) with a properly-centered icon.
function SelectorCaret({ open, reducedMotion }: { open: boolean; reducedMotion: boolean }) {
  const rot = useSharedValue(open ? 1 : 0);
  rot.value = reducedMotion ? (open ? 1 : 0) : withTiming(open ? 1 : 0, { duration: 160 });
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value * 180}deg` }] }));
  return (
    <Reanimated.View style={style}>
      <Ionicons name="chevron-down" size={13} color={colors.textSub} />
    </Reanimated.View>
  );
}

// Softly pulsing dot — signals the reconnecting banner is live/working.
function PulsingDot({ reducedMotion }: { reducedMotion: boolean }) {
  const pulse = useSharedValue(0.4);
  useEffect(() => {
    pulse.value = reducedMotion ? 1 : withRepeat(withTiming(1, { duration: 700 }), -1, true);
  }, [reducedMotion, pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return <Reanimated.View style={[styles.reconnectingDot, style]} />;
}

const EXAMPLE_PROMPTS = [
  "What's in this codebase?",
  "Run the tests and tell me what fails",
  "Suggest a small improvement",
];

const COPIED_EVENT = "diktat:copied";
const emitCopied = () => DeviceEventEmitter.emit(COPIED_EVENT);

// ─── Slash commands ──────────────────────────────────────────────────────────

const SLASH_COMMANDS: Record<string, Array<{ cmd: string; description: string }>> = {
  cursor: [
    { cmd: "/plan",     description: "Switch to plan mode" },
    { cmd: "/ask",      description: "Read-only exploration" },
    { cmd: "/auto-run", description: "Toggle auto-run" },
    { cmd: "/compact",  description: "Compact the context" },
    { cmd: "/model",    description: "Set model" },
  ],
  claude: [
    { cmd: "/clear",    description: "Clear context" },
    { cmd: "/compact",  description: "Compact context" },
    { cmd: "/model",    description: "Set model" },
  ],
};

// ─── Voice waveform ──────────────────────────────────────────────────────────

function VoiceWaveform() {
  const reducedMotion = useReducedMotion();
  const bars = [
    useRef(new Animated.Value(0.3)).current,
    useRef(new Animated.Value(0.6)).current,
    useRef(new Animated.Value(0.4)).current,
    useRef(new Animated.Value(0.8)).current,
    useRef(new Animated.Value(0.5)).current,
  ];

  useEffect(() => {
    if (reducedMotion) return; // static bars are signal enough
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
  }, [reducedMotion]);

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
  const reducedMotion = useReducedMotion();
  const dots = [
    useRef(new Animated.Value(0.6)).current,
    useRef(new Animated.Value(0.6)).current,
    useRef(new Animated.Value(0.6)).current,
  ];
  useEffect(() => {
    if (reducedMotion) return;
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
  }, [reducedMotion]);
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

// ─── Streaming caret ─────────────────────────────────────────────────────────
// Terminal-style block cursor breathing at the tail of the streaming message.

function StreamingCaret() {
  const reducedMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reducedMotion) return; // steady caret, no blink
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.15, duration: 550, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 550, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reducedMotion]);
  return <Animated.Text style={[caretStyles.caret, { opacity }]}>▍</Animated.Text>;
}

const caretStyles = StyleSheet.create({
  caret: { color: colors.accent, fontSize: 15, lineHeight: 22, paddingLeft: 12 },
});

// ─── Message bubble ──────────────────────────────────────────────────────────

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

// Memoized: every streamed token replaces the messages array, but only the
// last bubble's object identity changes — without memo every earlier bubble
// re-renders (including a full Markdown re-parse) on each token.
const MessageBubble = memo(function MessageBubble({
  message,
  streamingTail = false,
}: {
  message: DiktatMessage;
  /** True for the last assistant bubble while output is streaming — shows the caret. */
  streamingTail?: boolean;
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
        accessibilityLabel={`You said: ${message.text}`}
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
        {streamingTail ? <StreamingCaret /> : null}
      </View>
    </TouchableOpacity>
  );
});

// On Fabric (New Architecture), a horizontal ScrollView with no explicit height
// inside a vertical ScrollView inflates to the outer viewport height. Setting
// `height` on a plain View wrapper (not on the ScrollView itself) is what Fabric
// respects for the outer content flow measurement, so we pre-compute height from
// line count and apply it to the wrapper.
function FenceCodeBlock({ nodeKey, content }: { nodeKey: string; content: string }) {
  const trimmed = (content ?? "").trimEnd();
  const lineCount = (trimmed.match(/\n/g) ?? []).length + 1;
  const codeHeight = lineCount * 18 + 24; // lineHeight * lines + padding top+bottom
  return (
    <View style={[codeBlockStyles.wrapper, { height: codeHeight }]}>
      <ScrollView
        horizontal
        style={codeBlockStyles.scroll}
        contentContainerStyle={codeBlockStyles.content}
        showsHorizontalScrollIndicator={false}
      >
        <Text style={codeBlockStyles.text}>{trimmed}</Text>
      </ScrollView>
      <TouchableOpacity
        style={codeBlockStyles.copyBtn}
        onPress={() => {
          Clipboard.setStringAsync(trimmed);
          emitCopied();
        }}
        activeOpacity={0.7}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Text style={codeBlockStyles.copyBtnText}>copy</Text>
      </TouchableOpacity>
    </View>
  );
}

// Markdown rules — all use plain RN components (no HTML elements like <code>/<span>
// which crash on the new architecture)
const markdownRules = {
  code_inline: (node: any, _c: any, _p: any, styles_: any) => (
    <Text key={node.key} style={styles_.code_inline}>{node.content}</Text>
  ),
  fence: (node: any) => <FenceCodeBlock key={node.key} nodeKey={node.key} content={node.content} />,
};

// ─── Props ───────────────────────────────────────────────────────────────────

type Props = {
  messages: DiktatMessage[];
  streaming: boolean;
  currentTool: string | null;
  reconnecting: boolean;
  historyLoading: boolean;
  /** True while older messages exist to page in ("scroll up to load more"). */
  historyHasMore?: boolean;
  /** True while a page request is in flight. */
  historyPaging?: boolean;
  /** Request the page of messages just before the ones currently shown. */
  onLoadMore?: () => void;
  activeSessionId: string | null;
  sessionCli?: string;
  agents?: AgentSelectionMap;
  // Returns false when the message couldn't be delivered (socket not open) so
  // the composer keeps the draft; void/true means sent.
  onSend: (text: string, opts?: { model?: string; permissionMode?: PermissionModeId }) => boolean | void;
  onCancel: (sessionId: string) => void;
  onBack: () => void;
  onRetryConnect?: () => void;
  sessionLabel?: string;
  /** Authoritative summary of the latest run (from the daemon's exit frame). */
  lastRunSummary?: RunSummary | null;
  /** Persisted totals for this session, if any. */
  sessionStats?: StatsTotals | null;
};

// ─── Main component ──────────────────────────────────────────────────────────

export function ChatScreen({
  messages, streaming, currentTool, reconnecting, historyLoading,
  historyHasMore, historyPaging, onLoadMore,
  activeSessionId, sessionCli, agents, onSend, onCancel, onBack, onRetryConnect, sessionLabel,
  lastRunSummary, sessionStats,
}: Props) {
  type Mode = "idle" | "listening" | "reviewing";
  const [input, setInput] = useState("");
  // Composer model + permission selectors (desktop-style). Apply per-turn.
  const agentOpts = (sessionCli && agents?.[sessionCli]) || undefined;
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedPermission, setSelectedPermission] = useState<PermissionModeId>("auto");
  const [selectorOpen, setSelectorOpen] = useState<"model" | "perm" | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  // Reset selectors to defaults when the session/CLI changes.
  useEffect(() => {
    setSelectedModel("");
    setSelectedPermission("auto");
    setSelectorOpen(null);
  }, [activeSessionId, sessionCli]);
  const sendWithOpts = useCallback(
    (text: string) => onSend(text, { model: selectedModel || undefined, permissionMode: selectedPermission }),
    [onSend, selectedModel, selectedPermission],
  );
  const [mode, setMode] = useState<Mode>("idle");
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const userScrolledAwayRef = useRef(false);
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { settings, update: updateSettings } = useSettings();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  // Index from which message-entry animations play. History loads en masse and
  // must NOT animate; only messages appended after the initial load spring in.
  const animateFromIdx = useRef(Number.MAX_SAFE_INTEGER);
  const baselineSet = useRef(false);

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
  // When paging in older messages we prepend content, which grows the list at
  // the top and would visually jump the viewport. Capture the pre-prepend
  // height + offset here so onContentSizeChange can re-anchor to what the user
  // was reading (new scrollY = oldOffset + heightDelta).
  const pendingAnchorRef = useRef<{ prevHeight: number; prevOffset: number } | null>(null);
  const inputRef = useRef<TextInput>(null);
  const prevStreaming = useRef(streaming);
  const inputHistory = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const runStartIdx = useRef(0);
  const runStartAt = useRef(0);
  const [lastRun, setLastRun] = useState<(RunStats & { durationMs: number }) | null>(null);
  const [runDismissed, setRunDismissed] = useState(false);

  const listening = mode === "listening";
  const reviewing = mode === "reviewing";

  // Last-run card source: prefer the daemon's authoritative summary (true
  // pass/fail + exact diffs); fall back to the client-derived stats for older
  // daemons that don't send a summary on the exit frame.
  const runCard = lastRunSummary
    ? {
        files: lastRunSummary.filesChanged.length, added: lastRunSummary.linesAdded,
        removed: lastRunSummary.linesRemoved, commands: lastRunSummary.commandsRun,
        durationMs: lastRunSummary.durationMs, ok: lastRunSummary.exitCode === 0,
        testStatus: lastRunSummary.testStatus,
      }
    : lastRun
    ? {
        files: lastRun.files, added: lastRun.added, removed: lastRun.removed,
        commands: lastRun.commands, durationMs: lastRun.durationMs,
        ok: undefined as boolean | undefined, testStatus: "none" as "pass" | "fail" | "none",
      }
    : null;

  // Run-boundary tracking: capture the message index + clock at run start, then
  // derive a compact "last run" summary (files/edits/cmds/lines/duration) from
  // the messages that arrived during the run. Purely client-side — OTA only.
  useEffect(() => {
    if (!prevStreaming.current && streaming) {
      // Run started — clear any prior summary and mark the boundary.
      runStartIdx.current = messages.length;
      runStartAt.current = Date.now();
      setLastRun(null);
      setRunDismissed(false);
    } else if (prevStreaming.current && !streaming && messages.length > 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const stats = computeRunStats(messages.slice(runStartIdx.current));
      if (stats) setLastRun({ ...stats, durationMs: Date.now() - runStartAt.current });
    }
    prevStreaming.current = streaming;
  }, [streaming]);

  // Live "working now" clock: tick once a second while streaming so the header
  // shows elapsed time. Declared after the run-boundary effect so runStartAt is
  // already set for the current commit. Reset to 0 when the turn ends.
  const [liveElapsed, setLiveElapsed] = useState(0);
  useEffect(() => {
    if (!streaming) { setLiveElapsed(0); return; }
    const started = runStartAt.current || Date.now();
    setLiveElapsed(Date.now() - started);
    const id = setInterval(() => setLiveElapsed(Date.now() - started), 1000);
    return () => clearInterval(id);
  }, [streaming]);

  // Running tally for the header, derived live from this turn's messages via the
  // same helper the last-run card uses (null until an edit/command lands).
  const liveStats = streaming ? computeRunStats(messages.slice(runStartIdx.current)) : null;

  // Use refs to avoid stale closures — handlers reference *current* state
  const inputRef2 = useRef(input);
  inputRef2.current = input;

  const stopAllVoice = useCallback(() => {
    try { ExpoSpeechRecognitionModule.abort(); } catch { /* not running */ }
  }, []);

  const sendDraft = useCallback(() => {
    stopAllVoice();
    const text = inputRef2.current.trim();
    setMode("idle");
    if (text && sendWithOpts(text) === false) return; // keep draft — not delivered
    setInput("");
    AsyncStorage.removeItem(DRAFT_KEY);
  }, [stopAllVoice, sendWithOpts]);

  const discardDraft = useCallback(() => {
    stopAllVoice();
    setInput("");
    setMode("idle");
    AsyncStorage.removeItem(DRAFT_KEY);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [stopAllVoice]);

  const editDraft = useCallback(() => {
    stopAllVoice();
    setMode("idle");
    // The composer (and its TextInput) stays mounted under the review overlay,
    // so focusing is instant — no remount, no 50ms flicker. rAF lets the
    // overlay-removal commit first so focus lands on the visible input.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [stopAllVoice]);

  const enterReviewMode = useCallback(() => {
    setMode("reviewing");
    Haptics.selectionAsync();
  }, []);

  // ─── Voice event handlers ────────────────────────────────────────────────
  // Dictation only: interim results stream into the draft; on final, map an
  // initial slash phrase (e.g. "plan mode" → /plan).
  useSpeechRecognitionEvent("result", (e) => {
    const text = e.results[0]?.transcript ?? "";
    if (!text) return;
    if (!e.isFinal) {
      setInput(text);
    } else {
      setInput(detectSlashCommand(text));
    }
  });

  useSpeechRecognitionEvent("end", () => {
    // Dictation done — enter the review card if we captured anything.
    if (inputRef2.current.trim()) {
      enterReviewMode();
    } else {
      setMode("idle");
    }
  });

  useSpeechRecognitionEvent("error", () => {
    setMode("idle");
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAllVoice();
    };
  }, [stopAllVoice]);

  // Reset scroll state when a session ends/changes.
  useEffect(() => {
    if (messages.length === 0) {
      userScrolledAwayRef.current = false;
      isAtBottomRef.current = true;
      setIsAtBottom(true);
    }
  }, [messages.length]);

  // Scroll to the bottom whenever a new message arrives.
  // Guard on userScrolledAway so streaming doesn't yank the user back while
  // they're reading earlier messages.
  useEffect(() => {
    if (userScrolledAwayRef.current) return;
    const t = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: false });
    }, 100);
    return () => clearTimeout(t);
  }, [messages.length]);

  // When the keyboard appears the KAV shrinks the scroll view from the bottom,
  // which can push the last message out of view. Re-scroll to end so the user
  // can see what they're replying to.
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", () => {
      if (!userScrolledAwayRef.current) {
        listRef.current?.scrollToEnd({ animated: false });
      }
    });
    return () => sub.remove();
  }, []);

  // Reset all ephemeral UI state when we switch to a new session (or leave one).
  // Without this, state from session A bleeds into session B.
  useEffect(() => {
    stopAllVoice();
    setInput("");
    setMode("idle");
    setExpandedToolIdx(null);
    setPeekPath(null);
    animateFromIdx.current = Number.MAX_SAFE_INTEGER;
    baselineSet.current = false;
    historyIdx.current = -1;
    userScrolledAwayRef.current = false;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    AsyncStorage.removeItem(DRAFT_KEY);
    Keyboard.dismiss();
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const startInitialListening = useCallback(() => {
    setInput("");
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
    const text = input.trim();
    if (!text || streaming) return;
    // Save to history
    if (inputHistory.current[0] !== text) {
      inputHistory.current = [text, ...inputHistory.current].slice(0, 50);
    }
    historyIdx.current = -1;
    if (sendWithOpts(text) === false) return; // keep draft — not delivered
    setInput("");
    AsyncStorage.removeItem(DRAFT_KEY);
  }, [input, streaming, sendWithOpts]);

  const handleInputChange = (text: string) => {
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
  // Slash rail: collapsed to a "/" toggle by default (saves vertical space).
  // Typing "/" auto-expands and filters to matches; otherwise the toggle
  // expands/collapses the full command list.
  const typingSlash = input.startsWith("/");
  const railCommands = typingSlash
    ? slashCommands.filter((c) => c.cmd.startsWith(input.split(" ")[0]))
    : slashCommands;
  const railVisible = slashCommands.length > 0 && !listening;
  const chipsShown = typingSlash || railOpen;

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

  // Tapping a tool chip that carries a file path injects that path into the
  // draft (surrounded by spaces) without sending, and keeps the input focused.
  // Copying the path is still available via long-press (opens the peek modal).
  const injectPath = useCallback((path: string) => {
    Haptics.selectionAsync();
    setInput((cur) => {
      if (!cur) return `${path} `;
      const sep = cur.endsWith(" ") ? "" : " ";
      return `${cur}${sep}${path} `;
    });
    inputRef.current?.focus();
  }, []);

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

  // Once the initial history settles, later messages animate in.
  useEffect(() => {
    if (!historyLoading && !baselineSet.current) {
      baselineSet.current = true;
      animateFromIdx.current = messages.length;
    }
  }, [historyLoading, messages.length]);

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
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back to sessions">
          <Ionicons name="chevron-back" size={24} color={colors.accent} />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {sessionLabel ?? "Session"}
          </Text>
          {sessionStats && sessionStats.runs > 0 ? (
            <Text style={styles.headerStats} numberOfLines={1}>
              {sessionStats.runs} {sessionStats.runs === 1 ? "run" : "runs"} · {sessionStats.filesChanged} files · {formatRunDuration(sessionStats.durationMs)}
            </Text>
          ) : null}
        </View>
        <View style={styles.headerRight}>
          {streaming && activeSessionId ? (
            <TouchableOpacity
              testID="stop-button"
              onPress={() => onCancel(activeSessionId)}
              style={styles.cancelButton}
              accessibilityRole="button"
              accessibilityLabel="Stop the running turn"
            >
              <Text style={styles.cancelText}>Stop</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              testID="settings-button"
              onPress={() => setSettingsOpen(true)}
              style={styles.settingsBtn}
              accessibilityRole="button"
              accessibilityLabel="Settings"
            >
              <Ionicons name="settings-outline" size={20} color={colors.textSub} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {reconnecting ? (
        <Reanimated.View
          style={styles.reconnectingBanner}
          testID="reconnecting-banner"
          entering={reducedMotion ? undefined : SlideInDown.duration(220)}
          exiting={reducedMotion ? undefined : FadeOut.duration(160)}
        >
          <PulsingDot reducedMotion={reducedMotion} />
          <Text style={styles.reconnectingText}>Reconnecting…</Text>
          {onRetryConnect ? (
            <TouchableOpacity
              testID="reconnect-retry-button"
              onPress={() => { Haptics.selectionAsync(); onRetryConnect(); }}
              style={styles.reconnectingRetry}
              activeOpacity={0.7}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={styles.reconnectingRetryText}>Retry</Text>
            </TouchableOpacity>
          ) : null}
        </Reanimated.View>
      ) : null}

      {/* "Working now" header — a legible view of the active turn: current tool
          + live spinner + elapsed + running tally. Becomes the last-run card on
          completion (below). Shown only while streaming and connected. */}
      {streaming && !reconnecting ? (
        <Reanimated.View
          style={styles.workingBar}
          testID="working-now"
          entering={reducedMotion ? undefined : FadeIn.duration(180)}
          exiting={reducedMotion ? undefined : FadeOut.duration(140)}
        >
          <PulsingDot reducedMotion={reducedMotion} />
          <Text style={styles.workingTool} numberOfLines={1}>
            {currentTool ? formatToolLabel(currentTool).label : "Working…"}
          </Text>
          <View style={styles.workingRight}>
            {liveStats ? (
              <Text style={styles.workingStats} numberOfLines={1}>
                {[
                  liveStats.files > 0 ? `${liveStats.files}f` : null,
                  liveStats.added > 0 || liveStats.removed > 0 ? `+${liveStats.added}/−${liveStats.removed}` : null,
                  liveStats.commands > 0 ? `${liveStats.commands} cmd` : null,
                ].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
            <Text style={styles.workingElapsed}>{formatRunDuration(liveElapsed)}</Text>
          </View>
        </Reanimated.View>
      ) : null}

      {/* Message list.
          Plain top-down layout; the useEffect below calls scrollToEnd via
          setTimeout(0) whenever messages arrive, which defers past Fabric's
          async layout commit so the scroll lands on real content rather than
          stale zero-height measurements. ScrollView (not FlatList) avoids a
          new-arch crash where FlatList internally accesses .scrollView on ref. */}
      <View style={{ flex: 1 }}>
        {historyPaging ? (
          <View style={styles.pagingSpinner} pointerEvents="none">
            <ActivityIndicator color={colors.textMuted} size="small" />
          </View>
        ) : null}
        <ScrollView
          ref={listRef}
          style={styles.messageList}
          contentContainerStyle={styles.messagesContent}
          keyboardDismissMode="on-drag"
          onContentSizeChange={(_w, h) => {
            // A pending page just prepended older messages — restore the read
            // position instead of scrolling to the bottom.
            const anchor = pendingAnchorRef.current;
            if (anchor) {
              pendingAnchorRef.current = null;
              const delta = h - anchor.prevHeight;
              if (delta > 0) listRef.current?.scrollTo({ y: anchor.prevOffset + delta, animated: false });
              return;
            }
            if (!userScrolledAwayRef.current) {
              listRef.current?.scrollToEnd({ animated: false });
            }
          }}
          onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
            const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
            // Near the top with older messages available → page back. Capture the
            // anchor first so the prepend doesn't jump the viewport. historyPaging
            // (and the hook's own guard) stop this firing repeatedly.
            if (contentOffset.y < 120 && historyHasMore && !historyPaging && onLoadMore) {
              pendingAnchorRef.current = { prevHeight: contentSize.height, prevOffset: contentOffset.y };
              onLoadMore();
            }
            // Show the scroll-to-bottom button when > 60px from bottom.
            // Only commit state when the value flips — onScroll fires
            // continuously and each set re-renders the whole screen.
            const atBottom = distanceFromBottom < 60;
            if (atBottom !== isAtBottomRef.current) setIsAtBottom(atBottom);
            isAtBottomRef.current = atBottom;
            // 30px hair-trigger: any noticeable upward scroll stops auto-scroll,
            // including during streaming so the user can read earlier messages.
            if (distanceFromBottom < 30) {
              userScrolledAwayRef.current = false;
            } else {
              userScrolledAwayRef.current = true;
            }
          }}
          scrollEventThrottle={100}
        >
          {data.length === 0 ? (
            <View>
              {historyLoading ? (
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
                        onPress={() => { Haptics.selectionAsync(); sendWithOpts(p); }}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.emptyExampleText}>{p}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
            </View>
          ) : data.map((item, index) => {
            if (item.role === "typing") {
              return (
                <View key={`typing-${index}`} style={[bubbleStyles.row, bubbleStyles.assistantRow]}>
                  <View style={styles.typingBubble}><TypingIndicator /></View>
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
                      if (hasPreview) { Haptics.selectionAsync(); setExpandedToolIdx(expanded ? null : index); }
                      else if (fullPath) { injectPath(fullPath); }
                    }}
                    onLongPress={fullPath ? () => { Haptics.selectionAsync(); setPeekPath(fullPath); } : undefined}
                    delayLongPress={400}
                    activeOpacity={hasPreview || fullPath ? 0.6 : 1}
                    accessibilityRole="button"
                    accessibilityLabel={`Tool: ${label}`}
                  >
                    <Text style={styles.toolIcon}>{icon}</Text>
                    <Text style={styles.toolText} numberOfLines={1} ellipsizeMode="middle">{label}{isLive ? "…" : ""}</Text>
                    {hasPreview ? (
                      <Ionicons name={expanded ? "chevron-down" : "chevron-forward"} size={13} color={colors.textSub} style={styles.toolChevron} />
                    ) : fullPath ? (
                      <Ionicons name="chevron-forward" size={13} color={colors.textSub} style={styles.toolChevron} />
                    ) : null}
                  </TouchableOpacity>
                  {expanded && hasPreview ? (
                    <Reanimated.View entering={reducedMotion ? undefined : FadeInDown.duration(180)}>
                      <ToolPreviewDrawer message={tm} onCopy={emitCopied} />
                    </Reanimated.View>
                  ) : null}
                </View>
              );
            }
            const msg = item as DiktatMessage;
            const isStreamingTail = streaming && msg.role === "assistant" && index === data.length - 1;
            // New user messages spring in; history and streamed content don't.
            const animateIn = !reducedMotion && msg.role === "user" && index >= animateFromIdx.current;
            return (
              <Reanimated.View
                key={`msg-${index}`}
                entering={animateIn ? FadeInUp.springify().damping(16).stiffness(190) : undefined}
              >
                <MessageBubble message={msg} streamingTail={isStreamingTail} />
              </Reanimated.View>
            );
          })}
        </ScrollView>

        <LinearGradient
          colors={[colors.bg, "transparent"]}
          style={styles.fadeTop}
          pointerEvents="none"
        />

        {/* Scroll-to-bottom button */}
        {!isAtBottom && (
          <TouchableOpacity
            testID="scroll-to-bottom-button"
            style={styles.scrollToBottom}
            onPress={() => listRef.current?.scrollToEnd({ animated: true })}
            accessibilityRole="button"
            accessibilityLabel="Scroll to latest message"
          >
            <Ionicons name="arrow-down" size={16} color={colors.textSub} />
          </TouchableOpacity>
        )}
      </View>

      {/* Last-run summary — daemon-authoritative when available, else derived. */}
      {runCard && !runDismissed && !streaming && !reviewing ? (
        <Reanimated.View
          style={styles.runStats}
          entering={reducedMotion ? undefined : FadeInDown.duration(180)}
        >
          <Ionicons
            name={runCard.ok === false ? "close-circle" : runCard.ok ? "checkmark-circle" : "stats-chart"}
            size={13}
            color={runCard.ok === false ? colors.error : runCard.ok ? colors.success : colors.accent}
          />
          <Text style={styles.runStatsText} numberOfLines={1}>
            {[
              runCard.files > 0 ? `${runCard.files} ${runCard.files === 1 ? "file" : "files"}` : null,
              (runCard.added > 0 || runCard.removed > 0) ? `+${runCard.added}/−${runCard.removed}` : null,
              runCard.commands > 0 ? `${runCard.commands} cmd` : null,
              runCard.testStatus === "pass" ? "tests ✓" : runCard.testStatus === "fail" ? "tests ✗" : null,
              formatRunDuration(runCard.durationMs),
            ].filter(Boolean).join("  ·  ")}
          </Text>
          <TouchableOpacity onPress={() => setRunDismissed(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss run summary">
            <Ionicons name="close" size={14} color={colors.textMuted} />
          </TouchableOpacity>
        </Reanimated.View>
      ) : null}

      {/* Composer — always mounted so the TextInput persists across the
          review→edit transition. The review card overlays it (below) rather
          than replacing it, so tapping "edit" never remounts/refocuses → no flicker. */}
      <>
          {/* Command rail — collapsible. A leading "/" toggle expands/collapses
              the chip list; typing "/" auto-expands with filtered matches. */}
          {railVisible && !reviewing && (
            <View style={styles.rail}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.railContent}
                keyboardShouldPersistTaps="always"
              >
                {!typingSlash && (
                  <TouchableOpacity
                    testID="slash-rail-toggle"
                    style={styles.railToggle}
                    onPress={() => { Haptics.selectionAsync(); setRailOpen((o) => !o); }}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={chipsShown ? "Hide commands" : "Show commands"}
                  >
                    <Text style={styles.chipCmd}>/</Text>
                    <Ionicons name={railOpen ? "chevron-down" : "chevron-forward"} size={12} color={colors.accent} />
                  </TouchableOpacity>
                )}
                {chipsShown && railCommands.map((c) => (
                  <TouchableOpacity
                    key={c.cmd}
                    testID={`slash-${c.cmd}`}
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

          {/* Model / permission selector (expands above the composer) */}
          {selectorOpen && !reviewing ? (
            <Reanimated.View entering={reducedMotion ? undefined : FadeInDown.duration(160)}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.selectorRow} contentContainerStyle={styles.selectorRowContent} keyboardShouldPersistTaps="handled">
                {selectorOpen === "model"
                  ? (agentOpts?.models ?? []).map((m, i) => (
                      <Reanimated.View key={m.id || "default"} entering={reducedMotion ? undefined : FadeIn.delay(i * 35).duration(180)}>
                        <TouchableOpacity
                          testID={`composer-model-${m.id || "default"}`}
                          style={[styles.selectorChip, selectedModel === m.id && styles.selectorChipActive]}
                          onPress={() => { Haptics.selectionAsync(); setSelectedModel(m.id); setSelectorOpen(null); }}
                        >
                          <Text style={[styles.selectorChipText, selectedModel === m.id && styles.selectorChipTextActive]}>{m.label}</Text>
                        </TouchableOpacity>
                      </Reanimated.View>
                    ))
                  : (agentOpts?.permissionModes ?? PERMISSION_FALLBACK).map((p, i) => (
                      <Reanimated.View key={p.id} entering={reducedMotion ? undefined : FadeIn.delay(i * 35).duration(180)}>
                        <TouchableOpacity
                          testID={`composer-perm-${p.id}`}
                          style={[styles.selectorChip, selectedPermission === p.id && styles.selectorChipActive]}
                          onPress={() => { Haptics.selectionAsync(); setSelectedPermission(p.id as PermissionModeId); setSelectorOpen(null); }}
                        >
                          <Text style={[styles.selectorChipText, selectedPermission === p.id && styles.selectorChipTextActive]}>{p.label}</Text>
                        </TouchableOpacity>
                      </Reanimated.View>
                    ))}
              </ScrollView>
            </Reanimated.View>
          ) : null}

          {/* Compact selector pills (permission always; model when >1 option) */}
          <View style={[styles.optionsBar, { justifyContent: "flex-end" }]}>
            <TouchableOpacity
              testID="composer-perm-pill"
              style={[styles.optionPill, selectorOpen === "perm" && styles.optionPillActive]}
              onPress={() => { Haptics.selectionAsync(); setSelectorOpen(selectorOpen === "perm" ? null : "perm"); }}
              activeOpacity={0.8}
            >
              <Text style={styles.optionPillText}>{PERMISSION_LABEL[selectedPermission]}</Text>
              <SelectorCaret open={selectorOpen === "perm"} reducedMotion={reducedMotion} />
            </TouchableOpacity>
            {agentOpts && agentOpts.models.length > 1 ? (
              <TouchableOpacity
                testID="composer-model-pill"
                style={[styles.optionPill, selectorOpen === "model" && styles.optionPillActive]}
                onPress={() => { Haptics.selectionAsync(); setSelectorOpen(selectorOpen === "model" ? null : "model"); }}
                activeOpacity={0.8}
              >
                <Text style={styles.optionPillText}>
                  {agentOpts.models.find((m) => m.id === selectedModel)?.label ?? "Default"}
                </Text>
                <SelectorCaret open={selectorOpen === "model"} reducedMotion={reducedMotion} />
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Input area. One primary control: the accent button is the mic when
              the draft is empty (voice is the product) and morphs into the
              send arrow once text exists; while listening it becomes stop. */}
          <View style={[styles.inputRow, { paddingBottom: insets.bottom + 10 }]}>
            <View style={styles.inputWrap}>
              {listening ? (
                <View style={styles.listeningBox}>
                  <VoiceWaveform />
                  {input ? <Text style={styles.listeningText} numberOfLines={1}>{input}</Text> : null}
                </View>
              ) : (
                <TextInput
                  ref={inputRef}
                  testID="message-input"
                  style={styles.input}
                  value={input}
                  onChangeText={handleInputChange}
                  placeholder="Message…"
                  placeholderTextColor={colors.textSub}
                  multiline
                  editable={!streaming}
                  returnKeyType="default"
                  autoCapitalize="none"
                />
              )}
            </View>

            {(() => {
              const hasText = !!input.trim();
              const icon = listening ? "stop" : hasText ? "arrow-up" : "mic";
              return (
                <TouchableOpacity
                  testID={hasText && !listening ? "send-button" : "mic-button"}
                  style={[styles.primaryBtn, listening && styles.primaryBtnListening, streaming && styles.primaryBtnDisabled]}
                  onPress={
                    listening
                      ? (settings.micMode === "toggle" ? toggleListening : undefined)
                      : hasText
                        ? handleSend
                        : (settings.micMode === "toggle" ? toggleListening : undefined)
                  }
                  onPressIn={!listening && !hasText && settings.micMode === "hold" ? onMicPressIn : undefined}
                  onPressOut={settings.micMode === "hold" ? onMicPressOut : undefined}
                  disabled={streaming}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={listening ? "Stop listening" : hasText ? "Send message" : "Dictate a message"}
                >
                  <Reanimated.View key={icon} entering={reducedMotion ? undefined : ZoomIn.duration(140)}>
                    <Ionicons name={icon} size={21} color={listening ? colors.error : colors.onAccent} />
                  </Reanimated.View>
                </TouchableOpacity>
              );
            })()}
          </View>
        </>

      {/* Review card — overlays the (still-mounted) composer while reviewing. */}
      {reviewing ? (
        <Reanimated.View
          style={[styles.reviewCard, styles.reviewCardOverlay]}
          entering={reducedMotion ? undefined : FadeIn.duration(140)}
        >
          {/* Transcript itself is the edit target — tap anywhere on it to edit. */}
          <TouchableOpacity activeOpacity={0.7} onPress={editDraft} accessibilityRole="button" accessibilityLabel="Edit dictated message">
            <ScrollView
              style={styles.reviewTranscriptScroll}
              contentContainerStyle={styles.reviewTranscriptContent}
              showsVerticalScrollIndicator={false}
              scrollEnabled={false}
            >
              <Text style={styles.reviewText}>{input}</Text>
            </ScrollView>
            <Text style={styles.reviewEditHint}>tap to edit</Text>
          </TouchableOpacity>

          {/* Action buttons */}
          <View style={styles.reviewActions}>
            <TouchableOpacity
              testID="review-cancel-button"
              style={[styles.reviewActionBtn, styles.reviewCancelBtn]}
              onPress={discardDraft}
              activeOpacity={0.7}
            >
              <Text style={styles.reviewCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="review-send-button"
              style={[styles.reviewActionBtn, styles.reviewSendBtn]}
              onPress={sendDraft}
              activeOpacity={0.85}
            >
              <Text style={styles.reviewSendText}>Send ↑</Text>
            </TouchableOpacity>
          </View>
        </Reanimated.View>
      ) : null}

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
    paddingBottom: 14, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: colors.borderFaint,
  },
  backButton: { padding: 4, marginRight: 10 },
  headerTitleWrap: { flex: 1 },
  headerTitle: { fontFamily: fonts.bodySemi, color: colors.text, fontSize: 15 },
  headerStats: { fontFamily: fonts.mono, color: colors.textMuted, fontSize: 10, marginTop: 1 },
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
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: colors.accentFaint, paddingVertical: 5, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },

  // "Working now" header
  workingBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: colors.accentFaint, paddingVertical: 7, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  workingTool: { flex: 1, fontFamily: fonts.bodyMedium, color: colors.accent, fontSize: 12 },
  workingRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  workingStats: { fontFamily: fonts.mono, color: colors.textSub, fontSize: 11 },
  workingElapsed: { fontFamily: fonts.mono, color: colors.textMuted, fontSize: 11 },
  reconnectingDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.accent },
  reconnectingText: { fontFamily: fonts.body, color: colors.accent, fontSize: 11 },
  reconnectingRetry: {
    borderWidth: 1, borderColor: colors.accent, borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 1,
  },
  reconnectingRetryText: { fontFamily: fonts.bodySemi, color: colors.accent, fontSize: 11 },
  messageList: { flex: 1 },
  // No flexGrow here — if you set flexGrow:1 on the content container together
  // with justifyContent:flex-end, Fabric adds an extra viewport-height of space
  // AFTER the last message, so scrollToEnd lands on blank content. Simple
  // padding-only container lets messages stack naturally from the top, and
  // scrollToEnd (called from the useEffect below) jumps to the correct end.
  messagesContent: { padding: 14, paddingBottom: 8 },
  historyLoadingContainer: { alignItems: "center", marginTop: 100 },
  pagingSpinner: { position: "absolute", top: 8, left: 0, right: 0, alignItems: "center", zIndex: 10 },
  emptyContainer: { alignItems: "center", marginTop: 100, paddingHorizontal: 48 },
  emptyTitle: { fontFamily: fonts.bodySemi, color: colors.textSub, fontSize: 15, marginBottom: 8 },
  emptyHint: { fontFamily: fonts.body, color: colors.textSub, fontSize: 13, textAlign: "center", lineHeight: 20 },
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
  toolChevron: { marginLeft: 4 },

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
  railToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: 16,
    paddingHorizontal: 12,
    height: 30,
  },
  chipCmd: {
    fontFamily: fonts.bodyMedium,
    color: colors.accent,
    fontSize: 13,
  },

  optionsBar: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  optionPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optionPillActive: { borderColor: colors.accentDim, backgroundColor: colors.accentFaint },
  optionPillText: { fontFamily: fonts.body, color: colors.textSub, fontSize: 12, lineHeight: 16 },
  selectorRow: { paddingHorizontal: 12, paddingBottom: 6, maxHeight: 44 },
  selectorRowContent: { flexGrow: 1, justifyContent: "flex-end" },
  selectorChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    marginRight: 8,
  },
  selectorChipActive: { backgroundColor: colors.accentFaint, borderColor: colors.accentDim },
  selectorChipText: { fontFamily: fonts.body, color: colors.textSub, fontSize: 13 },
  selectorChipTextActive: { fontFamily: fonts.bodyMedium, color: colors.text },
  inputRow: {
    flexDirection: "row", alignItems: "flex-end",
    paddingHorizontal: 10, paddingTop: 8,
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

  primaryBtn: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: colors.accent, justifyContent: "center", alignItems: "center",
  },
  primaryBtnListening: { backgroundColor: colors.accentFaint, borderWidth: 1, borderColor: colors.accentDim },
  primaryBtnDisabled: { opacity: 0.3 },

  // ─── Review card ─────────────────────────────────────────────────────────
  reviewCard: {
    backgroundColor: colors.card,
    borderTopWidth: 1, borderTopColor: colors.border,
    paddingTop: 14,
    paddingHorizontal: 18,
    paddingBottom: 32,
    position: "relative",
  },
  reviewCardOverlay: { position: "absolute", left: 0, right: 0, bottom: 0 },
  runStats: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 12, marginBottom: 6,
    paddingHorizontal: 12, paddingVertical: 7,
    backgroundColor: colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  runStatsText: { flex: 1, fontFamily: fonts.mono, color: colors.textSub, fontSize: 11 },
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
    color: colors.textSub,
    fontSize: 11,
    marginBottom: 10,
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
});

const markdownStyles: any = {
  body: { fontFamily: fonts.body, color: colors.text, fontSize: 15, lineHeight: 24 },
  code_inline: {
    backgroundColor: colors.codeBg, color: colors.codeText,
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
  scroll: { backgroundColor: colors.codeBg, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  content: { padding: 12 },
  text: {
    fontFamily: fonts.mono,
    fontSize: 12, lineHeight: 18, color: colors.codeText,
  },
  copyBtn: {
    position: "absolute", top: 6, right: 8,
    backgroundColor: colors.card,
    borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3,
  },
  copyBtnText: {
    fontFamily: fonts.mono,
    fontSize: 10, color: colors.textSub,
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
    backgroundColor: colors.codeBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
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
    borderBottomColor: colors.border,
  },
  headerLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textSub,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  copyText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.accent,
  },
  bodyScrollV: { maxHeight: 320 },
  bodyContent: { padding: 10 },
  line: {
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 16,
  },
  lineCtx: { color: colors.codeText },
  lineAdd: { color: colors.success, backgroundColor: "rgba(52,211,153,0.10)" },
  lineDel: { color: colors.error, backgroundColor: "rgba(248,113,113,0.10)" },
  lineHunk: { color: colors.textSub },
  truncated: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.textSub,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});

const waveStyles = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "center", gap: 3, height: 24 },
  bar: { width: 3, borderRadius: 2, backgroundColor: colors.accent },
});
