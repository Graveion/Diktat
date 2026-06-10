# Relay hardening — abuse & entitlement enforcement

**Status:** 🟡 in progress · **Priority:** high · **Blocking TestFlight?** No.
**Do before:** any public launch / App Store release with real users.

## What's done

- **Entitlement gate** (`relay/supabase-auth.ts`): `isEntitled()` pure function + `getEntitlement` dep seam. On the client leg, the relay queries `account_state` (trial_started_at, comp_until, entitled_until) after ownership check. Non-entitled accounts receive close code 4402. Fail-closed on lookup error. First-time users (no row yet) are allowed through.
- **Rate limiting** (`relay/index.ts`): per-IP rate limit on `/pair/init` (20 req / 60s); per-account concurrent client connection cap (max 5).
- **Schema** (`supabase/migrations/0005_entitled_until.sql`): `entitled_until timestamptz` column on `account_state`, to be written by the RevenueCat webhook.

## Why

The relay authenticates *identity* and *ownership* but not *entitlement*:

- Daemon leg (`/agent`) — per-machine token must SHA-256-match `machines.token_hash`
  (constant-time). ✅
- Phone leg (`/client`) — valid Supabase JWT **and** `machines.account_id === jwt.sub`,
  so a user can only reach machines they own (`supabase-auth.ts:57`). ✅
- Pairing (`/pair/claim`) — requires a valid account JWT + anti-hijack check. ✅

**Gap:** the paywall (`useEntitlements.gateAccess`) is enforced **client-side only**.
Sign-up is open (Apple/Google), so anyone can clone the public repo, sign in, pair
their own Mac, and use our relay + Supabase **for free**, bypassing the App Store.
The relay can't tell the official app from a clone — both present a valid JWT.

Blast radius is small today (relay is a dumb pipe; bandwidth is pennies; private
beta = effectively just us). But this must close before public traction.

## Plan

### 1. Server-side entitlement gate (the real fix)
Move the paywall from client to server. Refuse to broker for non-entitled accounts.

- Check at **connection upgrade** (both legs) and/or at `/pair/claim`.
- Source of truth = `account_state` (`trial_started_at`, `comp_until`) + a
  subscription flag. Reuse existing tables.
- Wire RevenueCat → backend: RC webhook updates `account_state` on
  purchase/renew/expire (or relay queries RC REST API). Store an
  `entitled_until` / `is_pro` column so the relay does one cheap read.
- Decision logic: entitled = `is_pro` OR `comp_until > now` OR within free trial
  window. Fail closed on lookup error.
- Add tests mirroring the existing auth tests (entitled / expired-trial /
  comp-active / pro / lookup-failure).

### 2. Rate limiting / DoS guards
- Per-IP + per-account connection caps.
- Throttle `/pair/init` (in-memory nonce store can be spammed; it's TTL'd but
  unbounded in burst).
- Cap concurrent connections per account.

### 3. App attestation (optional, later)
- Apple App Attest / DeviceCheck to prove the JWT came from our genuine binary.
- Strongest anti-clone, but iOS-plumbing-heavy. Overkill until #1 + #2 are in and
  abuse is observed.

## Acceptance criteria
- A signed-in account with no entitlement is refused at the relay (cannot open an
  agent or client leg), regardless of which app/client connects.
- Entitlement state is driven server-side (RC webhook or RC API), not by the app.
- Basic rate limits in place; `/pair/init` cannot be trivially flooded.
