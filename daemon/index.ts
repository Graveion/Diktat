import { loadConfig } from "./config";
import { detectCLIs } from "./cli-detector";
import { Session } from "./session";
import { cursorShellPermissionGranted } from "./cursor-shell-permissions";
import { type MessageContext } from "./message-handler";
import { startRelayClient } from "./relay-client";

/**
 * Boot the daemon: detect CLIs, build the message context, and connect to the
 * relay. Resolves once the relay client is started; the process then stays
 * alive on the relay socket + keep-alive timers. Exported so the single binary
 * can run it in daemon mode (and `diktat start -f` can run it in-process).
 */
export async function runDaemon(): Promise<void> {
  const config = loadConfig();

  const availableCLIs = await detectCLIs();

  // Granting Shell(*) is a consent decision — only `diktat setup` (which prompts)
  // writes it. Here we just point the user there.
  if (availableCLIs["cursor"] && !cursorShellPermissionGranted()) {
    console.log("[cursor] Shell(*) not set in ~/.cursor/cli-config.json — cursor sessions may have limited shell access. Run `diktat setup` to configure.");
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
}

// Run directly (`bun index.ts`) — the current launchd/source entrypoint.
if (import.meta.main) {
  await runDaemon();
}
