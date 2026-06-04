# Diktat

Drive your Claude Code / Cursor coding sessions from your phone — from anywhere.

A daemon runs on your Mac and holds your CLI sessions; a relay brokers a secure
connection; the iOS app lets you start, resume, and steer sessions on the go,
with push notifications when a run finishes.

## Layout

| Dir | What |
|---|---|
| `daemon/` | Mac daemon — runs the CLIs, connects out to the relay. **[Setup →](daemon/README.md)** |
| `app/` | Expo / React Native iOS app (sign-in, machines, chat, paywall). |
| `relay/` | Bun WebSocket relay broker (auth, ownership, pairing). **[Protocol →](relay/RELAY.md)** |
| `supabase/` | Accounts, machines, pairing, billing schema. **[Model →](supabase/README.md)** |

## Quick start (your Mac)

```bash
cd daemon && bun install && bun link
diktat setup        # detect CLIs + pick projects
diktat pair         # show a QR; scan it in the app
diktat start        # run in the background
```

## How it fits together

```
  iPhone app ──wss──▶ relay (Fly.io) ◀──wss── daemon (your Mac) ──▶ claude / cursor CLIs
       │                                            │
       └── Supabase: Apple/Google sign-in, ─────────┘
           machine registry, pairing, billing
```

- **Identity:** Supabase (Sign in with Apple + Google).
- **Pairing:** the Mac shows a QR; the phone (signed in) scans it to bind the
  machine to your account and mint a per-machine token.
- **Transport:** the daemon dials out to the relay — no inbound ports.
- **Billing:** one free hour, then a `pro` subscription (RevenueCat) or a comp code.
