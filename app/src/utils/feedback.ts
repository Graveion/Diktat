import { Platform } from "react-native";
import Constants from "expo-constants";
import { supabase } from "../store/supabase";
import { readLastCrash } from "./crash";
import { track } from "./analytics";

const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";

export type FeedbackKind = "idea" | "bug" | "praise" | "other";

/**
 * Submit in-app feedback to Supabase. Optionally attaches the last captured
 * crash (from AsyncStorage) so bug reports carry a stack trace. Never throws;
 * returns whether the insert succeeded.
 */
export async function submitFeedback(opts: { message: string; kind?: FeedbackKind; includeCrash?: boolean }): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession();
    const accountId = data.session?.user?.id;
    if (!accountId) return false;
    const crash = opts.includeCrash ? await readLastCrash() : null;
    const { error } = await supabase.from("feedback").insert({
      account_id: accountId,
      message: opts.message.trim().slice(0, 4000),
      kind: opts.kind ?? "other",
      crash: crash ? crash.slice(0, 8000) : null,
      platform: Platform.OS,
      app_version: APP_VERSION,
    });
    if (error) return false;
    track("feedback_submitted", { kind: opts.kind ?? "other", crash: !!crash });
    return true;
  } catch {
    return false;
  }
}
