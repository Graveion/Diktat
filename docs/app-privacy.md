# App Privacy answers (App Store Connect)

Grounded in the actual data flows: Apple/Google sign-in → Supabase auth;
RevenueCat for purchases; Expo push token for notifications; first-party,
PII-free product analytics in a Supabase `events` table (no third-party
analytics/ads/crash SDKs); prompts/code/output transit the Fly relay in transit
(TLS) and are NOT stored by the relay. No third-party tracking. No ad networks.

## Tracking
**Does this app track you?** → **No.**
Nothing is shared with data brokers or ad networks; no cross-app/website tracking;
analytics are first-party and account-scoped only.

## Data used to track you
**None.**

## Data linked to you
(Each: used for App Functionality and/or Analytics; NOT for tracking.)

- **Contact Info → Email Address** — from Apple/Google sign-in (may be an Apple
  private-relay address). Purpose: App Functionality (account, auth).
- **Identifiers → User ID** — Supabase account id. Purpose: App Functionality.
- **Identifiers → Device ID** — Expo push token, stored to deliver run-complete
  notifications. Purpose: App Functionality.
- **Purchases → Purchase History** — subscription status via RevenueCat. Purpose:
  App Functionality (entitlement).
- **Usage Data → Product Interaction** — first-party events (e.g. session started,
  message sent), account-scoped, PII-free. Purpose: Analytics + App Functionality.

## Data NOT linked to you
**None** (everything is account-scoped, so it's all "linked").

## Diagnostics / Crash data
**None collected** — there's an in-app crash boundary but no external crash/diag
reporting service.

## The one judgment call: User Content (prompts, code, diffs, output)
This content travels phone → relay → your Mac over TLS (`wss`). The relay
**forwards frames and does not persist them**; the agent runs on the user's own
machine. It is therefore transmitted-but-not-stored.

Two defensible options:
- **Conservative (recommended):** declare **User Content → Other User Content**,
  Linked to you, App Functionality, NOT tracking — and state in the written
  privacy policy that it is processed in transit only to operate the feature and
  is not retained on our servers. Under-declaring is the bigger rejection risk.
- **Ephemeral exception:** Apple lets you omit data that only passes through
  briefly and isn't stored/used for tracking. Defensible here, but only take it
  if you're confident the relay never logs frame contents.

Either way: **do not claim end-to-end encryption.** Diktat is TLS-in-transit via
a relay you operate (the relay *could* read frames); it is not zero-knowledge.
The privacy policy and any marketing must not imply otherwise.

## Make the written policy match
The hosted policy (docs → privacy.html, GitHub Pages) should state plainly:
- what's collected (the list above) and why;
- that code/prompts transit the relay to reach your Mac and are not stored;
- that the AI runs on the user's machine under their own CLI subscription;
- third-party processors: Supabase (auth + data), RevenueCat (purchases), Expo
  (push), Fly.io (relay transit), Apple/Google (sign-in);
- it is encrypted in transit, not end-to-end.

## Processors (for your reference; ASC labels describe what the app collects)
Supabase · RevenueCat · Expo (push) · Fly.io (relay) · Apple/Google (auth).
Apple's Speech framework handles dictation — audio may go to Apple, not to us;
Diktat does not collect audio, only the resulting text (which becomes the prompt).
