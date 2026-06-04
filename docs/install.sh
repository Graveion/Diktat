#!/usr/bin/env bash
#
# Diktat daemon installer.
#   curl -fsSL https://graveion.github.io/Diktat/install.sh | bash
#
# Installs Bun (if needed), fetches the Diktat source, installs the daemon's
# deps, and puts a `diktat` command on your PATH. Re-run anytime to update.
set -euo pipefail

REPO="${DIKTAT_REPO:-https://github.com/Graveion/Diktat.git}"
SRC="${DIKTAT_HOME:-$HOME/.diktat/src}"
BIN_DIR="${DIKTAT_BIN_DIR:-$HOME/.local/bin}"

say() { printf '\033[1;35m▸\033[0m %s\n' "$1"; }

# 1. Bun
if ! command -v bun >/dev/null 2>&1; then
  say "Installing Bun…"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

# 2. Source (clone or update)
if [ -d "$SRC/.git" ]; then
  say "Updating Diktat…"
  git -C "$SRC" pull --ff-only
else
  say "Fetching Diktat…"
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 "$REPO" "$SRC"
fi

# 3. Daemon dependencies
say "Installing daemon dependencies…"
( cd "$SRC/daemon" && bun install )

# 4. `diktat` command (a tiny wrapper, no PATH assumptions about ~/.bun/bin)
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/diktat" <<EOF
#!/usr/bin/env bash
exec bun "$SRC/daemon/diktat.ts" "\$@"
EOF
chmod +x "$BIN_DIR/diktat"

say "Installed."
if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  echo
  echo "  Add this to your shell profile (~/.zshrc), then restart your terminal:"
  echo "    export PATH=\"$BIN_DIR:\$PATH\""
fi
echo
echo "  Next:"
echo "    diktat setup     # detect your CLIs + pick projects"
echo "    diktat pair      # show a QR; scan it in the Diktat app"
echo "    diktat start     # run in the background"
