import { readFileSync, writeFileSync, chmodSync, renameSync } from "fs";

// Shared self-update core, used by both the `diktat update` CLI verb and the
// daemon's unattended self-maintenance loop. The trust anchor is the SHA-256
// checksum published alongside each GitHub release: we never run a binary whose
// hash doesn't match the published `.sha256`.
export const RELEASE_BASE = "https://github.com/Graveion/Diktat/releases/latest/download";
export const RELEASE_ASSET = "diktat-arm64";

export function sha256(data: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(data);
  return h.digest("hex");
}

/** The checksum published for the current latest release. Throws on network error. */
export async function fetchExpectedChecksum(): Promise<string> {
  const res = await fetch(`${RELEASE_BASE}/${RELEASE_ASSET}.sha256`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).trim().split(/\s+/)[0] ?? "";
}

/** Checksum of the binary this process is running from. */
export function runningChecksum(): string {
  return sha256(readFileSync(process.execPath));
}

/** Download the published binary and verify it matches `expected`. Throws on
 *  network error or checksum mismatch — the caller never sees unverified bytes. */
export async function downloadVerifiedBinary(expected: string): Promise<Uint8Array> {
  const res = await fetch(`${RELEASE_BASE}/${RELEASE_ASSET}`);
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error("checksum mismatch");
  return bytes;
}

/** Write the new binary beside the current one, then atomic-rename over it. The
 *  running process keeps its open inode; the new file is used on next launch. */
export function applyBinary(bytes: Uint8Array): void {
  const tmp = `${process.execPath}.new`;
  writeFileSync(tmp, bytes);
  chmodSync(tmp, 0o755);
  renameSync(tmp, process.execPath);
}
