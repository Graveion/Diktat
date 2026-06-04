import "react-native-url-polyfill/auto";
import { AppState, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import Constants from "expo-constants";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;

export const SUPABASE_URL = extra.supabaseUrl ?? "";
export const SUPABASE_PUBLISHABLE_KEY = extra.supabasePublishableKey ?? "";
export const GOOGLE_WEB_CLIENT_ID = extra.googleWebClientId ?? "";
export const GOOGLE_IOS_CLIENT_ID = extra.googleIosClientId ?? "";

/**
 * Supabase client (accounts/identity). Sessions persist in AsyncStorage and are
 * auto-refreshed while the app is foregrounded. The phone's relay credential is
 * `session.access_token` (a project-signed JWT the relay verifies via JWKS).
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: AsyncStorage,
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
