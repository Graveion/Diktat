# Competitive UI/UX audit (post-launch backlog)

Researched against Happy Coder (slopus/happy), Cursor iOS, Claude Code Remote
Control, GitHub Copilot on GitHub Mobile, and Lunel. Compared to Diktat's actual
source. Keep this as the polish backlog after v1 ships.

## Highest-leverage gaps — all about the LIVE RUN

**H1 — In-stream permission approval cards (the missing core loop).**
Claude Code Remote Control's whole model is "approve/deny every tool call from
the phone"; Cursor pushes "needs input." Diktat only has *pre-flight* modes
(Plan/Auto/Full pills). Add an inline approval card in the message stream:
command/diff + Allow / Deny / Allow-for-session, with haptic + push. Unlocks
safer default permission modes. (code.claude.com/docs/en/remote-control)

> **DEFERRED (spiked 2026-07-08).** No portable path across Diktat's 5 CLIs.
> Findings:
> - Claude 2.x headless (`claude -p`) has **no in-turn approval round-trip**.
>   `--permission-prompt-tool` (the 1.x hook) is **removed**; default-mode
>   headless just auto-*denies* and continues (emits `permission_denials`),
>   even under bidirectional `--input-format stream-json` (no `control_request`
>   is emitted without the Agent SDK control handshake).
> - The real round-trip is the **Agent SDK `canUseTool` callback** — but that's
>   **Claude-only**, and would mean a second execution path (SDK) alongside the
>   CLI-spawn model used for Cursor/Codex/Copilot/Kiro, each of which has its own
>   (non-standard) approval model. Five different round-trips for one feature.
> - Agent SDK *can* reuse the local `~/.claude` subscription session (no API key)
>   and shares the same monthly Agent-SDK credit `claude -p` already spends, so
>   billing/auth isn't the blocker — the multi-CLI fragmentation is.
> - **Remote Control** is a first-party Anthropic bridge to *their* web/mobile
>   clients (outbound HTTPS to Anthropic's API); not embeddable by a third-party
>   app, and Claude-only. Not a fit.
> Revisit if/when a cross-CLI approval story exists, or accept Claude-only via
> the Agent SDK as a deliberate exception.

**H2 — Live Activities / Dynamic Island for the running turn.**
Cursor + Copilot put agent status on the lock screen / Dynamic Island. Diktat
has fire-on-finish push only. Add a Live Activity: session label + elapsed +
current tool + files/±lines, ending with pass/fail. Native lift, not OTA.
Biggest perceived-polish gap. (github.blog changelog 2026-02-26;
cursor.com/blog/ios-mobile-app)

> **DEFERRED to a device session (assessed 2026-07-08).** The drop-in module
> `software-mansion-labs/expo-live-activity` is **deprecated** (SM *labs* org).
> Remaining path is hand-rolled: `@bacons/apple-targets` config plugin → a
> SwiftUI Widget Extension (lock-screen + Dynamic Island) + a small local Expo
> native module bridging ActivityKit start/update/end to JS, driven from the
> turn lifecycle (reuse the H3 progress data). Entitlement `NSSupportsLiveActivities`,
> iOS 16.2+. **Not verifiable without a physical device + dev-client build loop**
> (not Expo Go, not OTA) — do it hands-on at a Mac, not blind. Push-to-update
> optional (needs APNs Live Activity token plumbing on the relay).

**H3 — Make the active turn legible ("working now" header).**
Today a run is a flat vertical stream + typing indicator. Add a sticky header
during streaming: current tool + live spinner + elapsed timer + running tally
(files/cmds) that becomes the last-run card on completion. Stats already computed
at run-end — surface them live.

**H4 — Structured diff rendering.**
Diffs are plain +/−/@@ colored lines in a nested scroll view. Group by file with
a collapsible header (path + `+N/−M`), gutter line numbers, full-width green/red
line backgrounds, word-level inline highlighting, leading whitespace as middle-dots.

**H5 — Message list: ScrollView → FlashList/FlatList.**
Chat renders all messages in a plain ScrollView (FlatList was dropped due to a
new-arch crash). Long sessions will jank. Move to FlashList; bubbles are already
memoized.

## Medium

- **M1 — react-navigation.** App.tsx is a hand-rolled useState screen switch
  (machines|sessions|chat|debug), no tab bar, no transitions, fragile deep links.
  Adopt native stack + bottom tabs → gestures, animations, reliable deep links,
  room for concurrent sessions.
- **M2 — Concurrent session switching.** Diktat resumes one at a time and resets
  chat state on session change. Add a switcher + "running now" badge on the list.
- **M3 — Voice discoverability.** Dictation is well-built but the mic only shows
  on empty draft, no first-run coaching. Add a one-time coach-mark, bigger live
  transcript, hold-to-talk hint (micMode already supports it).
- **M4 — Richer session rows.** Add per-session state dot (running/waiting/done)
  and "needs input" sort-to-top.
- **M5 — Distinct error states.** Separate cards for relay-unreachable,
  daemon-offline-mid-session, auth-expired (today reconnecting banner pulses
  indefinitely). Give "no agents detected" the numbered-step treatment.

## Low
- L1 light mode / theme choice / AMOLED black; audit contrast.
- L2 shared-element Sessions→Chat transition (needs M1); ease the scroll-to-end.
- L3 stronger typography hierarchy between assistant prose and tool/diff mono.
- L4 persist a re-openable run-summary (maps to a future diff-review sheet).

## Strategic feature gaps (who has each)
- **E2E encryption** — Happy markets zero-knowledge (relay sees only ciphertext).
  Diktat is wss-in-transit via the relay (relay *could* read frames). Most
  important strategic gap; don't let App Store copy imply zero-knowledge.
- **Android + web client** — Happy has both; Diktat iOS-only.
- **Cloud agents** (Cursor/Copilot run without your Mac) — deliberate positioning
  difference, NOT a gap to close (Diktat = your machine, your logins).
- Session handoff/teleport (Happy, Claude /teleport, Cursor local↔cloud).

## What Diktat already does as well or better — don't redo
- Voice review card (record → waveform → editable transcript → send; no-remount
  edit focus) is nicer than plain dictation.
- Pairing onboarding (numbered steps + copyable install, demo path, offline sheet
  telling you `diktat start` vs `diktat pair`).
- Cohesive "violet terminal" art direction; Space Grotesk + Outfit; mono stats.
- Motion + haptics craft (breathing caret, waveform, springs, rotating carets,
  success haptic, full reduced-motion support).
- Composer ergonomics (slash rail, per-turn model/permission pills, draft persist,
  input history, tool-path injection, smart scroll-to-bottom).
- Last-run stats card + usage strip (quantified files/±lines/cmds/duration/tests).

Bottom line: Diktat's typography, motion, voice-review and pairing are
competitive-or-better. The wins are the live run (H1–H4) + the enabling refactors
(H5 list, M1 nav). E2E + Android/web are the strategic feature gaps vs Happy.
