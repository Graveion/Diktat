import { test, expect } from "bun:test";
import { sha256, downloadVerifiedBinary, RELEASE_BASE, RELEASE_ASSET } from "./self-update";

test("sha256 is stable and matches a known vector", () => {
  // Empty input → the well-known SHA-256 of "".
  expect(sha256(new Uint8Array([]))).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  const bytes = new TextEncoder().encode("diktat");
  expect(sha256(bytes)).toBe(sha256(bytes)); // deterministic
});

test("release asset points at the public GitHub releases latest", () => {
  expect(RELEASE_BASE).toContain("Graveion/Diktat/releases/latest/download");
  expect(RELEASE_ASSET).toBe("diktat-arm64");
});

test("downloadVerifiedBinary rejects a checksum mismatch", async () => {
  const realFetch = globalThis.fetch;
  // @ts-expect-error test stub
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  try {
    await expect(downloadVerifiedBinary("deadbeef")).rejects.toThrow("checksum mismatch");
  } finally {
    globalThis.fetch = realFetch;
  }
});
