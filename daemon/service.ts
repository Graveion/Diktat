/**
 * launchd integration — keeps the daemon alive across logout, crash, and
 * reboot. Without this the daemon runs under `nohup` and dies on reboot, which
 * silently breaks the whole "your Mac is reachable from your phone" promise
 * with no way to recover remotely.
 *
 * We install a per-user LaunchAgent (no root needed) with RunAtLoad +
 * KeepAlive. `launchctl` calls live behind a seam so the pure plist building
 * is unit-testable without touching the real service manager.
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const SERVICE_LABEL = "com.diktat.daemon";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

export function isMac(): boolean {
  return process.platform === "darwin";
}

/** Escape the five XML predefined entities so paths with `&`/`<`/quotes are safe. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the LaunchAgent plist. `bun` is the absolute interpreter path
 * (process.execPath), `dir` the daemon directory, `logFile` the combined
 * stdout/stderr log. PATH is set explicitly because launchd starts jobs with a
 * minimal environment that omits ~/.bun/bin and Homebrew.
 */
export function buildPlist(bun: string, dir: string, logFile: string): string {
  const path = [dirname(bun), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(bun)}</string>
    <string>${xmlEscape(join(dir, "index.ts"))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(dir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(path)}</string>
  </dict>
</dict>
</plist>
`;
}

function launchctl(args: string[]): { ok: boolean; stderr: string } {
  const p = Bun.spawnSync(["launchctl", ...args]);
  return { ok: p.exitCode === 0, stderr: new TextDecoder().decode(p.stderr).trim() };
}

/** Write the plist and (re)load it. Returns {ok} or {ok:false,error}. */
export function installAndLoad(dir: string, logFile: string): { ok: boolean; error?: string } {
  try {
    mkdirSync(dirname(plistPath()), { recursive: true });
    writeFileSync(plistPath(), buildPlist(process.execPath, dir, logFile));
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  // Unload any prior instance first so a rewritten plist takes effect; ignore
  // failure (it may not be loaded yet).
  launchctl(["unload", "-w", plistPath()]);
  const r = launchctl(["load", "-w", plistPath()]);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr || "launchctl load failed" };
}

/** Unload the service if a plist exists. Returns true if there was one to stop. */
export function unload(): boolean {
  if (!existsSync(plistPath())) return false;
  launchctl(["unload", "-w", plistPath()]);
  return true;
}

/** Is the service currently registered with launchd? */
export function isLoaded(): boolean {
  return Bun.spawnSync(["launchctl", "list", SERVICE_LABEL]).exitCode === 0;
}
