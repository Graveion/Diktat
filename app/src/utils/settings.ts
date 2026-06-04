import AsyncStorage from "@react-native-async-storage/async-storage";

export type MicMode = "toggle" | "hold";

export interface Settings {
  micMode: MicMode;
}

export const DEFAULT_SETTINGS: Settings = {
  micMode: "toggle",
};

export const MIC_LABELS: Record<MicMode, string> = {
  toggle: "Tap to start / tap to stop",
  hold: "Hold to talk · release to stop",
};

const KEY = "diktat:settings";

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  try {
    const current = await loadSettings();
    const next = { ...current, ...patch };
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* swallow — settings are non-critical */ }
}
