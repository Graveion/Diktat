import { useState, useRef, useEffect, useCallback } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, KeyboardAvoidingView, Platform, Animated,
  Clipboard, ScrollView,
} from "react-native";
import * as Haptics from "expo-haptics";
import * as Localization from "expo-localization";
import Markdown from "react-native-markdown-display";
import SyntaxHighlighter from "react-native-syntax-highlighter";
import { atomOneDark } from "react-syntax-highlighter/styles/hljs";
import type { DiktatMessage } from "../hooks/useDiktat";

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
          Animated.delay(i * 150),
          Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0, duration: 300, useNativeDriver: true }),
          Animated.delay(600),
        ])
      )
    );
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, []);
  return (
    <View style={typingStyles.container}>
      {dots.map((dot, i) => (
        <Animated.View key={i} style={[typingStyles.dot, { opacity: dot }]} />
      ))}
    </View>
  );
}

// ─── Message bubble ──────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: DiktatMessage }) {
  const handleLongPress = useCallback(() => {
    Clipboard.setString(message.text);
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

  const showTyping = streaming && messages[messages.length - 1]?.role !== "assistant";
  const data: (DiktatMessage | { role: "typing" } | { role: "tool"; name: string })[] = [
    ...messages,
    ...(currentTool ? [{ role: "tool" as const, name: currentTool }] : []),
    ...(showTyping && !currentTool ? [{ role: "typing" as const }] : []),
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
              const { label, icon } = formatToolLabel((item as any).name ?? "");
              return (
                <View style={[bubbleStyles.row, bubbleStyles.assistantRow]}>
                  <View style={styles.toolBubble}>
                    <Text style={styles.toolIcon}>{icon}</Text>
                    <Text style={styles.toolText}>{label}…</Text>
                  </View>
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
    </KeyboardAvoidingView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f0f" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingTop: 56, paddingBottom: 12, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: "#1a1a1a",
  },
  backButton: { padding: 4, marginRight: 8 },
  backText: { color: "#4f8ef7", fontSize: 22 },
  headerTitle: { flex: 1, color: "#fff", fontSize: 16, fontWeight: "500" },
  headerRight: { minWidth: 48, alignItems: "flex-end" },
  cancelButton: {
    backgroundColor: "#2a0a0a", borderRadius: 6,
    paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: "#833",
  },
  cancelText: { color: "#f66", fontSize: 13, fontWeight: "600" },
  reconnectingBanner: {
    backgroundColor: "#0d1220", paddingVertical: 5, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: "#1a2a3a",
  },
  reconnectingText: { color: "#4f8ef7", fontSize: 11, textAlign: "center" },
  messages: { padding: 16, paddingBottom: 8 },
  emptyContainer: { alignItems: "center", marginTop: 80, paddingHorizontal: 40 },
  emptyTitle: { color: "#444", fontSize: 15, fontWeight: "600", marginBottom: 8 },
  emptyHint: { color: "#2a2a2a", fontSize: 14, textAlign: "center", lineHeight: 20 },

  typingBubble: { paddingHorizontal: 12, paddingVertical: 10 },

  toolBubble: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#0d1520", borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6,
    borderWidth: 1, borderColor: "#1a2a40",
  },
  toolIcon: { fontSize: 12 },
  toolText: { color: "#5a8ef0", fontSize: 12, fontWeight: "500" },

  scrollToBottom: {
    position: "absolute", bottom: 12, right: 16,
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: "#1e1e1e", borderWidth: 1, borderColor: "#333",
    justifyContent: "center", alignItems: "center",
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
  },
  scrollToBottomIcon: { color: "#888", fontSize: 16 },

  slashPicker: {
    backgroundColor: "#161616", borderTopWidth: 1, borderTopColor: "#222",
    maxHeight: 200,
  },
  slashRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: "#1a1a1a",
  },
  slashCmd: { color: "#4f8ef7", fontSize: 14, fontWeight: "600", width: 100 },
  slashDesc: { color: "#555", fontSize: 13, flex: 1 },

  inputRow: {
    flexDirection: "row", alignItems: "flex-end",
    paddingHorizontal: 12, paddingTop: 8, paddingBottom: 32,
    borderTopWidth: 1, borderTopColor: "#1a1a1a",
    backgroundColor: "#0f0f0f", gap: 6,
  },
  inputWrap: { flex: 1 },
  input: {
    backgroundColor: "#1a1a1a", color: "#fff",
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 15, maxHeight: 120, lineHeight: 21,
  },
  listeningBox: {
    backgroundColor: "#0d1220", borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: "#1a3050",
    minHeight: 42, justifyContent: "center",
    flexDirection: "row", alignItems: "center", gap: 10,
  },
  listeningText: { color: "#4f8ef7", fontSize: 14, flex: 1 },
  autoSendCancel: { marginTop: 4, paddingHorizontal: 4 },
  autoSendCancelText: { color: "#4f8ef7", fontSize: 11 },

  micButton: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "#1a1a1a", justifyContent: "center", alignItems: "center",
  },
  micButtonActive: { backgroundColor: "#1a0d0d", borderWidth: 1, borderColor: "#833" },
  micIcon: { fontSize: 18 },

  historyButton: {
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: "#1a1a1a", justifyContent: "center", alignItems: "center",
  },
  historyIcon: { color: "#555", fontSize: 14 },

  sendButton: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "#4f8ef7", justifyContent: "center", alignItems: "center",
  },
  sendDisabled: { opacity: 0.25 },
  sendIcon: { color: "#fff", fontSize: 17, fontWeight: "700" },
});

const bubbleStyles = StyleSheet.create({
  row: { marginBottom: 6, maxWidth: "85%" },
  userRow: { alignSelf: "flex-end" },
  assistantRow: { alignSelf: "flex-start", maxWidth: "92%" },
  bubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  userBubble: { backgroundColor: "#2a5fd6", borderBottomRightRadius: 4 },
  // Assistant: no box — left border only, blends into dark bg
  assistantBubble: {
    paddingLeft: 12, paddingRight: 4, paddingVertical: 2,
    borderLeftWidth: 2, borderLeftColor: "#252525",
  },
  userText: { color: "#fff", fontSize: 15, lineHeight: 22 },
});

const markdownStyles: any = {
  body: { color: "#ddd", fontSize: 15, lineHeight: 24 },
  code_inline: {
    backgroundColor: "#1e1e1e", color: "#c9d1d9",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 13, borderRadius: 3,
  },
  link: { color: "#4f8ef7" },
  strong: { color: "#eee", fontWeight: "600" },
  em: { color: "#ccc" },
  heading1: { color: "#fff", fontSize: 19, fontWeight: "700", marginBottom: 8, marginTop: 4 },
  heading2: { color: "#eee", fontSize: 17, fontWeight: "600", marginBottom: 6, marginTop: 2 },
  heading3: { color: "#ddd", fontSize: 15, fontWeight: "600", marginBottom: 4 },
  blockquote: { borderLeftColor: "#333", borderLeftWidth: 3, paddingLeft: 10, opacity: 0.8 },
  bullet_list: { marginLeft: 4 },
  ordered_list: { marginLeft: 4 },
  list_item: { color: "#ddd", marginBottom: 2 },
  hr: { backgroundColor: "#222", height: 1 },
  fence: { marginVertical: 4 },
};

const typingStyles = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#444" },
});

const waveStyles = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "center", gap: 3, height: 24 },
  bar: { width: 3, borderRadius: 2, backgroundColor: "#4f8ef7" },
});
