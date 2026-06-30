import { useState, useEffect, useRef } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Modal, ScrollView, Alert, ActivityIndicator, TextInput,
  KeyboardAvoidingView, Platform, Pressable,
} from "react-native";
import { Swipeable, GestureDetector, Gesture, GestureHandlerRootView } from "react-native-gesture-handler";
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring, withTiming, runOnJS } from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DiktatSession, AgentSelectionMap, PermissionModeId, StatsTotals } from "../hooks/useDiktat";
import { loadHiddenSessions, hideSession, loadSessionTitles, setSessionTitle } from "../store/config";
import { formatRunDuration } from "../utils/runStats";
import { colors, fonts } from "../theme";

type Props = {
  sessions: DiktatSession[];
  clis: string[];
  agents?: AgentSelectionMap;
  projects: string[];
  connectedHost?: string;
  connectionState?: string;
  loading: boolean;
  onResume: (session: DiktatSession) => void;
  onNew: (cli: string, project: string, model?: string, permissionMode?: PermissionModeId, effort?: string) => void;
  onDisconnect: () => void;
  onOpenDebug?: () => void;
  /** Locally-persisted overall usage totals from the daemon. */
  overallStats?: StatsTotals | null;
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

// Tidy a raw first-message into a more legible title: drop leading politeness,
// code fences and markdown noise, collapse whitespace. Best-effort, never AI.
function cleanPreview(raw?: string): string | null {
  if (typeof raw !== "string") return null;
  let t = raw.replace(/```[\s\S]*?```/g, " ").replace(/`([^`]+)`/g, "$1");
  t = t.replace(/^\s*(?:hey|hi|hello|ok(?:ay)?|so|please|can you|could you|would you|i(?:'| a)m trying to|let'?s)\b[,:]?\s*/i, "");
  t = t.replace(/[#*_>]+/g, " ").replace(/\s+/g, " ").trim();
  if (t) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t || null;
}

function SessionCard({ session: s, customTitle, showProject, onPress, onHide, onRename, formatDate }: {
  session: DiktatSession; customTitle?: string; showProject?: string;
  onPress: () => void; onHide: () => void; onRename: () => void;
  formatDate: (iso: string) => string;
}) {
  const renderRightActions = () => (
    <View style={styles.rowActions}>
      <TouchableOpacity style={styles.renameAction} onPress={onRename}>
        <Text style={styles.renameActionText}>Rename</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.hideAction} onPress={onHide}>
        <Text style={styles.hideActionText}>Hide</Text>
      </TouchableOpacity>
    </View>
  );

  const preview = customTitle?.trim() || cleanPreview(s.firstMessage);

  return (
    <Swipeable renderRightActions={renderRightActions} overshootRight={false}>
      <TouchableOpacity
        style={styles.sessionCard}
        onPress={onPress}
        onLongPress={onRename}
        activeOpacity={0.7}
        testID={`session-card-${s.id}`}
      >
        <View style={styles.sessionCardInner}>
          <View style={styles.sessionTop}>
            <Text style={[styles.sessionTitle, !preview && styles.sessionTitleEmpty]} numberOfLines={2}>
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
          <Text style={styles.sessionDate}>{formatDate(s.lastActiveAt)}</Text>
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

export function SessionsScreen({ sessions, clis, agents = {}, projects, connectedHost, connectionState, loading, onResume, onNew, onDisconnect, onOpenDebug, overallStats }: Props) {
  const insets = useSafeAreaInsets();
  const [showPicker, setShowPicker] = useState(false);
  const [selectedCli, setSelectedCli] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(""); // "" = CLI default
  const [selectedPermission, setSelectedPermission] = useState<PermissionModeId>("auto");
  const [selectedEffort, setSelectedEffort] = useState<string>(""); // "" = CLI default
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [renameTarget, setRenameTarget] = useState<DiktatSession | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [titleTaps, setTitleTaps] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadHiddenSessions().then(setHiddenIds);
    loadSessionTitles().then(setTitles);
  }, []);

  // New-session sheet: drag the handle down to dismiss (preferred exit, alongside
  // tapping the backdrop). Reset the offset each time the sheet opens.
  const sheetY = useSharedValue(0);
  useEffect(() => { if (showPicker) sheetY.value = 0; }, [showPicker, sheetY]);
  const closePicker = () => setShowPicker(false);
  const sheetPan = Gesture.Pan()
    .onUpdate((e) => { sheetY.value = Math.max(0, e.translationY); })
    .onEnd((e) => {
      if (e.translationY > 110 || e.velocityY > 800) {
        sheetY.value = withTiming(0, { duration: 150 });
        runOnJS(closePicker)();
      } else {
        sheetY.value = withSpring(0, { damping: 18, stiffness: 200 });
      }
    });
  const sheetAnim = useAnimatedStyle(() => ({ transform: [{ translateY: sheetY.value }] }));

  const visibleSessions = sessions.filter((s) => !hiddenIds.has(s.id));

  const openPicker = () => {
    setSelectedCli(clis[0] ?? null);
    setSelectedProject(projects[0] ?? null);
    setSelectedModel("");
    setSelectedPermission("auto");
    setSelectedEffort("");
    setShowPicker(true);
  };

  // Reset model/permission/effort to defaults whenever the chosen CLI changes.
  const pickCli = (cli: string) => {
    setSelectedCli(cli);
    setSelectedModel("");
    setSelectedPermission("auto");
    setSelectedEffort("");
  };

  const handleStart = () => {
    if (selectedCli && selectedProject) {
      setShowPicker(false);
      onNew(selectedCli, selectedProject, selectedModel || undefined, selectedPermission, selectedEffort || undefined);
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

  const openRename = (session: DiktatSession) => {
    setRenameTarget(session);
    // Prefill only with an existing custom title; otherwise start blank (the
    // current auto-title is shown as a hint above the box).
    setRenameValue(titles[session.id] ?? "");
  };

  const saveRename = async () => {
    if (!renameTarget) return;
    const next = await setSessionTitle(renameTarget.id, renameValue);
    setTitles(next);
    setRenameTarget(null);
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
      <View style={[styles.header, { paddingTop: insets.top + 18 }]}>
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
        <TouchableOpacity onPress={handleDisconnect} accessibilityRole="button" accessibilityLabel="Disconnect from machine">
          <Text style={styles.disconnect}>Disconnect</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.toolbar}>
        {visibleSessions.length > 0 ? (
          <TextInput
            testID="session-search-input"
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search sessions…"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
          />
        ) : (
          <Text style={styles.toolbarHint} numberOfLines={1}>Start a new session</Text>
        )}
        <TouchableOpacity
          testID="new-session-button"
          style={[styles.addButton, clis.length === 0 && styles.addButtonDisabled]}
          onPress={openPicker}
          disabled={clis.length === 0}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="New session"
        >
          <Ionicons name="add" size={26} color={colors.onAccent} />
        </TouchableOpacity>
      </View>
      {connectionState === "connected" && clis.length === 0 ? (
        <Text style={styles.noAgents}>
          No coding agents detected on this machine. Check `diktat logs` on your Mac.
        </Text>
      ) : null}

      {overallStats && overallStats.runs > 0 ? (
        <View style={styles.usageStrip}>
          <Ionicons name="pulse-outline" size={13} color={colors.accent} />
          <Text style={styles.usageText} numberOfLines={1}>
            {overallStats.runs} runs · {overallStats.filesChanged} files · +{overallStats.linesAdded}/−{overallStats.linesRemoved} · {overallStats.commandsRun} cmd · {formatRunDuration(overallStats.durationMs)}
          </Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>Loading sessions…</Text>
        </View>
      ) : (() => {
        const query = searchQuery.trim().toLowerCase();
        if (query) {
          // Flat filtered list
          const filtered = visibleSessions.filter((s) =>
            projectName(s.project).toLowerCase().includes(query) ||
            (titles[s.id] ?? "").toLowerCase().includes(query) ||
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
                    customTitle={titles[item.id]}
                    showProject={projectLabel}
                    onPress={() => onResume(item)}
                    onHide={() => handleHide(item)}
                    onRename={() => openRename(item)}
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
                  customTitle={titles[s.id]}
                  onPress={() => onResume(s)}
                  onHide={() => handleHide(s)}
                  onRename={() => openRename(s)}
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

      <Modal visible={showPicker} animationType="slide" transparent onRequestClose={closePicker}>
        {/* RNGH gestures need their own root inside a Modal's separate view tree. */}
        <GestureHandlerRootView style={{ flex: 1 }}>
        <Pressable style={pickerStyles.overlay} onPress={closePicker}>
          <Reanimated.View style={sheetAnim}>
            <Pressable onPress={() => {}}>
              <View style={[pickerStyles.sheet, { paddingBottom: insets.bottom + 20 }]}>
                <GestureDetector gesture={sheetPan}>
                  <View style={pickerStyles.grabber} accessibilityRole="button" accessibilityLabel="Drag down to dismiss">
                    <View style={pickerStyles.handle} />
                  </View>
                </GestureDetector>
                <Text style={pickerStyles.title}>New Session</Text>

                <ScrollView style={pickerStyles.body} showsVerticalScrollIndicator={false}>
                <Text style={pickerStyles.sectionLabel}>Agent</Text>
            <View style={pickerStyles.chipRow}>
              {clis.map((cli) => (
                <TouchableOpacity
                  key={cli}
                  testID={`cli-${cli}`}
                  style={[pickerStyles.chip, selectedCli === cli && pickerStyles.chipSelected]}
                  onPress={() => pickCli(cli)}
                >
                  <Text style={[pickerStyles.chipText, selectedCli === cli && pickerStyles.chipTextSelected]}>
                    {CLI_LABELS[cli] ?? cli}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {selectedCli && (agents[selectedCli]?.models?.length ?? 0) > 1 ? (
              <>
                <Text style={pickerStyles.sectionLabel}>Model</Text>
                <View style={pickerStyles.chipRow}>
                  {agents[selectedCli]!.models.map((m) => (
                    <TouchableOpacity
                      key={m.id || "default"}
                      testID={`model-${m.id || "default"}`}
                      style={[pickerStyles.chip, selectedModel === m.id && pickerStyles.chipSelected]}
                      onPress={() => setSelectedModel(m.id)}
                    >
                      <Text style={[pickerStyles.chipText, selectedModel === m.id && pickerStyles.chipTextSelected]}>
                        {m.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}

            {selectedCli ? (
              <>
                <Text style={pickerStyles.sectionLabel}>Permissions</Text>
                <View style={pickerStyles.chipRow}>
                  {(agents[selectedCli]?.permissionModes ?? [
                    { id: "plan" as PermissionModeId, label: "Plan · read-only" },
                    { id: "auto" as PermissionModeId, label: "Auto-accept edits" },
                    { id: "full" as PermissionModeId, label: "Full access" },
                  ]).map((p) => (
                    <TouchableOpacity
                      key={p.id}
                      testID={`perm-${p.id}`}
                      style={[pickerStyles.chip, selectedPermission === p.id && pickerStyles.chipSelected]}
                      onPress={() => setSelectedPermission(p.id)}
                    >
                      <Text style={[pickerStyles.chipText, selectedPermission === p.id && pickerStyles.chipTextSelected]}>
                        {p.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}

            {selectedCli && (agents[selectedCli]?.efforts?.length ?? 0) > 0 ? (
              <>
                <Text style={pickerStyles.sectionLabel}>Reasoning effort</Text>
                <View style={pickerStyles.chipRow}>
                  {agents[selectedCli]!.efforts!.map((e) => (
                    <TouchableOpacity
                      key={e.id || "default"}
                      testID={`effort-${e.id || "default"}`}
                      style={[pickerStyles.chip, selectedEffort === e.id && pickerStyles.chipSelected]}
                      onPress={() => setSelectedEffort(e.id)}
                    >
                      <Text style={[pickerStyles.chipText, selectedEffort === e.id && pickerStyles.chipTextSelected]}>
                        {e.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}

            <Text style={pickerStyles.sectionLabel}>Project</Text>
            <View style={pickerStyles.projectList}>
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
            </View>
                </ScrollView>

                <TouchableOpacity
                  testID="start-session-button"
                  style={[pickerStyles.startButton, pickerStyles.startButtonBlock, (!selectedCli || !selectedProject) && pickerStyles.startButtonDisabled]}
                  onPress={handleStart}
                  disabled={!selectedCli || !selectedProject}
                >
                  <Text style={pickerStyles.startText}>Start session</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Reanimated.View>
        </Pressable>
        </GestureHandlerRootView>
      </Modal>

      <Modal visible={!!renameTarget} animationType="fade" transparent onRequestClose={() => setRenameTarget(null)}>
        <KeyboardAvoidingView
          style={styles.renameOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setRenameTarget(null)} />
          <View style={styles.renameSheet}>
            <Text style={styles.renameTitle}>Rename session</Text>
            {renameTarget ? (
              <Text style={styles.renameCurrent} numberOfLines={1}>
                Currently: {cleanPreview(renameTarget.firstMessage) ?? "Empty session"}
              </Text>
            ) : null}
            <TextInput
              style={styles.renameInput}
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder="New title"
              placeholderTextColor={colors.textMuted}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              onSubmitEditing={saveRename}
            />
            <Text style={styles.renameHint}>Leave empty to restore the default title.</Text>
            <View style={pickerStyles.actions}>
              <TouchableOpacity style={pickerStyles.cancelButton} onPress={() => setRenameTarget(null)}>
                <Text style={pickerStyles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={pickerStyles.startButton} onPress={saveRename}>
                <Text style={pickerStyles.startText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end",
    paddingHorizontal: 20, paddingBottom: 16,
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

  toolbar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4,
  },
  toolbarHint: { flex: 1, fontFamily: fonts.body, color: colors.textMuted, fontSize: 14, paddingVertical: 11 },
  usageStrip: {
    flexDirection: "row", alignItems: "center", gap: 7,
    marginHorizontal: 16, marginTop: 8, marginBottom: 2,
    paddingHorizontal: 12, paddingVertical: 7,
    backgroundColor: colors.card, borderRadius: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  usageText: { flex: 1, fontFamily: fonts.mono, color: colors.textSub, fontSize: 11 },
  addButton: {
    width: 46, height: 46, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
    backgroundColor: colors.accent,
  },
  addButtonDisabled: { opacity: 0.35 },
  noAgents: { fontFamily: fonts.body, color: colors.textSub, fontSize: 12, textAlign: "center", marginTop: 10, marginHorizontal: 16, lineHeight: 17 },

  searchInput: {
    flex: 1,
    fontFamily: fonts.body,
    backgroundColor: colors.card,
    color: colors.text,
    borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 11,
    fontSize: 14,
    height: 46,
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

  rowActions: { flexDirection: "row", marginRight: 12 },
  renameAction: {
    backgroundColor: colors.card, justifyContent: "center",
    alignItems: "center", width: 72, marginVertical: 3, marginRight: 6, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  renameActionText: { fontFamily: fonts.bodySemi, color: colors.accent, fontSize: 13 },
  hideAction: {
    backgroundColor: colors.error, justifyContent: "center",
    alignItems: "center", width: 72, marginVertical: 3, borderRadius: 12,
  },
  hideActionText: { fontFamily: fonts.bodySemi, color: "#fff", fontSize: 13 },

  renameOverlay: { flex: 1, justifyContent: "center", backgroundColor: "rgba(0,0,0,0.75)" },
  renameSheet: {
    marginHorizontal: 24, backgroundColor: colors.surface, borderRadius: 16,
    padding: 20, borderWidth: 1, borderColor: colors.border,
  },
  renameTitle: { fontFamily: fonts.display, fontSize: 18, color: colors.text, marginBottom: 4 },
  renameCurrent: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, marginBottom: 14 },
  renameInput: {
    fontFamily: fonts.body, backgroundColor: colors.input, color: colors.text,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15,
    borderWidth: 1, borderColor: colors.border,
  },
  renameHint: { fontFamily: fonts.body, color: colors.textMuted, fontSize: 12, marginTop: 8 },

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
    paddingHorizontal: 26, paddingBottom: 28, maxHeight: "88%",
    borderTopWidth: 1, borderColor: colors.border,
  },
  // Generous hit area around the handle so it's an easy drag target.
  grabber: { alignSelf: "stretch", alignItems: "center", paddingTop: 10, paddingBottom: 16 },
  handle: { width: 40, height: 4, backgroundColor: colors.textMuted, borderRadius: 2 },
  title: { fontFamily: fonts.display, color: colors.text, fontSize: 22, marginBottom: 16, letterSpacing: -0.3 },
  sectionLabel: {
    fontFamily: fonts.bodyMedium, color: colors.textSub, fontSize: 10,
    textTransform: "uppercase", letterSpacing: 1, marginBottom: 8,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  chip: {
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 20,
    backgroundColor: colors.input, borderWidth: 1, borderColor: colors.border,
  },
  chipSelected: { backgroundColor: colors.accentFaint, borderColor: colors.accent },
  chipText: { fontFamily: fonts.bodyMedium, color: colors.textSub, fontSize: 14 },
  chipTextSelected: { color: colors.accent },
  body: { flexShrink: 1 },
  projectList: { marginBottom: 4 },
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
  startButtonBlock: { flex: 0, marginTop: 4 }, // full-width, content-height (picker has no Cancel)
  startText: { fontFamily: fonts.bodySemi, color: "#fff", fontSize: 15 },
});
