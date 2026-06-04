import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig } from "./config";
import { getTailscaleIP } from "./tailscale";
import { detectCLIs } from "./cli-detector";
import { Session } from "./session";
import { cursorShellPermissionGranted, grantCursorShellPermission } from "./cursor-shell-permissions";
import { handleClientMessage, buildConnectedPayload, type MessageContext } from "./message-handler";
import { startRelayClient } from "./relay-client";

const config = loadConfig();

const availableCLIs = await detectCLIs();

// On first startup (no cli-config.json yet), auto-create it with Shell(*).
// If the file already exists we leave it alone — the user may have custom entries.
// They can add Shell(*) themselves or re-run `diktat setup`.
// (Mode-independent: cursor shell access is needed in both local and relay mode.)
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

if (config.mode === "relay") {
  // ── Relay mode ──────────────────────────────────────────────────────────
  // No Tailscale interface, no Bun.serve. The daemon dials out to the relay
  // and brokers the existing protocol through the agent leg. Same MessageContext.
  if (!config.relayUrl || !config.machineId || !config.daemonToken) {
    console.error("Relay mode requires relayUrl, machineId, and daemonToken in config.json");
    process.exit(1);
  }

  startRelayClient({
    ctx: messageContext,
    relayUrl: config.relayUrl,
    machineId: config.machineId,
    daemonToken: config.daemonToken,
  });

  console.log(`\n── Diktat daemon ready (relay) ──────────`);
  console.log(`  CLIs:     ${Object.keys(availableCLIs).join(", ") || "none found"}`);
  console.log(`  Projects: ${config.projects.join(", ") || "none configured"}`);
  console.log(`  Relay:    ${config.relayUrl}`);
  console.log(`  Machine:  ${config.machineId}`);
  console.log(`─────────────────────────────────────────\n`);
} else {
  // ── Local / Tailscale mode (default) — unchanged ──────────────────────────
  const tailscaleIP = getTailscaleIP();

  if (!tailscaleIP) {
    console.error("No Tailscale interface found. Is Tailscale running?");
    process.exit(1);
  }

  function handleMessage(ws: any, msg: any): Promise<void> {
    return handleClientMessage(messageContext, ws, msg);
  }

  const server = Bun.serve({
    port: config.port,
    hostname: tailscaleIP,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("Diktat daemon running", { status: 200 });
    },
    websocket: {
      idleTimeout: 960,
      open(ws) {
        console.log(`[${new Date().toISOString()}] [WS] Client connected`);
        ws.send(JSON.stringify(buildConnectedPayload(messageContext)));
      },
      message(ws, data) {
        let msg: any;
        try {
          msg = JSON.parse(data as string);
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
          return;
        }
        handleMessage(ws, msg).catch((e) => {
          console.error("Unhandled error in message handler:", e);
          try { ws.send(JSON.stringify({ type: "error", message: "Internal error" })); } catch {}
        });
      },
      close(ws) {
        console.log(`[${new Date().toISOString()}] [WS] Client disconnected`);
      },
    },
  });

  console.log(`\n── Diktat daemon ready ──────────────────`);
  console.log(`  CLIs:     ${Object.keys(availableCLIs).join(", ") || "none found"}`);
  console.log(`  Projects: ${config.projects.join(", ") || "none configured"}`);
  console.log(`  Address:  ws://${tailscaleIP}:${config.port}`);
  console.log(`  Run 'diktat qr' to show connection QR`);
  console.log(`─────────────────────────────────────────\n`);
}
