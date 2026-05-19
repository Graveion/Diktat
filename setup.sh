#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_DIR="$REPO_DIR/daemon"
BUN="$HOME/.bun/bin/bun"

setup_launchd() {
  mkdir -p "$HOME/Library/LaunchAgents"
  local plist="$HOME/Library/LaunchAgents/com.diktat.daemon.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.diktat.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN</string>
        <string>run</string>
        <string>$DAEMON_DIR/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DAEMON_DIR</string>
    <key>RunAtLoad</key>
    <false/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$DAEMON_DIR/logs/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>$DAEMON_DIR/logs/daemon.error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin:$HOME/.local/bin</string>
    </dict>
</dict>
</plist>
EOF
  echo "Registered launchd service: com.diktat.daemon"
}

setup_systemd() {
  local service_dir="$HOME/.config/systemd/user"
  mkdir -p "$service_dir"
  cat > "$service_dir/diktat-daemon.service" <<EOF
[Unit]
Description=Diktat Daemon
After=network.target

[Service]
Type=simple
ExecStart=$BUN run $DAEMON_DIR/index.ts
WorkingDirectory=$DAEMON_DIR
Restart=always
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin:$HOME/.local/bin
StandardOutput=append:$DAEMON_DIR/logs/daemon.log
StandardError=append:$DAEMON_DIR/logs/daemon.error.log

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  echo "Registered systemd user service: diktat-daemon"
}

install_tailscale() {
  if [[ "$OS" == "Darwin" ]]; then
    echo "Opening Tailscale download page..."
    open "https://tailscale.com/download/mac"
    echo "Install Tailscale then press enter to continue."
    read -r || true
  else
    echo "Installing Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
}

# --- main ---

OS="$(uname -s)"
if [[ "$OS" != "Darwin" && "$OS" != "Linux" ]]; then
  echo "Unsupported OS: $OS"
  exit 1
fi

# Bun
if [[ ! -x "$BUN" ]]; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Dependencies
cd "$DAEMON_DIR" && $BUN install --frozen-lockfile --silent

# Tailscale
if ! command -v tailscale &>/dev/null; then
  install_tailscale
fi

# Logs dir
mkdir -p "$DAEMON_DIR/logs"

# Register service
if [[ "$OS" == "Darwin" ]]; then
  setup_launchd
else
  setup_systemd
fi

# Install diktat command
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO_DIR/diktat" "$HOME/.local/bin/diktat"
echo "Installed: diktat command → ~/.local/bin/diktat"

# Ensure ~/.local/bin is in PATH hint
if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
  echo ""
  echo "  Add this to your shell profile (~/.zshrc or ~/.bashrc):"
  echo '  export PATH="$HOME/.local/bin:$PATH"'
  echo ""
fi

# Hand off to interactive setup
$BUN run "$DAEMON_DIR/setup.ts"
