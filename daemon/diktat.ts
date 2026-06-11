#!/usr/bin/env bun
/**
 * `diktat` — the daemon CLI.
 *
 *   diktat pair <code>     redeem a pairing code from the phone app
 *   diktat start           start the daemon in the background
 *   diktat start -f        run the daemon in the foreground (Ctrl-C to stop)
 *   diktat stop            stop the background daemon
 *   diktat status          is the daemon running?
 *   diktat setup           interactive setup
 *
 * Install once:  cd daemon && bun link    (then `diktat` is on your PATH)
 */
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as service from "./service";

const DIR = import.meta.dir; // the daemon directory (where index.ts etc. live)
const STATE = join(homedir(), ".diktat");
const PID_FILE = join(STATE, "daemon.pid");
const LOG_FILE = join(STATE, "daemon.log");

const [, , cmd, ...rest] = process.argv;

function usage(): never {
  console.log(
    [
      "Usage: diktat <command>",
      "",
      "  pair <code>     Pair this Mac with your phone (code shown in the app)",
      "  start [-f]      Start the daemon (background; -f for foreground)",
      "  stop            Stop the background daemon",
      "  status          Show whether the daemon is running",
      "  logs            Follow the daemon logs",
      "  setup           Interactive setup",
    ].join("\n"),
  );
  process.exit(cmd ? 1 : 0);
}

/** Run one of the daemon scripts attached to this terminal; exit with its code. */
async function runAttached(script: string, args: string[] = []): Promise<never> {
  const proc = Bun.spawn(["bun", join(DIR, script), ...args], {
    cwd: DIR,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  process.exit(proc.exitCode ?? 0);
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  return Number.isInteger(pid) ? pid : null;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

/** Stop a legacy nohup-managed daemon (pre-launchd installs) if one is running. */
function stopLegacyPid(): void {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  if (pid) rmSync(PID_FILE, { force: true });
}

async function start(): Promise<never> {
  const foreground = rest.includes("-f") || rest.includes("--foreground");

  if (foreground) {
    return runAttached("index.ts");
  }

  mkdirSync(STATE, { recursive: true });

  // macOS: run under launchd so the daemon survives logout, crash, and reboot.
  // This is the difference between the phone reliably reaching this Mac and the
  // connection silently dying after a restart with no way to fix it remotely.
  if (service.isMac()) {
    if (service.isLoaded()) {
      console.log("Diktat daemon is already managed by launchd (running).");
      console.log("  diktat stop   to stop it · diktat logs   to follow logs");
      process.exit(0);
    }
    stopLegacyPid(); // avoid two daemons if upgrading from a nohup install
    const r = service.installAndLoad(DIR, LOG_FILE);
    if (r.ok) {
      const displayLog = LOG_FILE.replace(homedir(), "~");
      console.log("Diktat daemon installed and started via launchd.");
      console.log("It will now start automatically on login and restart if it crashes.");
      console.log("");
      console.log("  diktat status   Check whether it's running");
      console.log("  diktat logs     Follow the daemon logs");
      console.log("  diktat stop     Stop and disable autostart");
      console.log("");
      console.log(`  Logs: ${displayLog}`);
      process.exit(0);
    }
    console.warn(`launchd setup failed (${r.error}); falling back to a background process.`);
    // fall through to nohup
  }

  const existing = readPid();
  if (existing && isRunning(existing)) {
    console.log(`Daemon already running (pid ${existing}).`);
    process.exit(0);
  }
  const out = openSync(LOG_FILE, "a");
  // nohup keeps it alive after the terminal closes; unref lets us exit now.
  // NOTE: this fallback does NOT survive a reboot (no launchd) — re-run
  // `diktat start` after restarting, or use the launchd path on macOS.
  const proc = Bun.spawn(["nohup", "bun", join(DIR, "index.ts")], {
    cwd: DIR,
    stdin: "ignore",
    stdout: out,
    stderr: out,
  });
  proc.unref();
  writeFileSync(PID_FILE, String(proc.pid));
  const displayLog = LOG_FILE.replace(homedir(), "~");
  console.log(`Diktat daemon started (pid ${proc.pid}).`);
  console.log(`  Logs: ${displayLog}`);
  process.exit(0);
}

function stop(): never {
  // Tear down the launchd service (if any) AND any legacy nohup process.
  const hadService = service.isMac() && service.unload();
  const pid = readPid();
  const hadPid = !!(pid && isRunning(pid));
  if (hadPid) {
    try { process.kill(pid!); } catch { /* already gone */ }
  }
  if (pid) rmSync(PID_FILE, { force: true });

  if (hadService) console.log("Stopped daemon and disabled autostart.");
  else if (hadPid) console.log(`Stopped daemon (pid ${pid}).`);
  else console.log("Daemon is not running.");
  process.exit(0);
}

function status(): never {
  if (service.isMac() && service.isLoaded()) {
    console.log("Daemon is running (managed by launchd; autostarts on login).");
    process.exit(0);
  }
  const pid = readPid();
  if (pid && isRunning(pid)) console.log(`Daemon is running (pid ${pid}).`);
  else console.log("Daemon is not running.");
  process.exit(0);
}

/** Tail the daemon log (follow), like `diktat logs`. */
async function logs(): Promise<never> {
  if (!existsSync(LOG_FILE)) {
    console.log("No logs yet. Start the daemon first:  diktat start");
    process.exit(0);
  }
  const proc = Bun.spawn(["tail", "-f", LOG_FILE], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  process.exit(proc.exitCode ?? 0);
}

switch (cmd) {
  case "pair":
    await runAttached("pair.ts", rest);
    break;
  case "start":
    await start();
    break;
  case "stop":
    stop();
    break;
  case "status":
    status();
    break;
  case "logs":
    await logs();
    break;
  case "setup":
    await runAttached("setup.ts", rest);
    break;
  default:
    usage();
}
