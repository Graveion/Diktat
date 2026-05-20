import { useState, useRef, useEffect, useCallback } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, KeyboardAvoidingView, Platform, Animated,
} from "react-native";
import * as Haptics from "expo-haptics";
import Markdown from "react-native-markdown-display";
import type { DiktatMessage } from "../hooks/useDiktat";

let Voice: any = null;
try { Voice = require("@react-native-voice/voice").default; } catch { /* unavailable in Expo Go */ }

const AUTO_SEND_DELAY_MS = 1500;

const TOOL_LABELS: Record<string, string> = {
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  MultiEdit: "Editing",
  Bash: "Running commands",
  Grep: "Searching",
  Glob: "Searching",
  WebSearch: "Searching the web",
  WebFetch: "Fetching",
  TodoWrite: "Updating plan",
  Task: "Running sub-agent",
};

// currentTool is stored as "ToolName" or "ToolName:filename"
function formatToolLabel(tool: string): string {
  const colon = tool.indexOf(":");
  if (colon === -1) return TOOL_LABELS[tool] ?? tool;
  const name = tool.slice(0, colon);
  const file = tool.slice(colon + 1);
  const verb = TOOL_LABELS[name] ?? name;
  return `${verb} ${file}`;
}

type Props = {
  messages: DiktatMessage[];
  streaming: boolean;
  currentTool: string | null;
  reconnecting: boolean;
  activeSessionId: string | null;
  onSend: (text: string) => void;
  onCancel: (sessionId: string) => void;
  onBack: () => void;
  sessionLabel?: string;
};

