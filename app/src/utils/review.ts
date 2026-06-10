import AsyncStorage from "@react-native-async-storage/async-storage";
import * as StoreReview from "expo-store-review";
import { RATING_PROMPT_AFTER_SESSIONS } from "../constants";
import { track } from "./analytics";

const COUNT_KEY = "@diktat/completed_sessions";
const PROMPTED_KEY = "@diktat/rating_prompted";

/**
 * Count a completed session and, once the threshold is reached (and only once),
 * show the native App Store rating prompt. Never throws.
 */
export async function recordSessionAndMaybePrompt(): Promise<void> {
  try {
    const alreadyPrompted = await AsyncStorage.getItem(PROMPTED_KEY);
    const n = (parseInt((await AsyncStorage.getItem(COUNT_KEY)) ?? "0", 10) || 0) + 1;
    await AsyncStorage.setItem(COUNT_KEY, String(n));
    if (alreadyPrompted) return;
    if (n < RATING_PROMPT_AFTER_SESSIONS) return;
    if (!(await StoreReview.hasAction()) || !(await StoreReview.isAvailableAsync())) return;
    await AsyncStorage.setItem(PROMPTED_KEY, "1");
    track("rating_prompted", { afterSessions: n });
    await StoreReview.requestReview();
  } catch {
    /* ignore */
  }
}

/** Manually open the rating prompt (from a "Rate Diktat" button). */
export async function openStoreReview(): Promise<void> {
  try {
    if (await StoreReview.isAvailableAsync()) await StoreReview.requestReview();
  } catch {
    /* ignore */
  }
}
