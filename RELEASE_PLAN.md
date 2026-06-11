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
- ✅ **Reviewer access:** "Try Demo" button on MachinesScreen activates demo mode
  (`useMockDiktat`, starts on sessions screen, green "Demo Mode" banner). Reviewer
  can exercise the full UI without a Mac. Still add reviewer notes in ASC (#20).

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
- ✅ **Server-side entitlement gate**: relay checks `account_state` on client leg
  upgrade; refuses connection with `4402` if trial expired + no comp + no
  subscription. Pure `isEntitled()` logic with 11 tests. Migration `0005` adds
  `entitled_until` column (written by RC webhook).
- ✅ **Rate limiting**: `/pair/init` — 20 req/60s per IP; client legs — max 5
  concurrent per account.
- ✅ **RevenueCat webhook** → **Supabase Edge Function** `rc-webhook`
  (`supabase/functions/rc-webhook`) writes `entitled_until` directly into
  `account_state` (upsert, handles subscribe-before-trial). The relay only
  *reads* that column at the gate — it no longer receives RC events. Fail-closed,
  constant-time secret compare, 2-year expiry clamp, and skips the write on
  events without an expiration (so no event type can null-wipe a live
  entitlement). `verify_jwt = false` (RC sends its own shared-secret header, not
  a Supabase JWT).

## Phase 4.5 — Quality sweep (full-codebase review pass)
- ✅ **Relay**: rate limiting keyed on `Fly-Client-IP` across ALL POST endpoints
  + map sweep; server-side trial start on first client connect (closes the
  "never call start_trial = free forever" bypass). RC webhook moved off the
  relay to a Supabase Edge Function (see Phase 4). 74 tests.
- ✅ **Daemon**: sessionId path-traversal guard; config.json 0600; cross-chunk
  line buffering (+ UTF-8 stream decode); 15-min inactivity watchdog; retry
  awaits prior proc exit; removed silent Cursor Shell(*) auto-grant; deleted
  dead daemon.sh; PROTOCOL.md drift fixed. 252 tests.
- ✅ **App correctness**: fresh auth token on every (re)dial + bounded
  unauthorized retries; sendMessage readyState guard (draft preserved on
  failure); spawned sessions auto-resume after reconnect; ping-timer leak;
  cold-start push tap handled (`getLastNotificationResponseAsync`) + push nav
  guards + entitlement gate on push resume; OTA check moved to root (runs
  pre-sign-in); RC listener cleanup + foreground entitlement refresh;
  Supabase session moved to Keychain (SecureStore, lazy-migrates).
- ✅ **Design sweep**: theme tells the truth (violet terminal); GitHub palette
  evicted from ChatScreen (codeBg/codeText tokens); textMuted recut + readable
  copy moved to textSub (contrast); safe-area insets everywhere (no more
  hardcoded 56/64); Banner component unifies error/demo/trial (+ demo Exit);
  emoji → Ionicons; solid accent buttons (gradients dropped); machines empty
  state now has install→pair→scan steps with copyable curl command.
- ✅ **Delights/perf**: mic-primary composer (morphs mic→send→stop);
  streaming caret; pairing dot bloom; tool-drawer + send animations;
  MessageBubble memoized (no more full re-render per token); reduce-motion
  respected throughout; a11y labels on all primary controls.
- ✅ Maestro `cold_start_test.yaml` (`clearState: true` — the path that shipped
  the hooks crash). Dead deps removed (react-navigation ×2, expo-av,
  expo-speech, syntax-highlighter, Syne fonts).
- ⬜ **Operator actions required before deploy:**
  - Run migrations 0004 + 0005 on prod Supabase (`supabase db push`) FIRST —
    the relay's server-side trial-start and the webhook both write columns 0005
    adds.
  - **RC webhook (Supabase Edge Function):**
    - `supabase secrets set RC_WEBHOOK_SECRET=<random>` (a value you invent).
    - `supabase functions deploy rc-webhook`.
    - In the RC dashboard add a webhook → URL
      `https://sxikqegkvbeahtcnoozx.supabase.co/functions/v1/rc-webhook`,
      Authorization header value = the SAME `<random>`. Limit events to: Initial
      purchase, Renewal, Product change, Cancellation, Billing issue, Expiration,
      Uncancellation.
  - `eas secret:create --scope project --name RC_IOS_KEY --value <key>`.
  - **expo-secure-store is a new native module** — local simulator builds need
    `npx expo run:ios` once, and #19's production build picks it up.
- ✅ **launchd keep-alive**: `diktat start` on macOS now installs a per-user
  LaunchAgent (RunAtLoad + KeepAlive) so the daemon survives logout, crash, and
  reboot; `stop`/`status` are launchd-aware; falls back to nohup off-macOS or if
  launchctl fails. (daemon/service.ts, 5 tests.)
- ✅ **Daemon output replay**: while the phone is detached the daemon buffers
  session output (256 KB cap) and replays it on reattach — no gap in the live
  transcript across a brief disconnect. On buffer overflow it sends a `resync`
  frame and the app reloads full history instead (the auto-resume gap fix).
  (daemon/relay-client.ts + app/useDiktat.ts, 6 tests.)
- Deferred (post-launch): machineId in push payload + auto-connect; #22 adapter
  registry refactor.

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