function TypingIndicator() {
  const dots = [useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current];

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

function MessageBubble({ message }: { message: DiktatMessage }) {
  if (message.role === "tool") {
    const label = formatToolLabel(message.toolName ?? "Tool");
    return (
      <View style={[bubbleStyles.row, bubbleStyles.assistantRow]}>
        <View style={styles.toolBubble}>
          <Text style={styles.toolText}>{label}</Text>
        </View>
      </View>
    );
  }

  if (message.role === "user") {
    return (
      <View style={[bubbleStyles.row, bubbleStyles.userRow]}>
        <View style={[bubbleStyles.bubble, bubbleStyles.userBubble]}>
          <Text style={bubbleStyles.userText}>{message.text}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[bubbleStyles.row, bubbleStyles.assistantRow]}>
      <View style={[bubbleStyles.bubble, bubbleStyles.assistantBubble]}>
        <Markdown style={markdownStyles}>{message.text}</Markdown>
      </View>
    </View>
  );
}

export function ChatScreen({ messages, streaming, currentTool, reconnecting, activeSessionId, onSend, onCancel, onBack, sessionLabel }: Props) {
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [autoSendCountdown, setAutoSendCountdown] = useState<number | null>(null);
  const listRef = useRef<FlatList>(null);
  const autoSendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSendTick = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStreaming = useRef(streaming);

  // Completion haptic when streaming ends
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

  useEffect(() => {
    if (!Voice) return;
    Voice.onSpeechResults = (e: any) => {
      const text = e.value?.[0] ?? "";
      if (text) setInput(text);
    };
    Voice.onSpeechEnd = () => {
      setListening(false);
      // Auto-send after delay — user can cancel by tapping input or mic
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
          if (current.trim()) {
            onSend(current.trim());
            return "";
          }
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

  const prevLengthRef = useRef(0);
  useEffect(() => {
    if (messages.length === 0) { prevLengthRef.current = 0; return; }
    const isHistory = messages.length - prevLengthRef.current > 1;
    prevLengthRef.current = messages.length;
    setTimeout(() => listRef.current?.scrollToEnd({ animated: !isHistory }), isHistory ? 200 : 50);
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
      await Voice.start("en-GB");
    }
  };

  const handleSend = () => {
    clearAutoSend();
    if (!input.trim() || streaming) return;
    onSend(input.trim());
    setInput("");
  };

  const handleInputChange = (text: string) => {
    clearAutoSend();
    setInput(text);
  };

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

      <FlatList
        ref={listRef}
        data={data}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={styles.messages}
        renderItem={({ item }) => {
          if (item.role === "typing") {
            return (
              <View style={[bubbleStyles.row, bubbleStyles.assistantRow]}>
                <View style={[bubbleStyles.bubble, bubbleStyles.assistantBubble]}>
                  <TypingIndicator />
                </View>
              </View>
            );
          }
          if (item.role === "tool") {
                    const label = formatToolLabel((item as any).name ?? "");
            return (
              <View style={[bubbleStyles.row, bubbleStyles.assistantRow]}>
                <View style={styles.toolBubble}>
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

      <View style={styles.inputRow}>
        <TouchableOpacity
          style={[styles.micButton, listening && styles.micButtonActive]}
          onPress={toggleListening}
          disabled={streaming}
        >
          <Text style={styles.micIcon}>{listening ? "⏹" : "🎙"}</Text>
        </TouchableOpacity>
        <View style={styles.inputWrap}>
          <TextInput
            style={[styles.input, listening && styles.inputListening]}
            value={input}
            onChangeText={handleInputChange}
            placeholder={listening ? "Listening…" : "Message…"}
            placeholderTextColor={listening ? "#4f8ef7" : "#555"}
            multiline
            editable={!streaming && !listening}
            returnKeyType="default"
          />
          {autoSendCountdown !== null ? (
            <TouchableOpacity style={styles.autoSendCancel} onPress={clearAutoSend}>
              <Text style={styles.autoSendCancelText}>Sending in {autoSendCountdown}s — tap to cancel</Text>
            </TouchableOpacity>
          ) : null}
        </View>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingTop: 56, paddingBottom: 12, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: "#1e1e1e",
  },
  backButton: { padding: 4, marginRight: 8 },
  backText: { color: "#4f8ef7", fontSize: 22 },
  headerTitle: { flex: 1, color: "#fff", fontSize: 17, fontWeight: "600" },
  headerRight: { minWidth: 48, alignItems: "flex-end" },
  cancelButton: {
    backgroundColor: "#3a1a1a", borderRadius: 6,
    paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: "#f44",
  },
  cancelText: { color: "#f66", fontSize: 13, fontWeight: "600" },
  reconnectingBanner: {
    backgroundColor: "#1a1a2a", paddingVertical: 6, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: "#2a2a3a",
  },
  reconnectingText: { color: "#4f8ef7", fontSize: 12, textAlign: "center" },
  messages: { padding: 12, paddingBottom: 4 },
  emptyContainer: { alignItems: "center", marginTop: 80, paddingHorizontal: 40 },
  emptyTitle: { color: "#555", fontSize: 16, fontWeight: "600", marginBottom: 8 },
  emptyHint: { color: "#3a3a3a", fontSize: 14, textAlign: "center", lineHeight: 20 },
  toolBubble: {
    backgroundColor: "#161a2a", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7,
    borderWidth: 1, borderColor: "#2a3050",
  },
  toolText: { color: "#4f8ef7", fontSize: 13 },
  inputRow: {
    flexDirection: "row", alignItems: "flex-end",
    padding: 12, paddingBottom: 32,
    borderTopWidth: 1, borderTopColor: "#1e1e1e",
    backgroundColor: "#111",
  },
  inputWrap: { flex: 1 },
  input: {
    backgroundColor: "#1e1e1e", color: "#fff",
    borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10,
    fontSize: 16, maxHeight: 120, lineHeight: 22,
  },
  autoSendCancel: {
    marginTop: 4, paddingHorizontal: 16,
  },
  autoSendCancelText: { color: "#4f8ef7", fontSize: 12 },
  micButton: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "#1e1e1e", justifyContent: "center",
    alignItems: "center", marginRight: 8,
  },
  micButtonActive: { backgroundColor: "#2a1a1a", borderWidth: 1, borderColor: "#f44" },
  micIcon: { fontSize: 18 },
  inputListening: { borderWidth: 1, borderColor: "#4f8ef7" },
  sendButton: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "#4f8ef7", justifyContent: "center",
    alignItems: "center", marginLeft: 8,
  },
  sendDisabled: { opacity: 0.3 },
  sendIcon: { color: "#fff", fontSize: 18, fontWeight: "bold" },
});

const bubbleStyles = StyleSheet.create({
  row: { marginBottom: 4, maxWidth: "80%" },
  userRow: { alignSelf: "flex-end" },
  assistantRow: { alignSelf: "flex-start" },
  bubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  userBubble: { backgroundColor: "#4f8ef7", borderBottomRightRadius: 4 },
  assistantBubble: { backgroundColor: "#1e1e1e", borderBottomLeftRadius: 4 },
  userText: { color: "#fff", fontSize: 16, lineHeight: 22 },
});

const markdownStyles = {
  body: { color: "#eee", fontSize: 16, lineHeight: 24 },
  code_inline: { backgroundColor: "#2a2a2a", color: "#e0e0e0", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 14, borderRadius: 4, paddingHorizontal: 4 },
  fence: { backgroundColor: "#0d0d0d", borderRadius: 8, padding: 12, marginVertical: 4 },
  code_block: { color: "#e0e0e0", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 13, lineHeight: 20 },
  link: { color: "#4f8ef7" },
  strong: { color: "#fff" },
  heading1: { color: "#fff", fontSize: 20, fontWeight: "bold", marginBottom: 8 },
  heading2: { color: "#fff", fontSize: 18, fontWeight: "bold", marginBottom: 6 },
  heading3: { color: "#ddd", fontSize: 16, fontWeight: "600", marginBottom: 4 },
  blockquote: { backgroundColor: "#1a1a1a", borderLeftColor: "#4f8ef7", borderLeftWidth: 3, paddingLeft: 12 },
  bullet_list: { marginLeft: 8 },
  ordered_list: { marginLeft: 8 },
  list_item: { color: "#eee" },
  hr: { backgroundColor: "#333" },
};

const typingStyles = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "center", padding: 4, gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#888" },
});
