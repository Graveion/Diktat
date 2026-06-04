import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig } from "./config";
import { detectCLIs } from "./cli-detector";
import { Session } from "./session";
import { cursorShellPermissionGranted, grantCursorShellPermission } from "./cursor-shell-permissions";
import { type MessageContext } from "./message-handler";
import { startRelayClient } from "./relay-client";

const config = loadConfig();

const availableCLIs = await detectCLIs();

// On first startup (no cli-config.json yet), auto-create it with Shell(*).
// If the file already exists we leave it alone — the user may have custom entries.
if (availableCLIs["cursor"] && !cursorShellPermissionGranted()) {
  const configPath = join(homedir(), ".cursor", "cli-config.json");
  if (!existsSync(configPath)) {
    grantCursorShellPermission();
    console.log("[cursor] Created ~/.cursor/cli-config.json with Shell(*) permission");
  } else {
    console.warn("[cursor] Shell(*) not set in ~/.cursor/cli-config.json — cursor sessions may have limited shell access. Run `diktat setup` to configure.");
  }
}

const activeSessions = new Map<string, Session>();
const clientPushTokens = new WeakMap<object, string>();

const messageContext: MessageContext = {
  availableCLIs,
  projects: config.projects,
  activeSessions,
  clientPushTokens,
};

// Diktat connects to your phone through the relay. Pairing (via `diktat pair`)
// writes the relay credentials into config.json; without them there's nothing
// to connect to.
if (!config.relayUrl || !config.machineId || !config.daemonToken) {
  console.error(
    "This machine isn't paired yet.\n" +
      "Open the Diktat app, tap “Pair a machine”, then run:  diktat pair <code>",
  );
  process.exit(1);
}

startRelayClient({
  ctx: messageContext,
  relayUrl: config.relayUrl,
  machineId: config.machineId,
  daemonToken: config.daemonToken,
});

console.log(`\n── Diktat daemon ready ──────────────────`);
console.log(`  CLIs:     ${Object.keys(availableCLIs).join(", ") || "none found"}`);
console.log(`  Projects: ${config.projects.join(", ") || "none configured"}`);
console.log(`  Relay:    ${config.relayUrl}`);
console.log(`  Machine:  ${config.machineId}`);
console.log(`─────────────────────────────────────────\n`);
