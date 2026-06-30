import AsyncStorage from "@react-native-async-storage/async-storage";

const HIDDEN_KEY = "diktat_hidden_sessions";
const TITLES_KEY = "diktat_session_titles";

export async function loadHiddenSessions(): Promise<Set<string>> {
  const raw = await AsyncStorage.getItem(HIDDEN_KEY);
  return new Set(raw ? JSON.parse(raw) : []);
}

export async function hideSession(id: string): Promise<void> {
  const hidden = await loadHiddenSessions();
  hidden.add(id);
  await AsyncStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
}

/** User-assigned session titles, stored locally (sessionId → title). */
export async function loadSessionTitles(): Promise<Record<string, string>> {
  const raw = await AsyncStorage.getItem(TITLES_KEY);
  return raw ? JSON.parse(raw) : {};
}

/** Set (or, with an empty title, clear) a custom title for a session. */
export async function setSessionTitle(id: string, title: string): Promise<Record<string, string>> {
  const titles = await loadSessionTitles();
  const trimmed = title.trim();
  if (trimmed) titles[id] = trimmed;
  else delete titles[id];
  await AsyncStorage.setItem(TITLES_KEY, JSON.stringify(titles));
  return titles;
}
