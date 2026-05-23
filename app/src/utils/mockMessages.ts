import type { DiktatMessage } from "../hooks/useDiktat";

// Real messages extracted from a Cursor chat session (Pacer project, OutboundSyncRouter work).
// Used to test ChatScreen rendering without a live daemon connection.
export const MOCK_MESSAGES: DiktatMessage[] = [
  {
    role: "assistant",
    text: "Extracting testable avatar-upload orchestration from `OnlineStorage`, then adding focused tests with spies instead of real Supabase.",
  },
  {
    role: "assistant",
    text: "Implemented the **OnlineStorage avatar slice** with a small extraction so it's testable without Supabase.\n\n### Production: `AvatarURLOutboundSync.swift`\nExtracted orchestration from `OnlineStorage.syncAvatarURL`:\n\n1. Verify `user_profile` row exists  \n2. Resolve auth user id → `{userId}.jpg` path  \n3. Read JPEG from Documents  \n4. Call **`uploadProfilePicture`** port  \n5. Call **`upsertAvatarURLRow`** port  \n\n`OnlineStorage.syncAvatarURL` now wires real Supabase storage + `avatar_urls` upsert into those ports.\n\n### Tests: `OnlineStorageAvatarSyncTests.swift`\n\n| Test | Proves |\n|------|--------|\n| `syncLocalAvatarFileToRemote_throwsWhenProfileRowMissing` | Missing profile → `SyncRoutingError.rowNotFound` |\n| `syncLocalAvatarFileToRemote_uploadsDocumentsJPEGAndUpsertsAvatarURLRow` | Reads disk JPEG, calls upload + upsert with correct `(data, fileName)` and `(userId, fileName)` |\n\nUses **spies only** — no network, no `.live` OnlineStorage.\n\n### Chain status\n\n```\n… → OutboundSyncRouter → onlineStorage.syncAvatarURL\n                              ↓\n                    AvatarURLOutboundSync (upload + upsert ports)  ← new\n```",
  },
  {
    role: "user",
    text: "Are there any other candidates for the refactor",
  },
  {
    role: "assistant",
    text: "Scanning sync and OnlineStorage paths for the same extract-and-test pattern we used for avatar upload.",
  },
  {
    role: "assistant",
    text: "Here are the best **refactor + independent test** candidates, ordered by payoff for the sync chain you've been building.\n\n---\n\n## Tier 1 — Do next (same pattern as `AvatarURLOutboundSync`)\n\n### 1. `deleteRemoteAvatarURLForCurrentUser` (+ router delete path)\n**Symmetry with what you just shipped.**\n\nToday: Supabase row delete + storage remove inline in `OnlineStorage`.\n\nExtract: `AvatarURLOutboundDelete` with ports:\n- `authUserId`\n- `deleteAvatarURLRow(userId)`\n- `removeStorageObject(path)`\n\nTest independently; `OutboundSyncRouter` delete test already partially covers settlement — storage delete would be its own spy test.\n\n---\n\n### 2. `PendingSyncQueue.mergeInboundDeltas(with:)`\n**Highest-value refactor that isn't OnlineStorage at all.**\n\nThis is mostly **pure logic**:\n\n```\nlocals + remote deltas → (loser sync_entity ids, inbound deltas to persist)\n```\n\nExtract to something like `InboundDeltaMerge.decide(locals:remote:)` with no DB, no Supabase. Then:\n\n- Unit test every branch (remote newer, no local, tie-break on `updatedAt`) **without polling**\n- Keep one thin DB test that losers get flipped to `.inbound(.update)`",
  },
  {
    role: "user",
    text: "Ok let's do inbound tests",
  },
  {
    role: "assistant",
    text: "Implementing inbound sync tests: extracting testable orchestration and adding focused test coverage.",
  },
  {
    role: "assistant",
    text: "Implemented the **inbound test slice** — three extractions + focused tests, same pattern as outbound avatar.\n\n### Extractions\n\n| Type | File | Wired from |\n|------|------|------------|\n| Avatar inbound | `AvatarURLInboundApply.swift` | `InboundSyncRouter.applyAvatarURL` |\n| Profile inbound | `ProfileInboundApply.swift` | `InboundSyncRouter.applyProfile` |\n| Delta merge (pure) | `InboundDeltaMerge.swift` | `PendingSyncQueue.mergeInboundDeltas` |\n\nEach uses **injected ports** (download, write, reconcile / persist, settle / merge logic) — no Supabase in the test layer.\n\n### Tests\n\n| Suite | What it proves |\n|-------|----------------|\n| **`InboundDeltaMergeTests`** | Remote newer → loser IDs; stale remote → no flip; remote-only → inbound; dedupe by `updatedAt` |\n| **`InboundAvatarURLApplyTests`** | Download → disk → reconcile spies; virtual `sync_entity` row after reconcile; missing profile throws |\n| **`ProfileInboundApplyTests`** | Merge + persist + settle spies; `mergingInboundRemote` field rules; missing profile throws |",
  },
  {
    role: "user",
    text: "How much of outbound is actually complete (not tests the real syncing)",
  },
  {
    role: "assistant",
    text: "Tracing the outbound sync pipeline in production code to assess what's implemented vs. stubbed.",
  },
  {
    role: "assistant",
    text: "Here's an honest **production outbound** assessment — what actually pushes to Supabase vs what's only wired in tests or half-finished.\n\n---\n\n## The outbound pipeline (what \"complete\" means)\n\n```\nLocal edit → DB trigger → sync_entity row → PendingSyncQueue → OutboundSyncRouter → OnlineStorage → Supabase → settleOutboundDelta\n```\n\n**\"Complete\"** here = local change can reach Supabase **and** `sync_entity` gets a stable `remote_id`. Tests proving ports/spies don't count.\n\n---\n\n## By entity (production code)\n\n| Entity | Enqueue | Router | Supabase push | `settleOutboundDelta` | Verdict |\n|--------|---------|--------|--------------|------------------------|---------|\n| **Activities** (insert/update) | ✅ DB triggers | ✅ | ✅ `upsertActivity` | ✅ returns server UUID | **Mostly complete** |\n| **Activities** (delete) | ✅ trigger | ✅ | ✅ `deleteRemoteActivity` | ✅ if prior `remote_id` | **Complete when previously synced** |\n| **user_profile** | ✅ triggers | ✅ | ✅ `upsertProfileForSync` | ✅ uses auth user id | **Complete** |\n| **avatar_urls** (virtual) | ✅ `saveAvatar` | ✅ | ✅ `syncAvatarURL` | ❌ **never on insert/update** | **Partial** |\n| **avatar_urls** (delete) | ❌ no outbound delete path | ✅ | ✅ delete | — | **Incomplete** |",
  },
  {
    role: "user",
    text: "For avatar we just need to set the sync entity row to synced after the upsert",
  },
  {
    role: "assistant",
    text: "Adding outbound avatar settlement after upsert. Checking how `syncAvatarURL` works and what ID we should use for settlement.",
  },
  {
    role: "assistant",
    text: "Adding `settleOutboundDelta` after avatar upsert in `OutboundSyncRouter`, matching the profile outbound pattern.",
  },
  {
    role: "assistant",
    text: "Updating router tests to stub `syncClient` and `authenticatedUserId` now that avatar upsert settles.",
  },
  {
    role: "assistant",
    text: "Done. After a successful avatar upsert, `OutboundSyncRouter.handleAvatar` now calls `settleOutboundDelta` with the auth user id (same pattern as profile outbound):\n\n```swift\nlet userId = try await onlineStorage.authenticatedUserId()\ntry await syncClient.settleOutboundDelta(\n  userId,\n  AvatarSyncMetadata.syncTableName,\n  task.localRowId,\n  .synced\n)\n```\n\nThat sets the virtual `sync_entity` row to `.synced` and writes `remote_id` via the normal settlement path — so the queue isn't the only thing marking it done.\n\nUpdated `AppOutboundSyncTests` so avatar router tests stub `syncClient` / `authenticatedUserId` for the new settle call.\n\n**Note:** `remote_id` is the **auth user UUID**, not the Supabase `avatar_urls.id`. If inbound deltas key off the avatar row's primary key, you may want a follow-up to settle with the id returned from the upsert `.select(\"id\")` instead. For \"mark synced after push,\" this should be enough.",
  },
  {
    role: "user",
    text: "test",
  },
  {
    role: "assistant",
    text: "**PacerPackage (SPM):** ✅ **38/38 passed** (~3s)\n\n```bash\nswift test --package-path PacerPackage\n```\n\n**WhatsMyPace (app):** ❌ **Could not run** — no iOS Simulator runtime available (`iOS 26.5 is not installed` in Xcode → Settings → Components). `iPhone 17` simulator isn't usable until that's fixed.\n\nOnce the simulator is installed, run app tests with:\n\n```bash\nxcodebuild test -project WhatsMyPace.xcodeproj -scheme WhatsMyPace \\\n  -destination 'platform=iOS Simulator,name=iPhone 17' \\\n  -only-testing:WhatsMyPaceTests\n```",
  },
  {
    role: "user",
    text: "test",
  },
  {
    role: "assistant",
    text: "**PacerPackage:** ✅ **38/38 passed**\n\n**WhatsMyPace app tests:** ❌ **Still blocked** — Xcode needs **iOS 26.5** platform (Settings → Components). Simulators are listed in `simctl`, but `xcodebuild` can't use them until that runtime is installed.\n\nFix that in Xcode, then:\n\n```bash\nxcodebuild test -project WhatsMyPace.xcodeproj -scheme WhatsMyPace \\\n  -destination 'platform=iOS Simulator,name=iPhone 17' \\\n  -only-testing:WhatsMyPaceTests\n```",
  },
];
