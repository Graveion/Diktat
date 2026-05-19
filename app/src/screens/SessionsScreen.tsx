import { View, Text, FlatList, TouchableOpacity, StyleSheet } from "react-native";
import type { DiktatSession } from "../hooks/useDiktat";

type Props = {
  sessions: DiktatSession[];
  clis: string[];
  projects: string[];
  onResume: (session: DiktatSession) => void;
  onNew: (cli: string, project: string) => void;
  onDisconnect: () => void;
};

export function SessionsScreen({ sessions, clis, projects, onResume, onNew, onDisconnect }: Props) {
  const handleNew = () => {
    if (clis.length > 0 && projects.length > 0) {
      onNew(clis[0], projects[0]);
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Sessions</Text>
        <TouchableOpacity onPress={onDisconnect}>
          <Text style={styles.disconnect}>Disconnect</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.newButton} onPress={handleNew}>
        <Text style={styles.newButtonText}>+ New Session</Text>
      </TouchableOpacity>

      <FlatList
        data={sessions}
        keyExtractor={(s) => `${s.source}:${s.id}`}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.session} onPress={() => onResume(item)}>
            <View style={styles.sessionTop}>
              <Text style={styles.sessionProject}>
                {item.projectLabel ?? item.project.split("/").pop()}
              </Text>
              <Text style={styles.sessionCli}>{item.cli}</Text>
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
  disconnect: { color: "#888", fontSize: 14 },
  newButton: {
    margin: 16, backgroundColor: "#4f8ef7", borderRadius: 8,
    padding: 14, alignItems: "center",
  },
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
