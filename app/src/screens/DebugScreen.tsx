import { useState, useEffect, useRef } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  SafeAreaView,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { subscribeToLogs, getLogs, clearLogs, exportLogs, type LogEntry } from "../utils/logger";

const CRASH_KEY = "@diktat/last_crash";

const LEVEL_COLORS: Record<string, string> = {
  info:  "#ccc",
  warn:  "#f90",
  error: "#f55",
};

const TAG_COLORS: Record<string, string> = {
  WS:      "#4f8ef7",
  MSG:     "#aaa",
  NAV:     "#7fcf7f",
  SESSION: "#cf9fff",
  PUSH:    "#ffcf6f",
  ERROR:   "#f55",
};

type Props = { onBack: () => void };

export function DebugScreen({ onBack }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>(getLogs());
  const [filter, setFilter] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [lastCrash, setLastCrash] = useState<string | null>(null);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    AsyncStorage.getItem(CRASH_KEY).then(setLastCrash);
  }, []);

  useEffect(() => {
    const unsub = subscribeToLogs((all) => {
      setEntries(all);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
    });
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 100);
    return unsub;
  }, []);

  const tags = Array.from(new Set(getLogs().map((e) => e.tag)));
  const visible = filter ? entries.filter((e) => e.tag === filter) : entries;

  const handleCopy = () => {
    const text = filter
      ? entries.filter((e) => e.tag === filter).map((e) => `${e.ts} [${e.tag}] ${e.level.toUpperCase().padEnd(5)} ${e.msg}`).join("\n")
      : exportLogs();
    Clipboard.setStringAsync(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Debug Logs</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={handleCopy} style={styles.actionBtn}>
            <Text style={styles.actionText}>{copied ? "Copied!" : "Copy"}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={clearLogs} style={styles.actionBtn}>
            <Text style={[styles.actionText, { color: "#f55" }]}>Clear</Text>
          </TouchableOpacity>
        </View>
      </View>

      {lastCrash ? (
        <TouchableOpacity
          style={styles.crashBanner}
          onPress={() => { Clipboard.setStringAsync(lastCrash); AsyncStorage.removeItem(CRASH_KEY); setLastCrash(null); }}
        >
          <Text style={styles.crashTitle}>💥 Last crash (tap to copy + clear)</Text>
          <Text style={styles.crashText} numberOfLines={4}>{lastCrash}</Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.filters}>
        <TouchableOpacity
          style={[styles.filterChip, !filter && styles.filterChipActive]}
          onPress={() => setFilter(null)}
        >
          <Text style={[styles.filterText, !filter && styles.filterTextActive]}>All</Text>
        </TouchableOpacity>
        {tags.map((tag) => (
          <TouchableOpacity
            key={tag}
            style={[styles.filterChip, filter === tag && styles.filterChipActive]}
            onPress={() => setFilter(filter === tag ? null : tag)}
          >
            <Text style={[styles.filterText, { color: TAG_COLORS[tag] ?? "#ccc" }, filter === tag && styles.filterTextActive]}>
              {tag}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        ref={listRef}
        data={visible}
        keyExtractor={(e) => String(e.id)}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.entry}>
            <Text style={styles.entryTs}>{item.ts}</Text>
            <Text style={[styles.entryTag, { color: TAG_COLORS[item.tag] ?? "#888" }]}>
              {item.tag}
            </Text>
            <Text style={[styles.entryMsg, { color: LEVEL_COLORS[item.level] ?? "#ccc" }]} numberOfLines={4}>
              {item.msg}
            </Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No logs yet.</Text>}
      />

      <Text style={styles.count}>{visible.length} entries{filter ? ` (${filter})` : ""}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: "#1e1e1e",
  },
  back: { padding: 4, marginRight: 8 },
  backText: { color: "#4f8ef7", fontSize: 20 },
  title: { flex: 1, color: "#fff", fontSize: 16, fontWeight: "600" },
  headerActions: { flexDirection: "row", gap: 12 },
  actionBtn: { padding: 4 },
  actionText: { color: "#4f8ef7", fontSize: 14 },
  crashBanner: {
    margin: 10, padding: 12, borderRadius: 10,
    backgroundColor: "#1f0a0a", borderWidth: 1, borderColor: "#7f1d1d",
  },
  crashTitle: { color: "#f87171", fontSize: 12, fontWeight: "bold", marginBottom: 4 },
  crashText: { color: "#f87171", fontSize: 11, fontFamily: "monospace", opacity: 0.8 },
  filters: {
    flexDirection: "row", flexWrap: "wrap", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: "#1a1a1a",
  },
  filterChip: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
    backgroundColor: "#1a1a1a", borderWidth: 1, borderColor: "#2a2a2a",
  },
  filterChipActive: { backgroundColor: "#1a2a1a", borderColor: "#3a3a3a" },
  filterText: { fontSize: 12, color: "#666" },
  filterTextActive: { color: "#fff" },
  list: { padding: 8 },
  entry: {
    flexDirection: "row", alignItems: "flex-start",
    marginBottom: 3, gap: 6,
  },
  entryTs: { color: "#444", fontSize: 10, fontFamily: "Menlo", width: 80, flexShrink: 0, paddingTop: 1 },
  entryTag: { fontSize: 10, fontFamily: "Menlo", width: 52, flexShrink: 0, paddingTop: 1 },
  entryMsg: { flex: 1, fontSize: 11, fontFamily: "Menlo", lineHeight: 16 },
  empty: { color: "#444", textAlign: "center", marginTop: 40 },
  count: { color: "#333", fontSize: 11, textAlign: "center", padding: 6 },
});
