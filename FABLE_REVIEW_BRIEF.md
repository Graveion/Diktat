# Diktat — Critical Quality Review Brief

> **Handoff prompt for Fable.** You are being brought in as a senior, skeptical reviewer for a final quality sweep before a v1.0 App Store release. Your job is *not* to praise what exists — assume it's decent and look for what's wrong, fragile, inconsistent, or merely "good enough." Be specific and opinionated. Every finding should be actionable: name the file, the line if you can, the concrete change, and *why*. Rank findings by severity. Where you propose UI changes, mock them up visually (use your design/visualization tooling) rather than describing them in prose.
>
> **The repo is at `/Users/timothy.green/personal/Diktat` — read the files directly, don't work only from this brief.** Start with `RELEASE_PLAN.md` (current status), `app/src/theme.ts`, `app/App.tsx`, `daemon/PROTOCOL.md`, and `daemon/AGENT-SUPPORT.md`, then range across `app/src/`, `daemon/`, and `relay/` as the findings lead you.

---

## 1. What Diktat is

Diktat is a **remote control for terminal AI coding agents** (primarily Claude Code) from an iPhone. A small daemon runs on the user's Mac; a relay server brokers an end-to-end connection; the iOS app lets the user start/resume coding sessions, send instructions **by voice or text**, watch streamed output, and get push notifications when the agent needs input — all without being at the desk.

**The pitch:** "Code review on the sofa. Hotfix on the bus. Ship from anywhere."

### Architecture (monorepo)
- **`app/`** — Expo / React Native (SDK 54, new architecture), TypeScript. The iOS app. *This is where most of the review attention should go.*
- **`daemon/`** — runs on the user's Mac, wraps the local CLI agent, speaks to the relay. Supports **5 agent CLIs** (Claude, Cursor, Codex, Copilot, Kiro) with per-agent detection, invocation, history/session readers, and model + permission-mode selection.
- **`relay/`** — Bun WebSocket broker on Fly.io. Two "legs" per pairing: an **agent leg** (the Mac daemon) and a **client leg** (the phone). Brokers messages, enforces ownership + entitlement.
- **`supabase/`** — Postgres + auth (Sign in with Apple / Google), `account_state` table, migrations.
- **`docs/`** — GitHub Pages: install script, privacy policy, support page.
- **`store/`** — App Store screenshots & assets.

### Target audience
Professional software engineers who already use Claude Code (or similar CLI agents) on a Mac and want to drive it while away from the keyboard. Technical, opinionated, allergic to bloat and to "AI slop" UI. They will judge the app on whether it feels *fast, trustworthy, and crafted* — not on feature count.

### Monetisation
Free trial (1 hour of usage), then **Diktat Pro**: $3.99/month or $29.99/year via RevenueCat + StoreKit 2. Entitlement is enforced **server-side** on the relay's client leg (fail-closed) and surfaced client-side via a paywall. There's also a comp/redeem-code path.

---

## 2. Current state

v1.0 is feature-complete and in App Store submission. Recently landed: server-side entitlement gate, per-IP + per-account rate limiting on the relay, a RevenueCat webhook bridging subscription events to the server check, a "Try Demo" reviewer path (mock data, no Mac needed), crash boundary, OTA eager-update on cold launch, in-app account deletion.

### App screens (`app/src/screens/`)
- `SignInScreen` — Apple / Google sign-in gate
- `MachinesScreen` — list of paired Macs, QR pairing entry, empty state with "Try Demo →"
- `ScanScreen` — QR pairing camera
- `SessionsScreen` — sessions for the connected Mac; start new / resume; CLI + project + model + permission-mode pickers
- `ChatScreen` — the core: streamed agent output, tool-call rendering, voice/text input, reconnect banner
- `PaywallScreen` — Diktat Pro
- `DebugScreen` — hidden, opened by a 3-finger tap

### Hooks (`app/src/hooks/`)
`useAuth`, `useDiktat` (the relay/session engine), `useMockDiktat` (demo), `useEntitlements`, `useMachines`, `usePushToken`, `useSettings`.

---

## 3. Design system as it stands today

This is the area most in need of a **deep, critical dive.** Do not accept it as-is.

### Palette (`app/src/theme.ts`) — "warm-dark amber terminal" … except it's actually violet
```
bg #07060a · surface #0f0d13 · card #171420 · input #1c1927 · border #252130
accent #a78bfa (violet) · accentBright #c4b5fd · userBubble #5b21b6
text #f0eef8 · textSub #8b85a1 · textMuted #3d3850
success #34d399 · warning #fbbf24 · error #f87171 · info #60a5fa
```
⚠️ The file's own comment claims an *"amber terminal aesthetic"* and *"Syne (display)"* font, but the accent is **violet** and the display font actually resolves to **Space Grotesk**. This drift between stated intent and reality is exactly the kind of incoherence to interrogate: **is there a real, defensible design vision here, or an accumulation of defaults?**

