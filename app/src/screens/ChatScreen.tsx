import { useState, useRef, useEffect } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, KeyboardAvoidingView, Platform, Animated,
} from "react-native";
import Markdown from "react-native-markdown-display";
import type { DiktatMessage } from "../hooks/useDiktat";

let Voice: any = null;
try { Voice = require("@react-native-voice/voice").default; } catch { /* unavailable in Expo Go */ }

type Props = {
  messages: DiktatMessage[];
  streaming: boolean;
  onSend: (text: string) => void;
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
  const isUser = message.role === "user";

  if (isUser) {
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

export function ChatScreen({ messages, streaming, onSend, onBack, sessionLabel }: Props) {
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    if (!Voice) return;
    Voice.onSpeechResults = (e: any) => {
      const text = e.value?.[0] ?? "";
      if (text) setInput(text);
    };
    Voice.onSpeechEnd = () => setListening(false);
    Voice.onSpeechError = () => setListening(false);
    return () => { Voice.destroy().then(Voice.removeAllListeners); };
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [messages, streaming]);

  const toggleListening = async () => {
    if (!Voice) return;
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
    if (!input.trim() || streaming) return;
    onSend(input.trim());
    setInput("");
  };

  const data: (DiktatMessage | { role: "typing" })[] = [
    ...messages,
    ...(streaming && messages[messages.length - 1]?.role !== "assistant" ? [{ role: "typing" as const }] : []),
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
          {streaming && <View style={styles.activeIndicator} />}
        </View>
      </View>

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
          return <MessageBubble message={item as DiktatMessage} />;
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            Send a message to get started.
          </Text>
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
        <TextInput
          style={[styles.input, listening && styles.inputListening]}
          value={input}
          onChangeText={setInput}
          placeholder={listening ? "Listening..." : "Message..."}
          placeholderTextColor={listening ? "#4f8ef7" : "#555"}
          multiline
          editable={!streaming && !listening}
          returnKeyType="default"
        />
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
  headerRight: { width: 24, alignItems: "center" },
  activeIndicator: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#4caf50" },
  messages: { padding: 12, paddingBottom: 4 },
  empty: { color: "#444", textAlign: "center", marginTop: 80, fontSize: 15 },
  inputRow: {
    flexDirection: "row", alignItems: "flex-end",
    padding: 12, paddingBottom: 32,
    borderTopWidth: 1, borderTopColor: "#1e1e1e",
    backgroundColor: "#111",
  },
  input: {
    flex: 1, backgroundColor: "#1e1e1e", color: "#fff",
    borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10,
    fontSize: 16, maxHeight: 120, lineHeight: 22,
  },
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
