#!/usr/bin/env bash
set -e

OS="$(uname -s)"
DAEMON_DIR="$(cd "$(dirname "$0")/daemon" && pwd)"
LOG="$DAEMON_DIR/logs/daemon.log"
ERR_LOG="$DAEMON_DIR/logs/daemon.error.log"

# macOS: launchctl, Linux: systemctl --user
do_start() {
  if [[ "$OS" == "Darwin" ]]; then
    launchctl load "$HOME/Library/LaunchAgents/com.diktat.daemon.plist"
  else
    systemctl --user start diktat-daemon
  fi
  echo "Diktat daemon started."
}

do_stop() {
  if [[ "$OS" == "Darwin" ]]; then
    launchctl unload "$HOME/Library/LaunchAgents/com.diktat.daemon.plist"
  else
    systemctl --user stop diktat-daemon
  fi
  echo "Diktat daemon stopped."
}

do_status() {
  if [[ "$OS" == "Darwin" ]]; then
    if launchctl list | grep -q "com.diktat.daemon"; then
      echo "Diktat daemon is running."
    else
      echo "Diktat daemon is not running."
    fi
  else
    systemctl --user status diktat-daemon
  fi
}

do_logs() {
  if [[ "$OS" == "Darwin" ]]; then
    tail -f "$LOG" "$ERR_LOG"
  else
    journalctl --user -u diktat-daemon -f
  fi
}

case "$1" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop && sleep 1 && do_start ;;
  status)  do_status ;;
  logs)    do_logs ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
