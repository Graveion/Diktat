import { useState, useRef, useEffect } from "react";
import {
  View, Text, FlatList, TouchableOpacity,
  StyleSheet, ActivityIndicator, TextInput, KeyboardAvoidingView, Platform,
} from "react-native";
import * as Speech from "expo-speech";
import type { DiktatMessage } from "../hooks/useDiktat";

type Props = {
  messages: DiktatMessage[];
  streaming: boolean;
  onSend: (text: string) => void;
  onBack: () => void;
};

export function ChatScreen({ messages, streaming, onSend, onBack }: Props) {
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    onSend(input.trim());
    setInput("");
  };

  const handleVoice = async () => {
    if (listening) {
      setListening(false);
      return;
    }
    setListening(true);
    try {
      await Speech.speak("Listening", { language: "en" });
    } catch {
      setListening(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.back}>← Sessions</Text>
        </TouchableOpacity>
        {streaming && <ActivityIndicator color="#4f8ef7" style={styles.spinner} />}
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={styles.messages}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.role === "user" ? styles.userBubble : styles.assistantBubble]}>
            <Text style={[styles.bubbleText, item.role === "user" ? styles.userText : styles.assistantText]}>
              {item.text}
            </Text>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>Send a message or hold the mic to dictate.</Text>
        }
      />

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message..."
          placeholderTextColor="#555"
          multiline
          editable={!streaming}
          onSubmitEditing={handleSend}
        />
        <TouchableOpacity
          style={[styles.micButton, listening && styles.micActive]}
          onPress={handleVoice}
        >
          <Text style={styles.micIcon}>{listening ? "⏹" : "🎤"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.sendButton, (!input.trim() || streaming) && styles.sendDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || streaming}
        >
          <Text style={styles.sendText}>↑</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111" },
  header: {
    flexDirection: "row", alignItems: "center",
    padding: 20, paddingTop: 60,
  },
  back: { color: "#4f8ef7", fontSize: 16 },
  spinner: { marginLeft: 12 },
  messages: { padding: 16, paddingBottom: 8 },
  bubble: { maxWidth: "80%", borderRadius: 12, padding: 12, marginBottom: 8 },
  userBubble: { backgroundColor: "#4f8ef7", alignSelf: "flex-end" },
  assistantBubble: { backgroundColor: "#222", alignSelf: "flex-start" },
  bubbleText: { fontSize: 15, lineHeight: 22 },
  userText: { color: "#fff" },
  assistantText: { color: "#eee" },
  empty: { color: "#444", textAlign: "center", marginTop: 60 },
  inputRow: {
    flexDirection: "row", alignItems: "flex-end",
    padding: 12, borderTopWidth: 1, borderTopColor: "#222",
  },
  input: {
    flex: 1, backgroundColor: "#222", color: "#fff", borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 100,
  },
  micButton: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: "#222",
    justifyContent: "center", alignItems: "center", marginLeft: 8,
  },
  micActive: { backgroundColor: "#f74f4f" },
  micIcon: { fontSize: 18 },
  sendButton: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: "#4f8ef7",
    justifyContent: "center", alignItems: "center", marginLeft: 8,
  },
  sendDisabled: { opacity: 0.3 },
  sendText: { color: "#fff", fontSize: 20, fontWeight: "bold" },
});
