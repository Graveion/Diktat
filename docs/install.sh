#!/usr/bin/env bash
#
# Diktat daemon installer.
#   curl -fsSL https://graveion.github.io/Diktat/install.sh | bash
#
# Downloads the prebuilt, standalone daemon binary (no Bun, no source checkout)
# and puts a `diktat` command on your PATH. Re-run anytime to update, or use
# `diktat update`.
set -euo pipefail

REPO="${DIKTAT_REPO:-Graveion/Diktat}"
BIN_DIR="${DIKTAT_BIN_DIR:-$HOME/.local/bin}"
ASSET="diktat-arm64"
BASE="https://github.com/$REPO/releases/latest/download"

say()  { printf '\033[1;35m▸\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# 1. Apple Silicon only (for now).
[ "$(uname -s)" = "Darwin" ] || fail "Diktat's daemon runs on macOS."
[ "$(uname -m)" = "arm64" ] || fail "Only Apple Silicon (arm64) Macs are supported right now."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 2. Download the binary + checksum, then verify before installing.
say "Downloading the Diktat daemon…"
curl -fsSL "$BASE/$ASSET" -o "$tmp/$ASSET" || fail "Download failed ($BASE/$ASSET)."
curl -fsSL "$BASE/$ASSET.sha256" -o "$tmp/$ASSET.sha256" || fail "Checksum download failed."

say "Verifying checksum…"
expected="$(awk '{print $1}' "$tmp/$ASSET.sha256")"
actual="$(shasum -a 256 "$tmp/$ASSET" | awk '{print $1}')"
[ "$expected" = "$actual" ] || fail "Checksum mismatch — refusing to install."

# 3. Install to PATH.
mkdir -p "$BIN_DIR"
mv "$tmp/$ASSET" "$BIN_DIR/diktat"
chmod +x "$BIN_DIR/diktat"
say "Installed to $BIN_DIR/diktat"

if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  echo
  echo "  Add this to your shell profile (~/.zshrc), then restart your terminal:"
  echo "    export PATH=\"$BIN_DIR:\$PATH\""
fi
echo
echo "  Next:"
echo "    diktat setup     # detect your CLIs + pick projects"
echo "    diktat pair      # show a QR; scan it in the Diktat app"
echo "    diktat start     # run in the background (auto-starts on login via launchd)"
