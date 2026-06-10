import { Platform } from "react-native";
import Constants from "expo-constants";
import { supabase } from "../store/supabase";
import { warn } from "./logger";

const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";

/** First-party, PII-free product events. */
export type AnalyticsEvent =
  | "app_connected"
  | "pair_succeeded"
  | "session_started"
  | "session_resumed"
  | "message_sent"
  | "session_completed"
  | "paywall_shown"
  | "paywall_converted"
  | "feedback_submitted"
  | "rating_prompted";

type Prop = string | number | boolean;

/**
 * Fire-and-forget product event. Never throws. No-ops when signed out (so we
 * only ever record authenticated, account-scoped usage — keeps it simple and
 * satisfies the RLS insert policy). Props must be PII-free (cli/source/mode/etc).
 */
export async function track(name: AnalyticsEvent, props: Record<string, Prop> = {}): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const accountId = data.session?.user?.id;
    if (!accountId) return;
    await supabase.from("events").insert({
      account_id: accountId,
      name,
      props,
      platform: Platform.OS,
      app_version: APP_VERSION,
    });
  } catch (e) {
    warn("ANALYTICS", `track ${name} failed: ${(e as Error)?.message}`);
  }
}
