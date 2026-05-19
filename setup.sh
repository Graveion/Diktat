#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_DIR="$REPO_DIR/daemon"
BUN="$HOME/.bun/bin/bun"

setup_launchd() {
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

# --- main ---

echo "=== Diktat Setup ==="

OS="$(uname -s)"
if [[ "$OS" != "Darwin" && "$OS" != "Linux" ]]; then
  echo "Unsupported OS: $OS"
  exit 1
fi

if [[ ! -x "$BUN" ]]; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
else
  echo "Bun already installed: $($BUN --version)"
fi

echo "Installing dependencies..."
cd "$DAEMON_DIR" && $BUN install --frozen-lockfile

if [[ ! -f "$DAEMON_DIR/config.json" ]]; then
  cp "$DAEMON_DIR/config.example.json" "$DAEMON_DIR/config.json"
  echo ""
  echo "Created config.json — edit your project paths, then press enter."
  ${EDITOR:-nano} "$DAEMON_DIR/config.json"
  read -r
else
  echo "config.json already exists, skipping."
fi

mkdir -p "$DAEMON_DIR/logs"

if [[ "$OS" == "Darwin" ]]; then
  setup_launchd
else
  setup_systemd
fi

echo ""
echo "=== Setup complete ==="
echo "Run './daemon.sh start' to start the daemon."
