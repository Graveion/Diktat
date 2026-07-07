import Constants from "expo-constants";
import * as Updates from "expo-updates";

// Hosted legal/support pages (GitHub Pages — see /docs).
export const PRIVACY_URL = "https://graveion.github.io/Diktat/privacy.html";
export const SUPPORT_URL = "https://graveion.github.io/Diktat/support.html";
// Apple's standard EULA (Terms of Use). Required for auto-renewable subscriptions
// — linked from the paywall and repeated in the App Store description metadata.
export const TERMS_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";

// Daemon install one-liner, shown on the machines empty state.
export const INSTALL_COMMAND = "curl -fsSL https://graveion.github.io/Diktat/install.sh | bash";

export const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";

// Shows which OTA update is running: "dev" in Expo Go, a short hash in production
export const UPDATE_LABEL: string = (() => {
  if (__DEV__) return "dev";
  const id = Updates.updateId;         // UUID of the currently-running OTA update
  const at = Updates.createdAt;        // Date it was published
  if (!id) return "embedded";
  const short = id.slice(0, 8);
  const time = at ? at.toISOString().slice(0, 16).replace("T", " ") : "";
  return `${short}${time ? " · " + time : ""}`;
})();

// Show the App Store rating prompt after this many successful sessions.
export const RATING_PROMPT_AFTER_SESSIONS = 3;