### Typography (`fonts`)
- Display: `SpaceGrotesk_700Bold` (note: `display` and `displayXBold` both point to the *same* weight — dead distinction)
- Body: Outfit (400/500/600/700)
- Mono: Menlo (iOS)
- Syne is loaded in `App.tsx` but **may not be used** — confirm and remove if dead.

### Spacing / radii
8-pt-ish scale (`xs 4 · sm 8 · md 14 · lg 20 · xl 28 · xxl 40`); radii `sm 6 · md 12 · lg 18 · xl 24 · full 999`.

---

## 4. What we want from you

### A. UI / UX — the priority, go deep
Treat this as an art-director + interaction-design critique, not a checklist. Reference modern, sleek, *crafted* apps (Linear, Raycast, Things, Things-tier polish; terminal-native tools like Warp, Ghostty) as the bar. Specifically:

- **Coherent vision.** Is there one? Name it or call out that there isn't. The amber-vs-violet drift suggests not. Propose a *single* defensible direction and show what it implies for palette, type, and surface treatment.
- **Colour.** Is the violet-on-near-black palette doing real work or is it generic "dark mode dev tool"? Contrast/accessibility (WCAG AA on `textSub`/`textMuted` over `bg`)? Semantic colour usage consistent?
- **Typography.** Is Space Grotesk + Outfit a deliberate pairing or two characterful fonts fighting? Type scale, line-heights, letter-spacing on the display sizes. Mono usage in chat/tool output.
- **Layout & button placement.** Per screen — especially `ChatScreen` (input affordance, send/cancel, voice button discoverability, tool-call density) and `SessionsScreen` (the picker stack). Thumb-reach, hierarchy, where the eye lands first.
- **No AI slop.** Flag anything that reads as template/default: centered-everything, gratuitous gradients, emoji-as-icons, inconsistent corner radii, banners that don't match. Be ruthless.
- **Empty / loading / error states.** Especially the `MachinesScreen` empty state, reconnect banner, paywall "unavailable" state, splash.
- **Delight.** Where can small, *tasteful* micro-interactions earn their keep? (Reanimated is already in use — `FadeIn`/`FadeInUp` on the paywall.) Think: streamed-token cadence, send-message spring, tool-call expand, pairing-success moment, pull-to-refresh on machines. Propose 3–5 specific, low-risk delights — and call out any existing animation that's overdone or janky.

**For every UI proposal: produce a visual mockup** (SVG/HTML via your design tooling) so the change is seen, not just argued. Provide before/after where useful. Coherent set > scattered one-offs.

### B. Maintainability / code quality
- `App.tsx` is the composition root and carries a lot (navigation-by-`useState`, effect-driven screen transitions, demo-mode branching). Is the screen-routing approach (`useState<Screen>` + effects) going to scale, or should it move to a real navigator? Trade-offs.
- `useDiktat` is the engine — review its state machine, reconnect logic, race conditions, cleanup.
- Type safety, dead code (the font/colour drift above; `displayXBold`), prop-drilling vs context, test coverage gaps (relay has 63 tests; the app's coverage is thinner — what's untested that matters?).
- Consistency of patterns across the 7 screens.

### C. Security
- Relay entitlement gate (`relay/supabase-auth.ts` — `isEntitled`, fail-closed, client-leg-only) and rate limiting (`relay/index.ts`). Probe for bypasses, the RC webhook auth (`/rc/webhook`, shared-secret header), token handling, ownership checks.
- Client: token storage, deep-link handling from push, any secret that could leak into the JS bundle or OTA. **Note:** RC API keys are injected via env (`app.config.js` ← `RC_IOS_KEY`) and must never be committed — verify nothing else is similarly leaky.
- Supabase RLS assumptions on `account_state`.

