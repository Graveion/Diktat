# Diktat — daemon

The Mac daemon behind [Diktat](https://graveion.github.io/Diktat). It runs your
coding-agent CLIs (Claude Code, Codex, Cursor, GitHub Copilot, Kiro) on your own
machine and dials **out** to the Diktat relay, so the Diktat iOS app can start,
resume, and steer those sessions from anywhere — no inbound ports, your machine,
your logins.

The iOS app ships on the App Store. This repo is the open daemon plus the
landing page / installer.

## Install (macOS)

```bash
curl -fsSL https://graveion.github.io/Diktat/install.sh | bash
diktat setup        # detect installed CLIs + pick projects
diktat pair         # show a QR; scan it in the Diktat app
diktat start        # run in the background (launchd)
```

Re-run the installer any time to update, or `diktat update`.

## How it fits together

```
  Diktat iOS app ──wss──▶ relay ◀──wss── diktat daemon (your Mac) ──▶ claude / codex / cursor / copilot / kiro
```

- **Transport:** the daemon dials out to the relay — nothing listens for inbound
  connections on your Mac.
- **Identity & pairing:** you sign in on the app (Apple/Google); the Mac shows a
  QR you scan to bind the machine to your account and mint a per-machine token.
- **Protocol:** the phone↔daemon message contract is in
  [`daemon/PROTOCOL.md`](daemon/PROTOCOL.md); daemon setup detail in
  [`daemon/README.md`](daemon/README.md).

## Build from source

```bash
cd daemon
bun install
bun test
```

Releases (the prebuilt `diktat-arm64` binary the installer downloads) are built
by [`.github/workflows/release.yml`](.github/workflows/release.yml) on a tag.

## License

Source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE) — you
may read, run, and modify it for **noncommercial** purposes, but not sell or ship
it commercially. © Diktat.
