import AsyncStorage from "@react-native-async-storage/async-storage";

export type AutoSendMode = "aggressive" | "normal" | "relaxed" | "manual";
export type MicMode = "toggle" | "hold";

export interface Settings {
  autoSendMode: AutoSendMode;
  micMode: MicMode;
  ttsEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoSendMode: "normal",
  micMode: "toggle",
  ttsEnabled: false,
};

export const MIC_LABELS: Record<MicMode, string> = {
  toggle: "Tap to start / tap to stop",
  hold: "Hold to talk · release to stop",
};

// Auto-send durations (ms). 0 = no auto-send (manual).
export const AUTO_SEND_DURATIONS: Record<AutoSendMode, number> = {
  aggressive: 1500,
  normal: 3000,
  relaxed: 6000,
  manual: 0,
};

export const AUTO_SEND_LABELS: Record<AutoSendMode, string> = {
  aggressive: "Quick · 1.5s",
  normal: "Normal · 3s",
  relaxed: "Relaxed · 6s",
  manual: "Manual — tap Send",
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
