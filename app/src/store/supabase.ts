import "react-native-url-polyfill/auto";
import { AppState, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { createClient } from "@supabase/supabase-js";
import Constants from "expo-constants";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;

export const SUPABASE_URL = extra.supabaseUrl ?? "";
export const SUPABASE_PUBLISHABLE_KEY = extra.supabasePublishableKey ?? "";
export const GOOGLE_WEB_CLIENT_ID = extra.googleWebClientId ?? "";
export const GOOGLE_IOS_CLIENT_ID = extra.googleIosClientId ?? "";
export const RELAY_URL = extra.relayUrl ?? "";

// Keychain-backed session storage. The refresh token is the phone's long-lived
// credential root — AsyncStorage is plaintext on disk (and in backups), so it
// lives in the iOS Keychain instead. getItem lazily migrates any session a
// pre-SecureStore build left in AsyncStorage, so existing users stay signed in.
// (Android note: keystore values are capped at 2048 bytes — revisit before an
// Android release; sessions can exceed that.)
const secureStorage = {
  getItem: async (key: string): Promise<string | null> => {
    const v = await SecureStore.getItemAsync(key);
    if (v != null) return v;
    const legacy = await AsyncStorage.getItem(key);
    if (legacy != null) {
      await SecureStore.setItemAsync(key, legacy).catch(() => {});
      await AsyncStorage.removeItem(key).catch(() => {});
    }
    return legacy;
  },
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

/**
 * Supabase client (accounts/identity). Sessions persist in the Keychain and are
 * auto-refreshed while the app is foregrounded. The phone's relay credential is
 * `session.access_token` (a project-signed JWT the relay verifies via JWKS).
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: secureStorage,
    autoRefreshToken: true,
    persistSession: true,
    // No deep-link OAuth redirect: we use native ID-token sign-in only.
    detectSessionInUrl: false,
  },
});

// Supabase RN guidance: only auto-refresh while the app is active, so tokens
// don't churn in the background. Native only (no AppState on web).
if (Platform.OS !== "web") {
  AppState.addEventListener("change", (state) => {
    if (state === "active") supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
