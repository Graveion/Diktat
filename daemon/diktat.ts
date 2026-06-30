#!/usr/bin/env bun
/**
 * `diktat` — the daemon CLI.
 *
 *   diktat pair <code>     redeem a pairing code from the phone app
 *   diktat start           start the daemon in the background
 *   diktat start -f        run the daemon in the foreground (Ctrl-C to stop)
 *   diktat restart         reload the daemon (e.g. after updating)
 *   diktat update          update to the latest version, then restart
 *   diktat stop            stop the background daemon
 *   diktat status          is the daemon running?
 *   diktat setup           interactive setup
 *
 * Install once:  cd daemon && bun link    (then `diktat` is on your PATH)
 */
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as service from "./service";
import { COMPILED, DATA_DIR } from "./paths";
import { runDaemon } from "./index";
import { runPair } from "./pair";
import { runSetup } from "./setup";

const DIR = import.meta.dir; // the daemon directory (where index.ts etc. live)

// How launchd / nohup should (re)launch the daemon, and from where:
//  - compiled binary: re-exec ourselves in daemon mode, working dir = data dir
//  - source/dev:      `bun index.ts`, working dir = the daemon source dir
const DAEMON_ARGV = COMPILED ? [process.execPath, "__daemon"] : [process.execPath, join(DIR, "index.ts")];
const DAEMON_WORKDIR = COMPILED ? DATA_DIR : DIR;
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
      "  restart         Reload the daemon (e.g. after updating)",
      "  update          Update to the latest version, then restart",
      "  stop            Stop the background daemon",
      "  status          Show whether the daemon is running",
      "  logs            Follow the daemon logs",
      "  setup           Interactive setup",
    ].join("\n"),
  );
  process.exit(cmd ? 1 : 0);
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
    const r = service.installAndLoad(DAEMON_ARGV, DAEMON_WORKDIR, LOG_FILE);
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
  const proc = Bun.spawn(["nohup", ...DAEMON_ARGV], {
    cwd: DAEMON_WORKDIR,
    stdin: "ignore",
    stdout: out,
    stderr: out,
  });
  proc.unref();
  writeFileSync(PID_FILE, String(proc.pid));
  console.log(`Diktat daemon started (pid ${proc.pid}).  Logs: ${displayLog}`);
}

async function start(): Promise<void> {
  const foreground = rest.includes("-f") || rest.includes("--foreground");
  if (foreground) {
    // Run the daemon in this process; it stays alive on the relay socket.
    await runDaemon();
    return;
  }
  await startDaemon({ restart: false });
  process.exit(0);
}

/** `diktat restart` — reload the daemon (e.g. after updating the code). */
async function restart(): Promise<never> {
  await startDaemon({ restart: true });
  process.exit(0);
}

/**
 * `diktat update` — interim updater for the git-checkout install: pull latest
 * source, reinstall deps, restart. This is the stable user-facing verb; its
 * internals get swapped for a signed-binary self-update once that ships.
 */
const RELEASE_BASE = "https://github.com/Graveion/Diktat/releases/latest/download";
const RELEASE_ASSET = "diktat-arm64";

function sha256(data: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(data);
  return h.digest("hex");
}

/** Binary install: download the latest release, verify, atomic-swap, restart. */
async function updateBinary(): Promise<never> {
  console.log("Checking for updates…");
  let expected: string;
  try {
    const res = await fetch(`${RELEASE_BASE}/${RELEASE_ASSET}.sha256`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    expected = (await res.text()).trim().split(/\s+/)[0] ?? "";
  } catch (e) {
    console.log(`Couldn't reach the release server (${(e as Error).message}).`);
    process.exit(1);
  }
  // Compare against the running binary — no version math needed.
  if (sha256(readFileSync(process.execPath)) === expected) {
    console.log("Already up to date.");
    process.exit(0);
  }

  console.log("Downloading the latest daemon…");
  const res = await fetch(`${RELEASE_BASE}/${RELEASE_ASSET}`);
  if (!res.ok) { console.log(`Download failed (HTTP ${res.status}).`); process.exit(1); }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha256(bytes) !== expected) { console.log("Checksum mismatch — aborting."); process.exit(1); }

  // Write next to the binary (same filesystem) then atomic-rename over it. The
  // running process keeps its open inode; the new file is used on next launch.
  const tmp = `${process.execPath}.new`;
  await Bun.write(tmp, bytes);
  chmodSync(tmp, 0o755);
  renameSync(tmp, process.execPath);
  console.log("✓ Updated. Restarting daemon…");
  await startDaemon({ restart: true });
  process.exit(0);
}

/** Dev/source install: pull latest source, reinstall deps, restart. */
async function updateFromGit(): Promise<never> {
  const root = (() => {
    try {
      const r = Bun.spawnSync(["git", "-C", DIR, "rev-parse", "--show-toplevel"]);
      const top = r.stdout.toString().trim();
      return r.exitCode === 0 && top ? top : null;
    } catch { return null; }
  })();
  if (!root) {
    console.log("This install isn't a git checkout — re-run the installer to update:");
    console.log("  curl -fsSL https://graveion.github.io/Diktat/install.sh | bash");
    process.exit(1);
  }
  console.log("Updating Diktat…");
  const pull = Bun.spawnSync(["git", "-C", root, "pull", "--ff-only"], { stdout: "inherit", stderr: "inherit" });
  if (pull.exitCode !== 0) {
    console.log("git pull failed (local changes?). Resolve, then re-run `diktat update`.");
    process.exit(pull.exitCode ?? 1);
  }
  const install = Bun.spawnSync(["bun", "install"], { cwd: DIR, stdout: "inherit", stderr: "inherit" });
  if (install.exitCode !== 0) process.exit(install.exitCode ?? 1);
  await startDaemon({ restart: true });
  console.log("✓ Updated and restarted.");
  process.exit(0);
}

/** `diktat update` — self-update a binary install, or git-pull a dev checkout. */
async function update(): Promise<never> {
  return COMPILED ? updateBinary() : updateFromGit();
}

/** `diktat pair` — pair, then (re)start the daemon so it's immediately live. */
async function pair(): Promise<never> {
  await runPair(rest); // pairing failures exit the process from within runPair
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
  // Internal: launchd / the nohup fallback invoke the binary in daemon mode.
  // runDaemon() resolves after connecting; the process then stays alive.
  case "__daemon":
    await runDaemon();
    break;
  case "pair":
    await pair();
    break;
  case "start":
    await start();
    break;
  case "restart":
    await restart();
    break;
  case "update":
    await update();
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
    await runSetup();
    process.exit(0);
    break;
  default:
    usage();
}
