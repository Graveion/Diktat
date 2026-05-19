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
        <string>/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin</string>
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
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin
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
    echo "Install Tailscale, log in, then press enter to continue."
    read -r || true
  else
    echo "Installing Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
}

wait_for_tailscale() {
  echo "Waiting for Tailscale connection..."
  echo "A browser window may open for authentication."
  tailscale up 2>/dev/null || true
  local attempts=0
  while ! tailscale status &>/dev/null; do
    if [[ $attempts -ge 30 ]]; then
      echo "Tailscale not connected after 30s. Run 'tailscale up' manually then restart the daemon."
      return
    fi
    sleep 2
    ((attempts++))
  done
  local ts_ip
  ts_ip="$(tailscale ip -4 2>/dev/null || true)"
  echo "Tailscale connected: $ts_ip"
}

# --- main ---

echo "=== Diktat Setup ==="

OS="$(uname -s)"
if [[ "$OS" != "Darwin" && "$OS" != "Linux" ]]; then
  echo "Unsupported OS: $OS"
  exit 1
fi

# Bun
if [[ ! -x "$BUN" ]]; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
else
  echo "Bun already installed: $($BUN --version)"
fi

# Dependencies
echo "Installing dependencies..."
cd "$DAEMON_DIR" && $BUN install --frozen-lockfile

# Config
if [[ ! -f "$DAEMON_DIR/config.json" ]]; then
  cp "$DAEMON_DIR/config.example.json" "$DAEMON_DIR/config.json"
  echo ""
  echo "Created config.json — edit your project paths, then press enter."
  ${EDITOR:-nano} "$DAEMON_DIR/config.json"
  read -r || true
else
  echo "config.json already exists, skipping."
fi

mkdir -p "$DAEMON_DIR/logs"

# Tailscale
if ! command -v tailscale &>/dev/null; then
  echo "Tailscale not found."
  install_tailscale
else
  echo "Tailscale already installed."
fi

if command -v tailscale &>/dev/null; then
  if ! tailscale status &>/dev/null; then
    wait_for_tailscale
  else
    ts_ip="$(tailscale ip -4 2>/dev/null || true)"
    echo "Tailscale already connected: $ts_ip"
  fi
fi

# Service
if [[ "$OS" == "Darwin" ]]; then
  setup_launchd
else
  setup_systemd
fi

echo ""
echo "=== Setup complete ==="
echo "Run './daemon.sh start' to start the daemon."
