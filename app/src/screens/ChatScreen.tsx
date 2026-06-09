import { useState, useRef, useEffect, useCallback } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet,
  TextInput, KeyboardAvoidingView, Platform, Animated,
  ScrollView, DeviceEventEmitter, ActivityIndicator, Keyboard,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Markdown from "react-native-markdown-display";
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import * as Localization from "expo-localization";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import type { DiktatMessage } from "../hooks/useDiktat";
import { useSettings } from "../hooks/useSettings";
import {
  buildContextualStrings, detectSlashCommand,
} from "../utils/voice";
import { suggestCommands } from "../utils/suggestions";
import { formatToolLabel } from "../utils/tools";
import { SettingsSheet } from "../components/SettingsSheet";
import { colors, fonts } from "../theme";

const DRAFT_KEY = "diktat:draft";

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
  message,
}: {
  message: DiktatMessage;
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
    </TouchableOpacity>
  );
}

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
  const userScrolledAwayRef = useRef(false);
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const inputRef = useRef<TextInput>(null);
  const prevStreaming = useRef(streaming);
  const inputHistory = useRef<string[]>([]);
  const historyIdx = useRef(-1);

  const listening = mode === "listening";
  const reviewing = mode === "reviewing";

  // Completion haptic
  useEffect(() => {
    if (prevStreaming.current && !streaming && messages.length > 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    prevStreaming.current = streaming;
  }, [streaming]);

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
    if (text) onSend(text);
    setInput("");
    AsyncStorage.removeItem(DRAFT_KEY);
  }, [stopAllVoice, onSend]);

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
    // input stays — user can edit / type freely
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [stopAllVoice]);

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
    Haptics.selectionAsync();
  }, []);

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
    onSend(text);
    setInput("");
    AsyncStorage.removeItem(DRAFT_KEY);
  }, [input, streaming, onSend]);

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
            <TouchableOpacity testID="stop-button" onPress={() => onCancel(activeSessionId)} style={styles.cancelButton}>
              <Text style={styles.cancelText}>Stop</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity testID="settings-button" onPress={() => setSettingsOpen(true)} style={styles.settingsBtn}>
              <Text style={styles.settingsIcon}>⚙</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {reconnecting ? (
        <View style={styles.reconnectingBanner} testID="reconnecting-banner">
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
        </View>
      ) : null}

      {/* Message list.
          Plain top-down layout; the useEffect below calls scrollToEnd via
          setTimeout(0) whenever messages arrive, which defers past Fabric's
          async layout commit so the scroll lands on real content rather than
          stale zero-height measurements. ScrollView (not FlatList) avoids a
          new-arch crash where FlatList internally accesses .scrollView on ref. */}
      <View style={{ flex: 1 }}>
        <ScrollView
          ref={listRef}
          style={styles.messageList}
          contentContainerStyle={styles.messagesContent}
          keyboardDismissMode="on-drag"
          onContentSizeChange={(_w, _h) => {
            if (!userScrolledAwayRef.current) {
              listRef.current?.scrollToEnd({ animated: false });
            }
          }}
          onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
            const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
            // Show the scroll-to-bottom button when > 60px from bottom.
            const atBottom = distanceFromBottom < 60;
            setIsAtBottom(atBottom);
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
                        onPress={() => { Haptics.selectionAsync(); onSend(p); }}
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
                  >
                    <Text style={styles.toolIcon}>{icon}</Text>
                    <Text style={styles.toolText} numberOfLines={1} ellipsizeMode="middle">{label}{isLive ? "…" : ""}</Text>
                    {hasPreview ? <Text style={styles.toolChevron}>{expanded ? "▾" : "▸"}</Text>
                      : fullPath ? <Text style={styles.toolChevron}>›</Text> : null}
                  </TouchableOpacity>
                  {expanded && hasPreview ? <ToolPreviewDrawer message={tm} onCopy={emitCopied} /> : null}
                </View>
              );
            }
            const msg = item as DiktatMessage;
            return (
              <View key={`msg-${index}`}>
                <MessageBubble message={msg} />
              </View>
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
          >
            <Text style={styles.scrollToBottomIcon}>↓</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Review card — replaces rail + input row when reviewing */}
      {reviewing ? (
        <View style={styles.reviewCard}>
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
              tap to edit · then Send or Cancel
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
        </View>
      ) : (
        <>
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

          {/* Input area */}
          <View style={styles.inputRow}>
            <TouchableOpacity
              testID="mic-button"
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
                  testID="message-input"
                  style={styles.input}
                  value={input}
                  onChangeText={handleInputChange}
                  placeholder="Message…"
                  placeholderTextColor="#444"
                  multiline
                  editable={!streaming}
                  returnKeyType="default"
                  autoCapitalize="none"
                />
              )}
            </View>

            <TouchableOpacity
              testID="send-button"
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
  messageList: { flex: 1 },
  // No flexGrow here — if you set flexGrow:1 on the content container together
  // with justifyContent:flex-end, Fabric adds an extra viewport-height of space
  // AFTER the last message, so scrollToEnd lands on blank content. Simple
  // padding-only container lets messages stack naturally from the top, and
  // scrollToEnd (called from the useEffect below) jumps to the correct end.
  messagesContent: { padding: 14, paddingBottom: 8 },
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
