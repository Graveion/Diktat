import { loadConfig } from "./config";
import { detectCLIs } from "./cli-detector";
import { Session } from "./session";
import { cursorShellPermissionGranted } from "./cursor-shell-permissions";
import { type MessageContext, runningSessionIds } from "./message-handler";
import { startRelayClient } from "./relay-client";
import { COMPILED } from "./paths";
import * as service from "./service";
import { fetchExpectedChecksum, runningChecksum, downloadVerifiedBinary, applyBinary } from "./self-update";

// Self-maintenance: a compiled daemon periodically checks for a newer published
// build and applies it when idle, so a paired Mac never languishes on a stale
// daemon (opt out with "autoUpdate": false in config.json). The checksum is the
// trust anchor — see self-update.ts. We only auto-apply when no session is
// mid-turn, and only self-restart under launchd (KeepAlive relaunches the
// swapped binary); under nohup/dev we download and wait for a manual restart.
const AUTO_UPDATE_FIRST_DELAY_MS = 2 * 60 * 1000; // 2 min after start
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h

function scheduleSelfUpdate(ctx: MessageContext, enabled: boolean): void {
  if (!COMPILED || !enabled) return; // only real binary installs self-heal
  const tick = async () => {
    try {
      if (runningSessionIds(ctx).length > 0) return; // never interrupt a live turn
      const expected = await fetchExpectedChecksum();
      if (runningChecksum() === expected) return; // already current
      applyBinary(await downloadVerifiedBinary(expected));
      console.log("[self-update] applied a newer daemon build.");
      if (service.isLoaded()) {
        console.log("[self-update] restarting (launchd will relaunch).");
        process.exit(0);
      } else {
        console.log("[self-update] not under launchd — restart the daemon to apply.");
      }
    } catch (e) {
      console.log(`[self-update] skipped: ${(e as Error).message}`);
    }
  };
  setTimeout(tick, AUTO_UPDATE_FIRST_DELAY_MS);
  setInterval(tick, AUTO_UPDATE_INTERVAL_MS);
}

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

  scheduleSelfUpdate(messageContext, config.autoUpdate !== false);

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
