#!/usr/bin/env bash
#
# Build, sign, and notarize the Diktat daemon as a standalone arm64 binary.
#
# This is the distribution spike: it proves the chain
#   bun --compile → codesign (hardened runtime) → notarytool → runnable
# works before we build the full release pipeline + installers around it.
#
# Runs identically locally and in CI — pick a notarization credential path below.
#
# Local (keychain profile):
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#   NOTARY_PROFILE="diktat-notary" ./build.sh
#
# CI / any machine (App Store Connect API key — nothing machine-bound):
#   SIGN_IDENTITY="Developer ID Application: …" \
#   NOTARY_KEY=AuthKey_XXXX.p8 NOTARY_KEY_ID=XXXX NOTARY_ISSUER=<uuid> ./build.sh
#
# Env:
#   SIGN_IDENTITY   Developer ID Application identity (from `security find-identity
#                   -v -p codesigning`). The cert must be in a keychain codesign
#                   can read — locally that's your login keychain; in CI you import
#                   a base64 .p12 secret into a temp keychain BEFORE calling this.
#                   If unset, builds an UNSIGNED binary and stops after compile.
#   Notarization credentials — provide ONE of:
#     NOTARY_PROFILE                         a stored keychain profile (local only)
#     NOTARY_KEY + NOTARY_KEY_ID + NOTARY_ISSUER   ASC API key (.p8) — best for CI
#   If none are set, the binary is signed but NOT notarized.
#
set -euo pipefail

cd "$(dirname "$0")"

OUT_DIR="dist"
BIN="$OUT_DIR/diktat"
ENTITLEMENTS="diktat.entitlements"

say() { printf '\033[1;35m▸\033[0m %s\n' "$1"; }

mkdir -p "$OUT_DIR"

# 1. Compile to a standalone arm64 binary (embeds the Bun runtime — no Bun or
#    source needed on the user's machine).
# Entry is diktat.ts — the CLI dispatcher. It runs the daemon in-process when
# invoked as `<binary> __daemon` (how launchd/install launches it), and handles
# pair/setup/start/stop/etc. as subcommands. One binary, both roles.
say "Compiling (bun --compile, arm64)…"
bun build --compile --target=bun-darwin-arm64 ./diktat.ts --outfile "$BIN"
say "Built $BIN ($(du -h "$BIN" | cut -f1))"

if [ -z "${SIGN_IDENTITY:-}" ]; then
  say "SIGN_IDENTITY unset — leaving the binary UNSIGNED. Smoke-test it, then"
  say "re-run with SIGN_IDENTITY set to sign + notarize."
  exit 0
fi

# 2. Codesign with the hardened runtime + JIT entitlements (both required: the
#    hardened runtime is mandatory for notarization, the entitlements let Bun's
#    JIT run under it).
say "Codesigning (hardened runtime)…"
codesign --force --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --sign "$SIGN_IDENTITY" \
  "$BIN"
codesign --verify --strict --verbose=2 "$BIN"
say "Signed and verified."

# Pick the notarytool auth: keychain profile (local) or ASC API key (CI).
NOTARY_AUTH=()
if [ -n "${NOTARY_PROFILE:-}" ]; then
  NOTARY_AUTH=(--keychain-profile "$NOTARY_PROFILE")
elif [ -n "${NOTARY_KEY:-}" ] && [ -n "${NOTARY_KEY_ID:-}" ] && [ -n "${NOTARY_ISSUER:-}" ]; then
  NOTARY_AUTH=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
else
  say "No notarization credentials (NOTARY_PROFILE or NOTARY_KEY/_ID/_ISSUER) —"
  say "signed but NOT notarized."
  shasum -a 256 "$BIN"
  exit 0
fi

# 3. Notarize. notarytool needs an archive, not a bare Mach-O, so zip it.
#    NOTE: you cannot `stapler staple` a bare binary — stapling only works on
#    .app/.pkg/.dmg containers. Once notarized, Gatekeeper validates the binary
#    via an online check. For offline-safe distribution, ship inside a notarized
#    .pkg/.dmg and staple THAT (a later pipeline step, not this spike).
ZIP="$OUT_DIR/diktat-arm64.zip"
say "Zipping for notarization…"
ditto -c -k --keepParent "$BIN" "$ZIP"

say "Submitting to notarytool (waits for the result)…"
xcrun notarytool submit "$ZIP" "${NOTARY_AUTH[@]}" --wait

say "Notarization accepted. (Bare binaries can't be stapled — that's expected;"
say "staple the .pkg/.dmg in the release pipeline instead.)"
shasum -a 256 "$BIN"
