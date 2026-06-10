import AsyncStorage from "@react-native-async-storage/async-storage";

/** Where CrashBoundary stores the last JS crash (App.tsx writes it). */
export const CRASH_KEY = "@diktat/last_crash";

export async function readLastCrash(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(CRASH_KEY);
  } catch {
    return null;
  }
}

export async function clearLastCrash(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CRASH_KEY);
  } catch {
    /* ignore */
  }
}

/** Persist a crash entry (fire-and-forget). */
export function saveCrash(entry: string): void {
  AsyncStorage.setItem(CRASH_KEY, entry).catch(() => {});
}
