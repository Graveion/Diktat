import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** Whether Shell(*) is already present in ~/.cursor/cli-config.json. */
export function cursorShellPermissionGranted(): boolean {
  const configPath = join(homedir(), ".cursor", "cli-config.json");
  if (!existsSync(configPath)) return false;
  try {
    const json = JSON.parse(readFileSync(configPath, "utf-8"));
    const perms: string[] = json?.permissions?.allow ?? [];
    return perms.includes("Shell(*)");
  } catch {
    return false;
  }
}

/**
 * Add Shell(*) to ~/.cursor/cli-config.json, preserving all existing content.
 * Only appends — never removes or replaces existing entries.
 * Safe to call multiple times — no-op if Shell(*) is already present.
 *
 * Returns true if the file was written, false if it was already correct.
 */
export function grantCursorShellPermission(): boolean {
  const cursorDir = join(homedir(), ".cursor");
  const configPath = join(cursorDir, "cli-config.json");

  let existing: any = {};
  if (existsSync(configPath)) {
    try { existing = JSON.parse(readFileSync(configPath, "utf-8")); } catch { /* corrupt — will overwrite */ }
  }

  const perms: string[] = existing?.permissions?.allow ?? [];
  if (perms.includes("Shell(*)")) return false; // already granted

  // Append Shell(*) — leave every other entry untouched
  const updated = {
    ...existing,
    permissions: {
      ...(existing.permissions ?? {}),
      allow: [...perms, "Shell(*)"],
    },
  };

  if (!existsSync(cursorDir)) mkdirSync(cursorDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(updated, null, 2));
  return true;
}
