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

/** Run a daemon script attached to this terminal; resolve with its exit code. */
async function spawnAttached(script: string, args: string[] = []): Promise<number> {
  const proc = Bun.spawn(["bun", join(DIR, script), ...args], {
    cwd: DIR,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  return proc.exitCode ?? 0;
}

/** Run a daemon script attached to this terminal; exit with its code. */
async function runAttached(script: string, args: string[] = []): Promise<never> {
  process.exit(await spawnAttached(script, args));
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

/**
 * Bring the background daemon up. With `restart`, always reload it (used after
 * pairing, so the freshly-written token is picked up — a running daemon only
 * reads config.json at startup). Without `restart`, leave an already-running
 * daemon alone.
 */
async function startDaemon(opts: { restart: boolean }): Promise<void> {
  mkdirSync(STATE, { recursive: true });
  const displayLog = LOG_FILE.replace(homedir(), "~");

  // macOS: run under launchd so the daemon survives logout, crash, and reboot.
  if (service.isMac()) {
    if (service.isLoaded() && !opts.restart) {
      console.log("Diktat daemon is already running (managed by launchd).");
      console.log("  diktat stop   to stop it · diktat logs   to follow logs");
      return;
    }
    stopLegacyPid(); // avoid two daemons if upgrading from a nohup install
    // installAndLoad unloads any existing instance first, so this also restarts.
    const r = service.installAndLoad(DIR, LOG_FILE);
    if (r.ok) {
      console.log(opts.restart
        ? "Daemon (re)started via launchd — it will connect with the new pairing."
        : "Diktat daemon started via launchd (autostarts on login, restarts on crash).");
      console.log(`  diktat status · diktat logs · diktat stop    Logs: ${displayLog}`);
      return;
    }
    console.warn(`launchd setup failed (${r.error}); falling back to a background process.`);
    // fall through to nohup
  }

  const existing = readPid();
  if (existing && isRunning(existing)) {
    if (!opts.restart) {
      console.log(`Daemon already running (pid ${existing}).`);
      return;
    }
    stopLegacyPid(); // restart: kill the stale process before respawning
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
  console.log(`Diktat daemon started (pid ${proc.pid}).  Logs: ${displayLog}`);
}

async function start(): Promise<never> {
  const foreground = rest.includes("-f") || rest.includes("--foreground");
  if (foreground) return runAttached("index.ts");
  await startDaemon({ restart: false });
  process.exit(0);
}

/** `diktat pair` — pair, then (re)start the daemon so it's immediately live. */
async function pair(): Promise<never> {
  const code = await spawnAttached("pair.ts", rest);
  if (code !== 0) process.exit(code); // pairing failed/cancelled; pair.ts already explained
  await startDaemon({ restart: true });
  // The daemon connects to the relay asynchronously in its own process, so we
  // can't assert it's online here — point at the real signals instead of
  // overclaiming "connected".
  console.log("\n✓ Paired. The daemon is starting and should come online within a few seconds.");
  console.log("  Watch the machine's dot in the app, or run `diktat logs` (look for \"registered as machine\").\n");
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
    await pair();
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
