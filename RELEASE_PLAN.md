# Diktat — App Store release plan

Living checklist to get from "friends beta" to App Store. Ordered by phase.
Status legend: ✅ done · 🟡 in progress · ⬜ todo.

---

## Where we are
- Core app + daemon + relay working; 5 agent CLIs (Claude, Cursor, Codex, Copilot, Kiro)
  with detection, invocation, history readers, and model/permission selection.
- ✅ Account sign-in (Apple/Google), pairing (QR + code), paywall (RevenueCat),
  account deletion, privacy/support pages hosted, crash boundary.
- ✅ **New (this pass):** model + permission composer controls, in-app feedback
  (→ Supabase) with crash-log attach, store-review prompt, lightweight analytics
  funnel, Privacy/Support links in Settings.

---

## Phase 0 — Decisions to lock first
- ⬜ **Analytics → privacy labels.** We now collect first-party Usage Data
  (PII-free events) + Identifiers (account id). Declare in the ASC privacy
  questionnaire as **Usage Data → Product Interaction**, **Linked to identity**,
  **Not used for tracking** → no ATT prompt needed. (Drives #20.)
- ⬜ **Pricing/trial copy** final (RevenueCat offering + paywall strings).

## Phase 1 — Pre-TestFlight engineering
- ⬜ **Run the new Supabase migration** `0004_events_feedback.sql` against prod
  (events + feedback tables + RLS). Verify an event + a feedback row land.
- ⬜ **Eyeball the new UI on device** (couldn't be visually verified in CI):
  composer model/permission pills + selector, Settings → Feedback form, rating
  prompt path. Run the updated Maestro flows (`settings_sheet_test`,
  `new_session_picker_test`).
- ⬜ **Per-turn model/permission**: smoke-test that changing the composer model
  actually changes the agent's behaviour for the next turn on a real CLI.
- 🟡 **Crash reporting**: AsyncStorage→Supabase via feedback "attach diagnostics"
  is in. Decide if Sentry is worth adding before scale (free tier; optional).
- ⬜ **Reviewer access problem (critical):** Apple's reviewer cannot pair a Mac
  running the daemon. Mitigation options — pick one:
  - a built-in **"Demo / guided tour" mode** (reuse `useMockDiktat`) reachable
    without pairing, **or**
  - a **demo video** + thorough reviewer notes explaining the Mac-companion model.
  Without this, review will likely be rejected as "can't test core feature."

## Phase 2 — Build & TestFlight (task #19)
- ⬜ EAS **production build** (`eas build -p ios --profile production`); confirm
  bundle id, version/build bump, entitlements, push (APNs) config.
- ⬜ `eas submit` to App Store Connect → TestFlight.
- ⬜ Internal testers (you + friends); verify OTA update channel works.
- ⬜ Confirm RevenueCat sandbox purchases + restore on a real device.

## Phase 3 — App Store Connect metadata (task #20)
- ⬜ **Screenshots** — App Store now requires **6.9"** (iPhone 17 Pro Max,
  1320×2868). We have 6.7"; regenerate/add 6.9".
- ⬜ Name, subtitle, description, keywords, promo text, support URL
  (`graveion.github.io/Diktat/support.html`), marketing URL.
- ⬜ **Privacy labels** per Phase 0 decision.
- ⬜ Age rating questionnaire; category (Developer Tools / Productivity).
- ⬜ App privacy: confirm `PrivacyInfo.xcprivacy` reflects actual API usage
  (UserDefaults/AsyncStorage reason codes, etc.).
- ⬜ Reviewer notes + (if chosen) demo creds/video from Phase 1.

## Phase 4 — Relay hardening before public (task #21, HIGH)
- ⬜ **Server-side entitlement gate** (relay/HARDENING.md): move paywall from
  client to relay; refuse to broker for non-entitled accounts. Wire RevenueCat
  webhook → `account_state`. Fail closed.
- ⬜ **Rate limiting / DoS guards** on both relay legs + `/pair/claim`.
- ⬜ Tests mirroring existing auth tests (entitled / expired / comp / pro / error).

## Phase 5 — Submit & launch
- ⬜ Submit for review; respond to any rejection (reviewer-access is the likely one).
- ⬜ Phased release on; monitor crashes (feedback table) + funnel (events table).
- ⬜ Watch RevenueCat conversion; first-week feedback triage.

---

## Not launch-blocking (post-launch)
- ⬜ #22 Adapter-registry refactor (fold buildArgs/parse into per-agent adapters).
- ⬜ Add-file / @-mention context attachment (path-based, per codex-web-ui finding).
- ⬜ Structured tool-output parsers for Copilot/Kiro/Codex (rich tool cards) when
  authed sample output is available.
- ⬜ Reasoning-effort selector (Codex/Claude) in the composer ("Medium" pill).
- ⬜ Sentry (if crash volume warrants beyond the Supabase path).

## Analytics funnel (what we now record — PII-free)
`app_connected · session_started{cli,model,permissionMode} · session_resumed{source,cli} ·`
`message_sent{permissionMode} · session_completed · paywall_* · feedback_submitted · rating_prompted`
Inspect server-side in the `events` table (no client read policy).
