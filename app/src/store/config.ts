import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "diktat_config";
const HIDDEN_KEY = "diktat_hidden_sessions";
const RECENT_HOSTS_KEY = "diktat_recent_hosts";

export interface DiktatConfig {
  host: string;
  port: number;
}

const DEFAULT: DiktatConfig = { host: "", port: 9000 };

export async function loadConfig(): Promise<DiktatConfig> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? { ...DEFAULT, ...JSON.parse(raw) } : DEFAULT;
}

export async function saveConfig(config: DiktatConfig): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(config));
}

export async function loadHiddenSessions(): Promise<Set<string>> {
  const raw = await AsyncStorage.getItem(HIDDEN_KEY);
  return new Set(raw ? JSON.parse(raw) : []);
}

export async function hideSession(id: string): Promise<void> {
  const hidden = await loadHiddenSessions();
  hidden.add(id);
  await AsyncStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
}

export interface SavedHost {
  host: string;
  port: number;
}

export async function loadRecentHosts(): Promise<SavedHost[]> {
  const raw = await AsyncStorage.getItem(RECENT_HOSTS_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function saveRecentHost(host: string, port: number): Promise<void> {
  const recent = await loadRecentHosts();
  // Move to front, deduplicate by host, keep max 5
  const filtered = recent.filter((h) => h.host !== host);
  const updated = [{ host, port }, ...filtered].slice(0, 5);
  await AsyncStorage.setItem(RECENT_HOSTS_KEY, JSON.stringify(updated));
}
