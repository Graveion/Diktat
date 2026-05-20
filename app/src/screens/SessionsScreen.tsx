import { useState } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Modal, ScrollView, SafeAreaView,
} from "react-native";
import type { DiktatSession } from "../hooks/useDiktat";

type Props = {
  sessions: DiktatSession[];
  clis: string[];
  projects: string[];
  connectedHost?: string;
  onResume: (session: DiktatSession) => void;
  onNew: (cli: string, project: string) => void;
  onDisconnect: () => void;
};

const CLI_LABELS: Record<string, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
};

export function SessionsScreen({ sessions, clis, projects, connectedHost, onResume, onNew, onDisconnect }: Props) {
  const [showPicker, setShowPicker] = useState(false);
  const [selectedCli, setSelectedCli] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  const openPicker = () => {
    setSelectedCli(clis[0] ?? null);
    setSelectedProject(projects[0] ?? null);
    setShowPicker(true);
  };

  const handleStart = () => {
    if (selectedCli && selectedProject) {
      setShowPicker(false);
      onNew(selectedCli, selectedProject);
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };

  const projectName = (path: string) => path.split("/").pop() ?? path;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Sessions</Text>
          {connectedHost ? (
            <Text style={styles.connectedHost}>{connectedHost}</Text>
          ) : null}
        </View>
        <TouchableOpacity onPress={onDisconnect}>
          <Text style={styles.disconnect}>Disconnect</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.newButton, clis.length === 0 && styles.newButtonDisabled]}
        onPress={openPicker}
        disabled={clis.length === 0}
      >
        <Text style={styles.newButtonText}>+ New Session</Text>
      </TouchableOpacity>

      <FlatList
        data={sessions}
        keyExtractor={(s) => `${s.source}:${s.id}`}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.session} onPress={() => onResume(item)}>
            <View style={styles.sessionTop}>
              <Text style={styles.sessionProject} numberOfLines={1}>
                {item.projectLabel ?? projectName(item.project)}
              </Text>
              <Text style={styles.sessionCli}>{CLI_LABELS[item.cli] ?? item.cli}</Text>
            </View>
            {item.firstMessage ? (
              <Text style={styles.sessionPreview} numberOfLines={1}>
                {typeof item.firstMessage === "string" ? item.firstMessage : ""}
              </Text>
            ) : null}
            <Text style={styles.sessionDate}>{formatDate(item.lastActiveAt)}</Text>
          </TouchableOpacity>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <Text style={styles.empty}>No sessions yet. Start a new one.</Text>
        }
      />

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
                  style={[pickerStyles.chip, selectedCli === cli && pickerStyles.chipSelected]}
                  onPress={() => setSelectedCli(cli)}
                >
                  <Text style={[pickerStyles.chipText, selectedCli === cli && pickerStyles.chipTextSelected]}>
                    {CLI_LABELS[cli] ?? cli}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

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
              <TouchableOpacity style={pickerStyles.cancelButton} onPress={() => setShowPicker(false)}>
                <Text style={pickerStyles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
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
  container: { flex: 1, backgroundColor: "#111" },
  header: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    padding: 20, paddingTop: 60,
  },
  title: { fontSize: 28, fontWeight: "bold", color: "#fff" },
  connectedHost: { fontSize: 12, color: "#4f8ef7", marginTop: 2 },
  disconnect: { color: "#888", fontSize: 14 },
  newButton: {
    margin: 16, backgroundColor: "#4f8ef7", borderRadius: 8,
    padding: 14, alignItems: "center",
  },
  newButtonDisabled: { opacity: 0.4 },
  newButtonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  session: { padding: 16 },
  sessionTop: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  sessionProject: { color: "#fff", fontSize: 16, fontWeight: "600", flex: 1 },
  sessionCli: { color: "#4f8ef7", fontSize: 12, marginLeft: 8 },
  sessionPreview: { color: "#888", fontSize: 14, marginBottom: 4 },
  sessionDate: { color: "#555", fontSize: 12 },
  separator: { height: 1, backgroundColor: "#222" },
  empty: { color: "#555", textAlign: "center", marginTop: 40 },
});

const pickerStyles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#1a1a1a", borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingBottom: 20, maxHeight: "80%",
  },
  handle: {
    width: 36, height: 4, backgroundColor: "#444", borderRadius: 2,
    alignSelf: "center", marginTop: 12, marginBottom: 20,
  },
  title: { color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 20 },
  sectionLabel: { color: "#888", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 },
  chipRow: { flexGrow: 0, marginBottom: 20 },
  chip: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
    backgroundColor: "#2a2a2a", marginRight: 8, borderWidth: 1, borderColor: "#333",
  },
  chipSelected: { backgroundColor: "#1a2a4a", borderColor: "#4f8ef7" },
  chipText: { color: "#888", fontSize: 14, fontWeight: "500" },
  chipTextSelected: { color: "#4f8ef7" },
  projectList: { maxHeight: 220, marginBottom: 20 },
  projectItem: {
    padding: 12, borderRadius: 8, backgroundColor: "#222", marginBottom: 8,
    borderWidth: 1, borderColor: "transparent",
  },
  projectItemSelected: { borderColor: "#4f8ef7", backgroundColor: "#1a2a4a" },
  projectName: { color: "#fff", fontSize: 15, fontWeight: "600", marginBottom: 2 },
  projectPath: { color: "#555", fontSize: 12 },
  actions: { flexDirection: "row", gap: 10 },
  cancelButton: {
    flex: 1, padding: 14, borderRadius: 8, backgroundColor: "#2a2a2a", alignItems: "center",
  },
  cancelText: { color: "#888", fontSize: 16 },
  startButton: {
    flex: 2, padding: 14, borderRadius: 8, backgroundColor: "#4f8ef7", alignItems: "center",
  },
  startButtonDisabled: { opacity: 0.4 },
  startText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
