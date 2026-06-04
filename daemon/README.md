# Diktat daemon

The daemon runs on your Mac, holds your Claude Code / Cursor CLI sessions, and
connects out to the Diktat relay so the phone app can drive them from anywhere.

## Prerequisites

- **[Bun](https://bun.com)** (`curl -fsSL https://bun.sh/install | bash`)
- At least one coding CLI installed and logged in:
  - **Claude Code** — `claude` on your PATH, logged in (`claude login`)
  - and/or **Cursor CLI** — `cursor` on your PATH (auth is managed by the IDE)

## Install

```bash
git clone <repo> diktat && cd diktat/daemon
bun install
bun link            # puts the `diktat` command on your PATH (one time)
```

`diktat` now works from any directory.

## Set up

```bash
diktat setup        # detects your CLIs, checks login, picks which projects to expose
```

This writes `daemon/config.json` (projects + relay credentials). Re-run anytime
to change the exposed projects.

## Pair with your phone

1. In the Diktat app, sign in and tap **Pair a machine** (the camera opens).
2. On your Mac:

   ```bash
   diktat pair       # prints a QR code in the terminal
   ```

3. Point the phone at the QR. The machine binds to your account and connects.

> No camera handy? The app can also show a typed code — run `diktat pair <code>`.

## Run

```bash
diktat start        # starts the daemon in the background
diktat status       # is it running?
diktat stop         # stop it
diktat start -f     # run in the foreground (Ctrl-C to stop)
```

Logs: `~/.diktat/daemon.log`.

## How it connects

The daemon dials **out** to the relay (`wss://diktat-relay.fly.dev`) and holds
the connection open — no inbound ports, no Tailscale. Your per-machine token
lives in `daemon/config.json` (gitignored). See `../relay/RELAY.md` for the wire
protocol and `../supabase/README.md` for the account/pairing model.

## Security note

Diktat grants the Cursor CLI `Shell(*)` so it can run shell commands on your
machine. Only pair machines you control, and keep `config.json` private.
