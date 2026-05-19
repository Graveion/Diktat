import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "diktat_config";

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
