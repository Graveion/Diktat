import AsyncStorage from "@react-native-async-storage/async-storage";

const HIDDEN_KEY = "diktat_hidden_sessions";

export async function loadHiddenSessions(): Promise<Set<string>> {
  const raw = await AsyncStorage.getItem(HIDDEN_KEY);
  return new Set(raw ? JSON.parse(raw) : []);
}

export async function hideSession(id: string): Promise<void> {
  const hidden = await loadHiddenSessions();
  hidden.add(id);
  await AsyncStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
}
