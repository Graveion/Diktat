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

async function start(): Promise<never> {
  const foreground = rest.includes("-f") || rest.includes("--foreground");
  const existing = readPid();
  if (existing && isRunning(existing)) {
    console.log(`Daemon already running (pid ${existing}).`);
    process.exit(0);
  }

  if (foreground) {
    return runAttached("index.ts");
  }

  mkdirSync(STATE, { recursive: true });
  const out = openSync(LOG_FILE, "a");
  // nohup keeps it alive after the terminal closes; unref lets us exit now.
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
  console.log("");
  console.log("  Commands:");
  console.log("    diktat status   Check whether it's running");
  console.log("    diktat logs     Follow the daemon logs");
  console.log("    diktat stop     Stop the daemon");
  console.log("");
  console.log(`  Logs: ${displayLog}`);
  process.exit(0);
}

function stop(): never {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log("Daemon is not running.");
    if (pid) rmSync(PID_FILE, { force: true });
    process.exit(0);
  }
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
  rmSync(PID_FILE, { force: true });
  console.log(`Stopped daemon (pid ${pid}).`);
  process.exit(0);
}

function status(): never {
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
