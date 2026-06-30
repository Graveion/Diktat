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
 * Build the LaunchAgent plist. `programArgs` is the full argv to run (e.g.
 * [bun, index.ts] in source mode, or [diktat-binary, "__daemon"] for a compiled
 * install), `workdir` the daemon's working directory (= the data dir), `logFile`
 * the combined stdout/stderr log, `inheritedPath` the PATH the user had when they
 * ran `diktat start`.
 *
 * PATH must be set explicitly because launchd starts jobs with a minimal
 * environment. Crucially we PREPEND the user's interactive PATH: CLI agents
 * (claude, cursor, codex…) commonly live in ~/.* dirs or version-manager shims
 * (volta/asdf/nvm/npm-global) that aren't on any standard path, and the daemon
 * detects them with `which`. Without this, launchd-run daemons find zero CLIs.
 */
export function buildPlist(programArgs: string[], workdir: string, logFile: string, inheritedPath?: string): string {
  const exe = programArgs[0] ?? "";
  const fallback = [dirname(exe), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const seen = new Set<string>();
  const path = [...(inheritedPath ? inheritedPath.split(":") : []), ...fallback]
    .filter((p) => p && !seen.has(p) && seen.add(p))
    .join(":");
  const argsXml = programArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(workdir)}</string>
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
export function installAndLoad(programArgs: string[], workdir: string, logFile: string): { ok: boolean; error?: string } {
  try {
    mkdirSync(dirname(plistPath()), { recursive: true });
    writeFileSync(plistPath(), buildPlist(programArgs, workdir, logFile, process.env.PATH));
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
