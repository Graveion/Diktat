import { useState, useEffect, useRef } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Modal, ScrollView, SafeAreaView, Alert, ActivityIndicator, TextInput,
} from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { FadeInDown, FadeInUp } from "react-native-reanimated";
import type { DiktatSession } from "../hooks/useDiktat";
import { loadHiddenSessions, hideSession } from "../store/config";
import { colors, fonts } from "../theme";

type Props = {
  sessions: DiktatSession[];
  clis: string[];
  projects: string[];
  connectedHost?: string;
  connectionState?: string;
  loading: boolean;
  onResume: (session: DiktatSession) => void;
  onNew: (cli: string, project: string, mode?: string) => void;
  onDisconnect: () => void;
  onOpenDebug?: () => void;
};

const CLI_LABELS: Record<string, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
  kiro: "Kiro",
  codex: "Codex",
};

const CLI_COLOR: Record<string, string> = {
  claude: "#f59e0b",
  cursor: "#a78bfa",
  copilot: "#3fb950",
  kiro: "#06b6d4",
  codex: "#ec4899",
};

function SessionCard({ session: s, showProject, onPress, onHide, formatDate }: {
  session: DiktatSession; showProject?: string;
  onPress: () => void; onHide: () => void;
  formatDate: (iso: string) => string;
}) {
  const renderRightActions = () => (
    <TouchableOpacity style={styles.hideAction} onPress={onHide}>
      <Text style={styles.hideActionText}>Hide</Text>
    </TouchableOpacity>
  );

  const preview = typeof s.firstMessage === "string" && s.firstMessage.trim()
    ? s.firstMessage.trim()
    : null;
  const shortId = s.id.slice(0, 8);

  return (
    <Swipeable renderRightActions={renderRightActions} overshootRight={false}>
      <TouchableOpacity
        style={styles.sessionCard}
        onPress={onPress}
        activeOpacity={0.7}
        testID={`session-card-${s.id}`}
      >
        <View style={styles.sessionCardInner}>
          <View style={styles.sessionTop}>
            <Text style={[styles.sessionTitle, !preview && styles.sessionTitleEmpty]} numberOfLines={1}>
              {preview ?? "Empty session"}
            </Text>
            <View style={[styles.cliBadge, { borderColor: CLI_COLOR[s.cli] ?? colors.border }]}>
              <Text style={[styles.cliBadgeText, { color: CLI_COLOR[s.cli] ?? colors.textSub }]}>
                {CLI_LABELS[s.cli] ?? s.cli}
              </Text>
            </View>
          </View>
          {showProject ? (
            <Text style={styles.sessionProjectLabel} numberOfLines={1}>{showProject}</Text>
          ) : null}
          <Text style={styles.sessionDate}>{formatDate(s.lastActiveAt)}  ·  {shortId}</Text>
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
}

// Generic folder names that don't describe a project on their own
const GENERIC_NAMES = new Set([
  "ios", "android", "app", "src", "main", "web", "client", "server",
  "frontend", "backend", "mobile", "native", "packages", "apps",
]);

function projectName(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function projectContext(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[parts.length - 1] ?? path;
}

// Returns the most descriptive name: falls back to parent/name if the
// last segment alone is too generic (e.g. "ios", "app", "src")
function bestProjectName(path: string) {
  const last = projectName(path);
  if (GENERIC_NAMES.has(last.toLowerCase())) return projectContext(path);
  return last;
}

export function SessionsScreen({ sessions, clis, projects, connectedHost, connectionState, loading, onResume, onNew, onDisconnect, onOpenDebug }: Props) {
  const [showPicker, setShowPicker] = useState(false);
  const [selectedCli, setSelectedCli] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [titleTaps, setTitleTaps] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadHiddenSessions().then(setHiddenIds);
  }, []);

  const visibleSessions = sessions.filter((s) => !hiddenIds.has(s.id));

  const openPicker = () => {
    setSelectedCli(clis[0] ?? null);
    setSelectedProject(projects[0] ?? null);
    setSelectedMode(null);
    setShowPicker(true);
  };

  const handleStart = () => {
    if (selectedCli && selectedProject) {
      setShowPicker(false);
      onNew(selectedCli, selectedProject, selectedMode ?? undefined);
    }
  };

  const handleDisconnect = () => {
    Alert.alert("Disconnect", "Disconnect from the daemon?", [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: onDisconnect },
    ]);
  };

  const handleHide = async (session: DiktatSession) => {
    await hideSession(session.id);
    setHiddenIds((prev) => new Set([...prev, session.id]));
  };

  const handleLongPress = (session: DiktatSession) => {
    Alert.alert(
      projectContext(session.project),
      "Hide this session from the list?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Hide",
          style: "destructive",
          onPress: async () => {
            await hideSession(session.id);
            setHiddenIds((prev) => new Set([...prev, session.id]));
          },
        },
      ]
    );
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };

  // Detect duplicate project names to know when to show extra context
  const nameCounts = new Map<string, number>();
  sessions.forEach((s) => {
    const n = projectName(s.project);
    nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
  });

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {
            const next = titleTaps + 1;
            setTitleTaps(next);
            if (tapTimer.current) clearTimeout(tapTimer.current);
            if (next >= 5) { setTitleTaps(0); onOpenDebug?.(); return; }
            tapTimer.current = setTimeout(() => setTitleTaps(0), 2000);
          }}
        >
          <View style={styles.titleRow}>
            <Text style={styles.title}>Sessions</Text>
            <View style={[styles.healthDot, (() => {
              const c = connectionState === "connected" ? colors.success :
                connectionState === "connecting" ? colors.warning : colors.error;
              return { backgroundColor: c, shadowColor: c };
            })()] } />
          </View>
          {connectedHost ? (
            <Text style={styles.connectedHost}>{connectedHost}</Text>
          ) : null}
        </TouchableOpacity>
        <TouchableOpacity onPress={handleDisconnect}>
          <Text style={styles.disconnect}>Disconnect</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.newButtonWrap}>
        <TouchableOpacity
          testID="new-session-button"
          style={[styles.newButton, clis.length === 0 && styles.newButtonDisabled]}
          onPress={openPicker}
          disabled={clis.length === 0}
          activeOpacity={0.8}
        >
          <LinearGradient
            colors={[colors.accent, "#6d28d9"]}
            style={StyleSheet.absoluteFill}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          />
          <Text style={styles.newButtonText}>+ New Session</Text>
        </TouchableOpacity>
      </View>

      {visibleSessions.length > 0 && (
        <TextInput
          testID="session-search-input"
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search sessions…"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
        />
      )}

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color="#4f8ef7" />
          <Text style={styles.loadingText}>Loading sessions…</Text>
        </View>
      ) : (() => {
        const query = searchQuery.trim().toLowerCase();
        if (query) {
          // Flat filtered list
          const filtered = visibleSessions.filter((s) =>
            projectName(s.project).toLowerCase().includes(query) ||
            (s.firstMessage ?? "").toLowerCase().includes(query)
          );
          return (
            <FlatList
              data={filtered}
              keyExtractor={(s) => `${s.source}:${s.id}`}
              renderItem={({ item }) => {
                const nameAmbiguous = (nameCounts.get(projectName(item.project)) ?? 0) > 1;
                const projectLabel = item.projectLabel ?? (nameAmbiguous ? projectContext(item.project) : bestProjectName(item.project));
                return (
                  <SessionCard
                    session={item}
                    showProject={projectLabel}
                    onPress={() => onResume(item)}
                    onHide={() => handleHide(item)}
                    formatDate={formatDate}
                  />
                );
              }}
              ItemSeparatorComponent={() => <View style={styles.separator} />}
              ListEmptyComponent={
                <Text style={styles.empty}>No matching sessions.</Text>
              }
            />
          );
        }

        // Grouped by project, sorted by most-recent session lastActiveAt desc
        const groupMap = new Map<string, { project: string; sessions: DiktatSession[] }>();
        for (const s of visibleSessions) {
          const key = s.project;
          if (!groupMap.has(key)) groupMap.set(key, { project: key, sessions: [] });
          groupMap.get(key)!.sessions.push(s);
        }
        const groups = Array.from(groupMap.values()).sort((a, b) => {
          const aLatest = a.sessions.reduce((best, s) => s.lastActiveAt > best ? s.lastActiveAt : best, "");
          const bLatest = b.sessions.reduce((best, s) => s.lastActiveAt > best ? s.lastActiveAt : best, "");
          return bLatest.localeCompare(aLatest);
        });

        type ListItem =
          | { kind: "header"; project: string }
          | { kind: "session"; session: DiktatSession };

        const listData: ListItem[] = [];
        for (const group of groups) {
          listData.push({ kind: "header", project: group.project });
          for (const s of group.sessions) {
            listData.push({ kind: "session", session: s });
          }
        }

        return (
          <FlatList
            data={listData}
            keyExtractor={(item, i) => item.kind === "header" ? `header:${item.project}` : `${item.session.source}:${item.session.id}`}
            renderItem={({ item }) => {
              if (item.kind === "header") {
                return <Text style={styles.groupHeader}>{bestProjectName(item.project)}</Text>;
              }
              const { session: s } = item;
              return (
                <SessionCard
                  session={s}
                  onPress={() => onResume(s)}
                  onHide={() => handleHide(s)}
                  formatDate={formatDate}
                />
              );
            }}
            ItemSeparatorComponent={({ leadingItem }) =>
              leadingItem?.kind === "header" ? null : <View style={styles.separator} />
            }
            ListEmptyComponent={
              <Text style={styles.empty}>No sessions yet. Start a new one.</Text>
            }
          />
        );
      })()}

      <Modal visible={showPicker} animationType="slide" transparent>
        <View style={pickerStyles.overlay}>
          <SafeAreaView style={pickerStyles.sheet}>
            <View style={pickerStyles.handle} />
            <Text style={pickerStyles.title}>New Session</Text>

            <Text style={pickerStyles.sectionLabel}>Agent</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={pickerStyles.chipRow}>
              {clis.map((cli) => (
                <TouchableOpacity
                  key={cli}
                  testID={`cli-${cli}`}
                  style={[pickerStyles.chip, selectedCli === cli && pickerStyles.chipSelected]}
                  onPress={() => { setSelectedCli(cli); if (cli !== "cursor") setSelectedMode(null); }}
                >
                  <Text style={[pickerStyles.chipText, selectedCli === cli && pickerStyles.chipTextSelected]}>
                    {CLI_LABELS[cli] ?? cli}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {selectedCli === "cursor" ? (
              <>
                <Text style={pickerStyles.sectionLabel}>Cursor Mode</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={pickerStyles.chipRow}>
                  {[
                    { value: null, label: "Agent" },
                    { value: "plan", label: "Plan" },
                    { value: "ask", label: "Ask" },
                  ].map(({ value, label }) => (
                    <TouchableOpacity
                      key={label}
                      style={[pickerStyles.chip, selectedMode === value && pickerStyles.chipSelected]}
                      onPress={() => setSelectedMode(value)}
                    >
                      <Text style={[pickerStyles.chipText, selectedMode === value && pickerStyles.chipTextSelected]}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </>
            ) : null}

            <Text style={pickerStyles.sectionLabel}>Project</Text>
            <ScrollView style={pickerStyles.projectList} showsVerticalScrollIndicator={false}>
              {projects.map((project) => (
                <TouchableOpacity
                  key={project}
                  style={[pickerStyles.projectItem, selectedProject === project && pickerStyles.projectItemSelected]}
                  onPress={() => setSelectedProject(project)}
                >
                  <Text style={pickerStyles.projectName}>{projectName(project)}</Text>
                  <Text style={pickerStyles.projectPath} numberOfLines={1}>{project}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <View style={pickerStyles.actions}>
              <TouchableOpacity testID="cancel-new-session-button" style={pickerStyles.cancelButton} onPress={() => setShowPicker(false)}>
                <Text style={pickerStyles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="start-session-button"
                style={[pickerStyles.startButton, (!selectedCli || !selectedProject) && pickerStyles.startButtonDisabled]}
                onPress={handleStart}
                disabled={!selectedCli || !selectedProject}
              >
                <Text style={pickerStyles.startText}>Start</Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end",
    paddingHorizontal: 20, paddingTop: 64, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: colors.borderFaint,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontFamily: fonts.display, fontSize: 30, color: colors.text, letterSpacing: -0.5 },
  healthDot: {
    width: 9, height: 9, borderRadius: 5, marginBottom: 2,
    borderWidth: 1.5, borderColor: "rgba(255,255,255,0.15)",
    shadowRadius: 6, shadowOpacity: 0.9, shadowOffset: { width: 0, height: 0 },
  },
  connectedHost: { fontFamily: fonts.body, fontSize: 11, color: colors.accent, marginTop: 2 },
  disconnect: { fontFamily: fonts.body, color: colors.textSub, fontSize: 13, paddingBottom: 4 },

  newButtonWrap: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  newButton: {
    borderRadius: 12, padding: 15, alignItems: "center",
    overflow: "hidden",
  },
  newButtonDisabled: { opacity: 0.35 },
  newButtonText: { fontFamily: fonts.bodySemi, color: "#fff", fontSize: 15 },

  searchInput: {
    fontFamily: fonts.body,
    backgroundColor: colors.card,
    color: colors.text,
    borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 11,
    fontSize: 14,
    marginHorizontal: 16, marginBottom: 4,
    borderWidth: 1, borderColor: colors.border,
  },

  loadingContainer: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontFamily: fonts.body, color: colors.textSub, fontSize: 14 },

  sessionCard: { marginHorizontal: 12, marginVertical: 3 },
  sessionCardInner: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sessionTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 5 },
  sessionTitle: { fontFamily: fonts.bodySemi, color: colors.text, fontSize: 14, flex: 1, marginRight: 8, lineHeight: 20 },
  sessionTitleEmpty: { color: colors.textMuted, fontFamily: fonts.body, fontStyle: "italic" },
  sessionProjectLabel: { fontFamily: fonts.body, color: colors.textSub, fontSize: 12, marginBottom: 5 },
  cliBadge: {
    paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: 6, borderWidth: 1,
  },
  cliBadgeText: { fontFamily: fonts.bodyMedium, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  sessionDate: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 11 },

  hideAction: {
    backgroundColor: colors.error, justifyContent: "center",
    alignItems: "center", width: 72, marginVertical: 3, marginRight: 12, borderRadius: 12,
  },
  hideActionText: { fontFamily: fonts.bodySemi, color: "#fff", fontSize: 13 },

  separator: { height: 0 },
  empty: { fontFamily: fonts.body, color: colors.textSub, textAlign: "center", marginTop: 48, fontSize: 14 },
  groupHeader: {
    fontFamily: fonts.bodySemi,
    color: colors.text,
    fontSize: 13,
    letterSpacing: 0,
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 6,
  },
});

const pickerStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.75)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 20, paddingBottom: 24, maxHeight: "85%",
    borderTopWidth: 1, borderColor: colors.border,
  },
  handle: {
    width: 32, height: 3, backgroundColor: colors.border, borderRadius: 2,
    alignSelf: "center", marginTop: 12, marginBottom: 22,
  },
  title: { fontFamily: fonts.display, color: colors.text, fontSize: 22, marginBottom: 22, letterSpacing: -0.3 },
  sectionLabel: {
    fontFamily: fonts.bodyMedium, color: colors.textSub, fontSize: 10,
    textTransform: "uppercase", letterSpacing: 1, marginBottom: 10,
  },
  chipRow: { flexGrow: 0, marginBottom: 20 },
  chip: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
    backgroundColor: colors.input, marginRight: 8, borderWidth: 1, borderColor: colors.border,
  },
  chipSelected: { backgroundColor: colors.accentFaint, borderColor: colors.accent },
  chipText: { fontFamily: fonts.bodyMedium, color: colors.textSub, fontSize: 14 },
  chipTextSelected: { color: colors.accent },
  projectList: { maxHeight: 220, marginBottom: 20 },
  projectItem: {
    padding: 12, borderRadius: 10, backgroundColor: colors.input, marginBottom: 6,
    borderWidth: 1, borderColor: "transparent",
  },
  projectItemSelected: { borderColor: colors.accent, backgroundColor: colors.accentFaint },
  projectName: { fontFamily: fonts.bodySemi, color: colors.text, fontSize: 15, marginBottom: 2 },
  projectPath: { fontFamily: fonts.body, color: colors.textSub, fontSize: 11 },
  actions: { flexDirection: "row", gap: 10 },
  cancelButton: { flex: 1, padding: 14, borderRadius: 10, backgroundColor: colors.input, alignItems: "center" },
  cancelText: { fontFamily: fonts.bodyMedium, color: colors.textSub, fontSize: 15 },
  startButton: {
    flex: 2, padding: 14, borderRadius: 10,
    backgroundColor: colors.accent, alignItems: "center", overflow: "hidden",
  },
  startButtonDisabled: { opacity: 0.35 },
  startText: { fontFamily: fonts.bodySemi, color: "#fff", fontSize: 15 },
});