### D. Daemon (`daemon/`) — the Mac-side engine
The daemon is a Bun process that detects installed CLI agents, spawns/wraps them, streams their output to the relay, and reads each agent's session history. It is the part most likely to break silently on a user's machine. Review:
- **The multi-agent abstraction.** There's a file per agent (`claude-sessions.ts`, `cursor-sessions.ts`, `codex-sessions.ts`, `copilot-sessions.ts`, `kiro-sessions.ts`) plus `agents.ts`, `cli-detector.ts`, `codex-rollout.ts`, `kiro-conversation.ts`. This is exactly the duplication that task #22 (adapter-registry refactor) targets — *is the refactor the right call, and what should the adapter interface be?* Propose the shape (detect / buildArgs / spawn / parseHistory / parseToolOutput) and what each agent file collapses into.
- **Process lifecycle.** Spawning, killing, zombie/orphan handling, what happens when the wrapped CLI crashes or hangs, stdout/stderr backpressure, partial-line buffering of streamed tokens.
- **`relay-client.ts` reconnect** — mirror of the app's `useDiktat`; does it recover cleanly, re-auth, resume in-flight sessions?
- **`pair.ts`** pairing/auth, **`push.ts`** APNs notification triggering, **`file-read.ts`** + `path-utils.ts` (path traversal? does the daemon expose any filesystem read the phone shouldn't reach?), **`cursor-shell-permissions.ts`** (shell-permission gating — a real security surface).
- **Config** (`config.ts` / `config.json`) — secrets at rest on the Mac, schema validation, migration.
- **Distribution.** The daemon installs via `curl … | bash` (`docs/install.sh`) and `daemon.sh` / `setup.ts`. Review the install UX and trust/security of the pipe-to-bash path, plus how the daemon stays running (launchd? manual?). `PROTOCOL.md` and `AGENT-SUPPORT.md` document the wire format and how to add an agent — sanity-check they match the code.
- Test coverage looks decent (many `*.test.ts`); flag the gaps that matter (lifecycle, reconnect, the parsers under malformed input).

### E. App Store / release readiness
v1.0 is mid-submission. The full plan lives in `RELEASE_PLAN.md` — read it. Pressure-test the parts most likely to cause a **rejection or a bad launch**:
- **Reviewer access.** The "Try Demo" path (mock data, no Mac) is the mitigation for "reviewer can't test a remote-control app." Is it convincing enough, and are the ASC reviewer notes adequate? Apple rejecting on "couldn't evaluate functionality" is the single likeliest rejection here — stress it.
- **Privacy labels & manifest.** First-party PII-free analytics (Usage Data → Product Interaction, linked to account id, *not* tracking → no ATT prompt). Verify that declaration is correct and that `PrivacyInfo.xcprivacy` reflects real API usage (AsyncStorage/UserDefaults reason codes etc.). A mismatch is an automated-review reject.
- **Subscriptions.** Paywall must show real localized prices from the RC offering, restore must work, and the StoreKit/RC sandbox→prod path must be sound. Required-reason and "no purchase = no premium" rules. The subscription Review-Info screenshot is separate from the listing screenshots — confirm both slots are right.
- **Screenshots/metadata.** 6.9" (1320×2868) is now mandatory; 6.7" (1284×2778) also present. Critique the *content* of the screenshots (do they sell the product / read as crafted, or as default simulator grabs?) and the listing copy (name, subtitle, description, keywords, promo text) for clarity and ASO.
- **Account deletion, privacy/support URLs, age rating, category** (Developer Tools / Productivity) — confirm each is correct and consistent.
- **OTA channel** — verify the eager cold-launch OTA update can't brick the app (bad bundle → boot loop?) and that runtimeVersion policy is sane.
- Anything in `RELEASE_PLAN.md` still marked ⬜/🟡 that's actually a blocker rather than nice-to-have — call it out and reorder.

### F. Anything else
Performance (cold start with eager OTA, list virtualization in chat/sessions), accessibility (VoiceOver, Dynamic Type, reduce-motion respecting the animations you propose), error observability (crash boundary persists locally + Supabase feedback attach — is that enough, or is Sentry warranted?), and any cross-cutting risk the sections above missed.

---

## 5. Hard constraints (do not violate)
- **No Claude attribution in commits** — no `Co-Authored-By: Claude` trailer, no "Generated with Claude Code" in messages.
- **No secrets in git** — RC keys live in `app/.env.local` (gitignored) and EAS secrets only.
- **Expo SDK 54 is pinned.** Read the *versioned* docs (`https://docs.expo.dev/versions/v54.0.0/`) before proposing any Expo/RN API change — APIs have moved.
- The app ships UI updates via **OTA**; native changes need a new EAS build. Prefer OTA-safe proposals where possible, and flag when a change requires a native rebuild.

## 6. Output format
1. **Executive read** — 3–5 sentences: is this release-quality? Biggest risk? Most likely App Store rejection reason?
2. **Design verdict + proposed vision** — with mockups (the priority).
3. **Findings table** — `severity (blocker/high/medium/low) · area (ui/maintainability/security/daemon/appstore) · file · finding · fix`.
4. **Daemon verdict** — is the multi-agent code healthy, and what's the right adapter-registry shape (#22)?
5. **Release-readiness checklist** — go / no-go on each blocker in `RELEASE_PLAN.md`, reordered by real priority.
6. **Delight shortlist** — 3–5 concrete micro-interactions, ranked by impact-to-effort.
7. **What you'd cut** — anything over-built or off-vision.

Don't hedge. If something's mediocre, say so and show the better version.
