import { useState, useRef, useEffect, useCallback } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, KeyboardAvoidingView, Platform, Animated,
  ScrollView,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import * as Localization from "expo-localization";
import Markdown from "react-native-markdown-display";
import SyntaxHighlighter from "react-native-syntax-highlighter";
import { atomOneDark } from "react-syntax-highlighter/styles/hljs";
import type { DiktatMessage } from "../hooks/useDiktat";
import { colors, fonts } from "../theme";

let Voice: any = null;
try { Voice = require("@react-native-voice/voice").default; } catch { /* unavailable in Expo Go */ }

const AUTO_SEND_DELAY_MS = 1500;

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

function MessageBubble({ message }: { message: DiktatMessage }) {
  const handleLongPress = useCallback(() => {
    Clipboard.setStringAsync(message.text);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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
        <Markdown style={markdownStyles} rules={markdownRules}>{message.text}</Markdown>
      </View>
    </TouchableOpacity>
  );
}

// Syntax-highlighted code blocks for Markdown
const markdownRules = {
  fence: (node: any, _children: any, _parent: any, styles_: any) => {
    const lang = (node.sourceInfo ?? "").trim() || "text";
    return (
      <SyntaxHighlighter
        key={node.key}
        language={lang}
        style={atomOneDark}
        customStyle={{ borderRadius: 8, marginVertical: 6, padding: 0 }}
        fontSize={12}
        fontFamily={Platform.OS === "ios" ? "Menlo" : "monospace"}
      >
        {node.content ?? ""}
      </SyntaxHighlighter>
    );
  },
};

// ─── Props ───────────────────────────────────────────────────────────────────

type Props = {
  messages: DiktatMessage[];
  streaming: boolean;
  currentTool: string | null;
  reconnecting: boolean;
  activeSessionId: string | null;
  sessionCli?: string;
  onSend: (text: string) => void;
  onCancel: (sessionId: string) => void;
  onBack: () => void;
  sessionLabel?: string;
};

// ─── Main component ──────────────────────────────────────────────────────────

export function ChatScreen({
  messages, streaming, currentTool, reconnecting,
  activeSessionId, sessionCli, onSend, onCancel, onBack, sessionLabel,
}: Props) {
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [autoSendCountdown, setAutoSendCountdown] = useState<number | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const listRef = useRef<FlatList>(null);
  const autoSendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSendTick = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStreaming = useRef(streaming);
  const inputHistory = useRef<string[]>([]);
  const historyIdx = useRef(-1);

  // Completion haptic
  useEffect(() => {
    if (prevStreaming.current && !streaming && messages.length > 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    prevStreaming.current = streaming;
  }, [streaming]);

  const clearAutoSend = useCallback(() => {
    if (autoSendTimer.current) { clearTimeout(autoSendTimer.current); autoSendTimer.current = null; }
    if (autoSendTick.current) { clearInterval(autoSendTick.current); autoSendTick.current = null; }
    setAutoSendCountdown(null);
  }, []);

  // Voice setup
  useEffect(() => {
    if (!Voice) return;
    Voice.onSpeechPartialResults = (e: any) => {
      const text = e.value?.[0] ?? "";
      if (text) setInput(text);
    };
    Voice.onSpeechResults = (e: any) => {
      const raw = e.value?.[0] ?? "";
      const text = detectSlashCommand(raw);
      if (text) setInput(text);
    };
    Voice.onSpeechEnd = () => {
      setListening(false);
      let remaining = Math.ceil(AUTO_SEND_DELAY_MS / 1000);
      setAutoSendCountdown(remaining);
      autoSendTick.current = setInterval(() => {
        remaining -= 1;
        setAutoSendCountdown(remaining > 0 ? remaining : null);
      }, 1000);
      autoSendTimer.current = setTimeout(() => {
        autoSendTick.current && clearInterval(autoSendTick.current);
        setAutoSendCountdown(null);
        setInput((current) => {
          if (current.trim()) { onSend(current.trim()); return ""; }
          return current;
        });
      }, AUTO_SEND_DELAY_MS);
    };
    Voice.onSpeechError = () => { setListening(false); clearAutoSend(); };
    return () => {
      clearAutoSend();
      Voice.destroy().then(Voice.removeAllListeners);
    };
  }, [clearAutoSend, onSend]);

  // Auto-scroll
  const prevLengthRef = useRef(0);
  useEffect(() => {
    if (messages.length === 0) { prevLengthRef.current = 0; return; }
    const isHistory = messages.length - prevLengthRef.current > 1;
    prevLengthRef.current = messages.length;
    if (isAtBottom || isHistory) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: !isHistory }), isHistory ? 200 : 50);
    }
  }, [messages.length]);

  const toggleListening = async () => {
    if (!Voice) return;
    clearAutoSend();
    if (listening) {
      await Voice.stop();
      setListening(false);
    } else {
      setInput("");
      setListening(true);
      const locale = Localization.getLocales()[0]?.languageTag ?? "en-US";
      await Voice.start(locale);
    }
  };

  const handleSend = useCallback(() => {
    clearAutoSend();
    const text = input.trim();
    if (!text || streaming) return;
    // Save to history
    if (inputHistory.current[0] !== text) {
      inputHistory.current = [text, ...inputHistory.current].slice(0, 50);
    }
    historyIdx.current = -1;
    onSend(text);
    setInput("");
  }, [input, streaming, clearAutoSend, onSend]);

  const handleInputChange = (text: string) => {
    clearAutoSend();
    historyIdx.current = -1;
    setInput(text);
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

  // Slash command picker
  const slashCommands = sessionCli ? (SLASH_COMMANDS[sessionCli] ?? []) : [];
  const showSlashPicker = input.startsWith("/") && slashCommands.length > 0;
  const filteredCommands = showSlashPicker
    ? slashCommands.filter((c) => c.cmd.startsWith(input.split(" ")[0]))
    : [];

  const [peekPath, setPeekPath] = useState<string | null>(null);

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
          ) : null}
        </View>
      </View>

      {reconnecting ? (
        <View style={styles.reconnectingBanner}>
          <Text style={styles.reconnectingText}>Reconnecting…</Text>
        </View>
      ) : null}

      {/* Message list */}
      <View style={{ flex: 1 }}>
        <FlatList
          ref={listRef}
          data={data}
          keyExtractor={(_, i) => String(i)}
          contentContainerStyle={styles.messages}
          onScroll={(e) => {
            const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
            setIsAtBottom(layoutMeasurement.height + contentOffset.y >= contentSize.height - 60);
          }}
          scrollEventThrottle={100}
          renderItem={({ item }) => {
            if (item.role === "typing") {
              return (
                <View style={[bubbleStyles.row, bubbleStyles.assistantRow]}>
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
              const isLive = !toolItem.toolName; // live indicator has no toolName
              return (
                <View style={[bubbleStyles.row, bubbleStyles.assistantRow]}>
                  <TouchableOpacity
                    style={styles.toolBubble}
                    onPress={() => fullPath ? setPeekPath(fullPath) : null}
                    activeOpacity={fullPath ? 0.6 : 1}
                  >
                    <Text style={styles.toolIcon}>{icon}</Text>
                    <Text style={styles.toolText}>{label}{isLive ? "…" : ""}</Text>
                    {fullPath ? <Text style={styles.toolChevron}>›</Text> : null}
                  </TouchableOpacity>
                </View>
              );
            }
            return <MessageBubble message={item as DiktatMessage} />;
          }}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyTitle}>Session ready</Text>
              <Text style={styles.emptyHint}>Tap the mic and describe what you want to build, fix, or change.</Text>
            </View>
          }
        />

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

      {/* Slash command picker */}
      {filteredCommands.length > 0 && (
        <View style={styles.slashPicker}>
          {filteredCommands.map((c) => (
            <TouchableOpacity
              key={c.cmd}
              style={styles.slashRow}
              onPress={() => setInput(c.cmd + " ")}
            >
              <Text style={styles.slashCmd}>{c.cmd}</Text>
              <Text style={styles.slashDesc}>{c.description}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Input area */}
      <View style={styles.inputRow}>
        <TouchableOpacity
          style={[styles.micButton, listening && styles.micButtonActive]}
          onPress={toggleListening}
          disabled={streaming}
        >
          <Text style={styles.micIcon}>{listening ? "⏹" : "🎙"}</Text>
        </TouchableOpacity>

        <View style={styles.inputWrap}>
          {listening ? (
            <View style={styles.listeningBox}>
              <VoiceWaveform />
              {input ? <Text style={styles.listeningText} numberOfLines={1}>{input}</Text> : null}
            </View>
          ) : (
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={handleInputChange}
              placeholder="Message…"
              placeholderTextColor="#444"
              multiline
              editable={!streaming}
              returnKeyType="default"
            />
          )}
          {autoSendCountdown !== null ? (
            <TouchableOpacity style={styles.autoSendCancel} onPress={clearAutoSend}>
              <Text style={styles.autoSendCancelText}>Sending in {autoSendCountdown}s — tap to cancel</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* History button — only shown when there's history and input is empty */}
        {inputHistory.current.length > 0 && !input && !listening && (
          <TouchableOpacity style={styles.historyButton} onPress={() => cycleHistory(1)}>
            <Text style={styles.historyIcon}>↑</Text>
          </TouchableOpacity>
        )}
        {/* Down history when browsing */}
        {historyIdx.current >= 0 && !listening && (
          <TouchableOpacity style={styles.historyButton} onPress={() => cycleHistory(-1)}>
            <Text style={styles.historyIcon}>↓</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[styles.sendButton, (!input.trim() || streaming) && styles.sendDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || streaming}
        >
          <Text style={styles.sendIcon}>↑</Text>
        </TouchableOpacity>
      </View>

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
              onPress={() => { Clipboard.setStringAsync(peekPath); setPeekPath(null); }}
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
  reconnectingBanner: {
    backgroundColor: colors.accentFaint, paddingVertical: 5, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  reconnectingText: { fontFamily: fonts.body, color: colors.accent, fontSize: 11, textAlign: "center" },
  messages: { padding: 14, paddingBottom: 8 },
  emptyContainer: { alignItems: "center", marginTop: 100, paddingHorizontal: 48 },
  emptyTitle: { fontFamily: fonts.bodySemi, color: colors.textSub, fontSize: 15, marginBottom: 8 },
  emptyHint: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 13, textAlign: "center", lineHeight: 20 },

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

  slashPicker: {
    backgroundColor: colors.card,
    borderTopWidth: 1, borderTopColor: colors.border,
    maxHeight: 220,
  },
  slashRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: colors.borderFaint,
  },
  slashCmd: { fontFamily: fonts.bodyBold, color: colors.accent, fontSize: 14, width: 110 },
  slashDesc: { fontFamily: fonts.body, color: colors.textSub, fontSize: 13, flex: 1 },

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
  autoSendCancel: { marginTop: 4, paddingHorizontal: 4 },
  autoSendCancelText: { fontFamily: fonts.body, color: colors.accent, fontSize: 11 },

  micButton: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.card, justifyContent: "center", alignItems: "center",
    borderWidth: 1, borderColor: colors.border,
  },
  micButtonActive: { backgroundColor: colors.accentFaint, borderColor: colors.accentDim },
  micIcon: { fontSize: 18 },

  historyButton: {
    width: 34, height: 34, borderRadius: 10,
    backgroundColor: colors.card, justifyContent: "center", alignItems: "center",
    borderWidth: 1, borderColor: colors.border,
  },
  historyIcon: { color: colors.textSub, fontSize: 13 },

  sendButton: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.accent, justifyContent: "center", alignItems: "center",
  },
  sendDisabled: { opacity: 0.2 },
  sendIcon: { color: "#fff", fontSize: 17, fontWeight: "700" },
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

const waveStyles = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "center", gap: 3, height: 24 },
  bar: { width: 3, borderRadius: 2, backgroundColor: colors.accent },
});
