# G1 Runtime Refactor — Resume Checkpoint

**Saved:** 2026-08-17
**Repository:** `msabz/G1`
**Work branch:** `fix/unified-connection-runtime`
**Draft PR:** #2 — `Unify connection runtime and harden transfers`
**PR base:** `feat/zero-config-lan-discovery`
**PR base SHA:** `b8ef78bfd5c3aec1ebf764de2fa0b60e04f4a6f0`
**Head before this checkpoint commit:** `7f58fed334288a799ec5034055a13f4c0d0c882f`

> This file is the canonical engineering memory for resuming the work after GitHub Actions free minutes reset. Read this file and PR #2 before changing code.

## User constraints / working agreement

- Do **not** merge this branch into the stable/base branch before CI is green and physical-device testing is complete.
- Do **not** use the user's phone for local Gradle/Android builds; the phone is for final field testing only.
- Do **not** require paid GitHub usage. The user explicitly does not want to pay for Actions.
- Continue using GitHub as the durable source of truth for code, checkpoints, PR history, tests, and decisions.
- When Actions quota returns, resume from this checkpoint instead of starting a new refactor.
- Prefer official Android/React Native documentation and mature open-source implementations when solving lifecycle, notification, networking, and transfer issues.
- Keep one known-good baseline and make risky changes incrementally.

## Why work paused

GitHub Actions did not fail because of application code. GitHub blocked jobs before they started because the account exhausted the included free Actions quota.

GitHub Billing UI on 2026-08-17 showed:

- GitHub Free
- Actions minutes: **2,000 used / 2,000 included**
- Actions storage: about **0.4 GB / 0.5 GB included**
- Billable usage: **$0** after included-usage discount
- UI showed included usage limits resetting in about **15 days**
- Actions budget is `$0` with `Stop usage = Yes`
- No payment method is configured

A blocked workflow annotation reported that the job was not started because billing/spending limits prevented Actions from running. This is an infrastructure/billing gate, not a code-test result.

Expected resume time: around the next included-usage reset shown by GitHub (roughly early September 2026). Verify quota before resuming.

## Last fully CI-validated baseline

The last clearly validated batch before the quota problem reached all major CI stages successfully:

- JavaScript unit tests: passed
- React Native production bundle: passed
- Android unit tests: passed
- Debug APK: built successfully
- Release APK: built successfully
- Debug/release artifacts uploaded

The corresponding checkpoint was around commit `8361b88c40d62733f6f17dac315d280326329085` after the signaling, AUTO timeout, transfer-performance, and installer changes. Treat this as the last known fully green baseline unless GitHub history shows a later completed green run.

Important: commits after that baseline include meaningful runtime/database/native-call changes that were **not fully validated by CI** because Actions quota was exhausted. Do not assume the current head is green.

## Implemented and previously validated work

### 1. File transfer routing hardening

`src/media/FileShare.js` was changed so file sending prefers the live signaling session address instead of trusting a cached Wi‑Fi Direct IP such as `192.168.49.1`.

Regression coverage includes:

- live `::ffff:x.x.x.x` address beats stale cached P2P address
- sending can work with no cached `peerIp` when a live signaling route exists
- route normalization for IPv4-mapped IPv6 / bracketed IPv6

This prevents stale transport addresses from routing port 8090 traffic to the wrong interface after transport changes.

### 2. Signaling endpoint/session safety

`src/webrtc/signaling.js` gained endpoint normalization and safer session ownership checks so a connection to peer A is not silently reused for a request to peer B.

Internal `ping/pong` heartbeat frames are handled inside signaling and no longer leak into the application message callback.

Signaling already owns heartbeat/recovery logic:

- heartbeat interval around 6 s
- timeout around 18 s
- transient recovery grace around 4 s

The App-level duplicate heartbeat was later removed by the guarded App refactor.

### 3. AUTO fallback deadlines

`TransportFallbackEngine` was hardened so LAN/P2P attempts cannot hang forever. Timeout/cancellation behavior was added/tested so AUTO can advance to the next transport instead of being trapped by one unresponsive layer.

Long-term target remains a single orchestrator with priority roughly:

1. LAN
2. Wi‑Fi Direct
3. Bluetooth

without any transport depending on another transport's state.

### 4. Port 8090 transfer performance work

Native file transfer hot path was optimized while preserving integrity checks.

Intent of the batch:

- larger native buffer (target around 256 KB instead of 64 KB)
- fewer progress events crossing the RN bridge
- no repeated flush on every progress boundary
- final flush/ACK semantics retained
- SHA-256 verification retained
- transfer cancellation moved toward per-transfer identity instead of one global boolean
- socket buffers increased where appropriate

This batch reached Android unit tests / APK build successfully before later runtime changes.

Still pending for transfers:

- session-bound transfer token for port 8090
- transfer idempotency / duplicate protection when final ACK is lost
- full concurrent-transfer semantics
- physical throughput measurement on Samsung ↔ Motorola

### 5. APK installer UX

Single `.apk` install flow was changed toward the normal Android installer UX instead of hiding the user behind long PackageInstaller staging.

Design:

- single APK → hand to Android's installer UI directly with a safe URI
- `.apks` / split packages → keep PackageInstaller session because multiple split APKs must be committed together
- user confirmation remains explicit

Android manifest camera requirement was later changed from hard-required to optional because G1 can still provide chat/audio/files without a camera.

## Guarded App/runtime refactor already applied

A guarded codemod was used to avoid hand-editing the very large `src/App.js`. The codemod used exact-string assertions and failed safely if expected snippets did not match.

Generated commit:

`f67237e6f92d91b2606f1158280c9c22e4dd7048` — `refactor: separate UI lifecycle from connection runtime`

Key changes in that commit:

- React root now tracks UI attach/detach via `BackgroundRuntime`.
- `App` unmount no longer calls `cleanupAll()` automatically.
- Removing the Activity/UI from Recents is no longer treated as an explicit user disconnect.
- explicit disconnect flows still call the full cleanup path.
- duplicate App-level signaling heartbeat was removed.
- `ringStateRef` was introduced to avoid stale closure behavior in long-lived message listeners/timeouts.
- LAN connect now requires the durable device identity instead of inventing a random temporary device id.
- LAN connection failures rethrow so callers can actually continue fallback.
- `sendAsset()` no longer blocks only because `peerIpRef` is empty; FileShare can resolve the live signaling route.
- outgoing chat now records `failed` when `sendSignalingMessage()` returns false instead of always claiming `sent`.
- signaling got observer APIs so non-UI runtime layers can subscribe without stealing the existing App callback.

This refactor itself must be revalidated when Actions returns.

## Background runtime work at current head

New file: `src/services/BackgroundRuntime.js`

Purpose: separate persistent event consumption from React screen ownership.

Behavior implemented:

- remembers current peer identity
- when UI is attached, avoids duplicate persistence/notifications
- when UI is detached, persists incoming chat to SQLite and raises message notifications
- queues incoming chat that arrives before peer identity and flushes it once identity arrives
- tracks incoming transfer metadata and persists completed incoming files/images/voice messages when UI listeners are gone
- keeps pending incoming-call metadata for the call-notification layer
- subscribes through signaling observer APIs

Tests were added in `__tests__/backgroundRuntime.test.js` for:

- no duplicate persistence with UI attached
- background chat persistence + notification
- queue-until-identity behavior
- completed incoming file persistence in background
- pending incoming-call metadata

These tests exist in the branch, but the latest runtime/native changes did not get a successful complete CI pass because quota was exhausted.

## Database migration / persistence work

Native SQLite storage was moved toward schema v3.

Important design decision: **never drop the user's message/contact tables during a normal schema upgrade.**

The previous `StorageModule.kt` upgrade strategy dropped `messages` and `peers`, which could erase conversation history on an app update. The new migration work is intended to preserve data and add fields/tables incrementally.

New persistence foundation includes support for:

- stable message ids
- message status/edit/delete/reply metadata foundation
- dedicated `call_records` table / call history foundation
- JS persistence wrappers for future message/call features

A source-level regression guard was added to fail if destructive `DROP TABLE` migration behavior is reintroduced.

This database work is **not yet field-tested on an existing user database**. After CI is restored, add/execute an Android instrumentation or migration test if possible before shipping.

## Native incoming-call notification work

Native call-notification infrastructure was added after reviewing current Android behavior.

Direction:

- use Android `NotificationCompat.CallStyle` where supported
- Answer / Reject actions are tied to a stable `callId`
- receiver is not exported
- full-screen intent is treated as optional capability, especially on Android 14+; notification must remain useful even when full-screen access is denied
- Answer may open the Activity because the user explicitly interacted with the notification
- Reject should be able to act without forcing the UI open
- if React context is not ready, action state should not simply disappear

Native call module / receiver files were added and `ServicePackage`/manifest were updated.

Manifest work also added/adjusted full-screen-intent support and made camera hardware optional.

This Kotlin/native-call batch is **NOT compile-validated yet** because Actions quota blocked jobs before they started. This is the first area to validate when CI resumes.

## CallRuntime work

New file: `src/services/CallRuntime.js`

Goal: one call identity and one persistent call record across:

- `call-request`
- incoming notification
- ringtone
- Answer / Reject action
- `call-ringing`
- `call-accept`
- `call-reject`
- `call-busy`
- `call-missed`
- `call-cancel`
- `call-end`
- final CallRecord

`BackgroundRuntime` was updated at commit:

`7f58fed334288a799ec5034055a13f4c0d0c882f` — `feat: connect background signaling to persistent call runtime`

Current head before this checkpoint was that commit.

The major remaining call task is to connect the existing `src/App.js` call controller completely to CallRuntime so native notification Answer/Reject actions drive the same live call state machine rather than a parallel/partial path.

Do not ship native CallStyle until this integration is complete and tested.

## Important architectural findings that still matter

### Two connection ownership systems still exist

Historically G1 has both:

- direct signaling/reconnect/state ownership in `App.js`
- `ConnectionCoordinator` / `SignalingSession` / `TransportFallbackEngine`

This creates multiple sources of truth.

Long-term direction: one connection/session owner. Do not add a third abstraction.

### Duplicate reconnect ownership

Signaling has internal recovery while App also contains `attemptReconnect()` and Wi‑Fi Direct recovery logic. Heartbeat duplication was reduced, but reconnect ownership still needs simplification.

### Background service is not yet the full network owner

`ConnectionService.kt` is primarily a foreground service/notification/lock holder. It does not yet independently own all TCP listener/parser/peer/call state.

The current lifecycle refactor improves survival when React UI detaches, but true process-death resilience still requires a more durable native/network owner.

### Wi‑Fi Direct lifecycle remains tightly coupled to App

Discovery, invitation handling, bind/unbind, group cleanup, and many state transitions live inside monolithic `App.js`.

Refactor gradually. Do not rewrite the entire App in one change.

### Call state stale-closure risk

`ringStateRef` was added for key paths, but review all long-lived callbacks/timeouts for stale React state before declaring call state stable.

### Chat delivery semantics are incomplete

Current chat protocol still lacks a full message ACK state machine (`queued → sending → delivered → failed`) with stable message ids across both peers.

The DB v3 groundwork is intended to support this later.

### Port 8090 security is incomplete

Current SHA-256 protects integrity, not authorization. A host on the reachable network should not be able to inject arbitrary transfer sessions.

Preferred next security step:

- negotiate a cryptographically random per-transfer/session token over the signaling channel
- include/verify that token in the native transfer header
- do not pretend `SecureHandshake` currently provides cryptographic authentication; it mostly validates app/protocol/device/timestamp metadata

Pairing keys / authenticated identity can be a separate security project later.

### ACK/idempotency risk

If receiver commits a file and the final completion ACK is lost, sender may report failure while receiver already has the file. Add transferId-based completed-transfer cache/idempotency before calling file semantics production-grade.

### Storage migration risk

Always test upgrade from a real older DB. Never restore destructive drop/recreate logic for normal upgrades.

## CI efficiency problem to fix after quota reset

The current workflow consumed the entire 2,000-minute free monthly quota. G1 alone accounted for a meaningful portion of metered usage, and repeated small commits triggered full Android debug + release builds.

After CI becomes available, redesign `.github/workflows/build.yml` to conserve free minutes.

Recommended structure:

1. Fast validation job on normal pushes/PR changes:
   - `npm ci`
   - relevant JS/Jest tests
   - RN production bundle / syntax validation when needed

2. Android compile/unit stage only when Android/native/runtime paths changed.

3. Full Debug + Release APK build only:
   - manually (`workflow_dispatch`), or
   - on a specifically labeled PR / release branch / milestone commit

4. Avoid building both debug and release for every tiny documentation/test-only commit.

5. Add path filters and concurrency cancellation so superseded runs are canceled.

6. Keep artifacts only when needed and use shorter retention to reduce storage pressure.

Do this early after quota reset so another month is not burned by development commits.

## Exact resume procedure

When GitHub Actions free minutes reset:

1. Open this file and PR #2.
2. Verify branch is still `fix/unified-connection-runtime` and note current head.
3. Verify GitHub Actions quota is available before pushing more code.
4. **Do not add new features yet.** First run CI against the current branch head.
5. If CI fails:
   - determine whether failure is JS, RN bundle, Kotlin compile, Android test, debug build, or release build
   - fix the existing current-head failures only
   - keep commits small and layer-specific
6. Pay special attention to the unvalidated native-call/manifest/DB work.
7. Once current head is green, optimize the CI workflow to conserve minutes.
8. Then finish CallRuntime ↔ App call-state integration and add tests.
9. Then validate removed-from-Recents behavior and incoming-call notification behavior on physical Samsung + Motorola.
10. Then measure 8090 transfer throughput and integrity on both directions.
11. Only after field tests pass should PR #2 be considered for merge.

## Required physical-device test matrix after a green APK exists

Use the same APK build on both phones.

### Connection/lifecycle

- Samsung → Motorola LAN connect
- Motorola → Samsung LAN connect
- Wi‑Fi Direct fallback when LAN unavailable
- simultaneous/near-simultaneous connect attempt
- disconnect then reconnect without stale P2P group
- remove receiving app from Recents while connection is active
- send chat from other phone after UI removal
- send file after UI removal
- restore UI and confirm persisted history is consistent

### Calls

- incoming voice call foreground
- incoming video call foreground
- incoming call while app backgrounded
- incoming call after app removed from Recents while service/runtime remains alive
- Answer from notification
- Reject from notification
- caller cancel before answer
- busy handling
- timeout/missed call
- call-end from either side
- verify one correct CallRecord per callId and no duplicates
- verify microphone never opens before explicit acceptance

### Files

- small image
- medium file
- large file
- application APK
- split `.apks`
- simultaneous transfer attempts / cancellation
- sender/receiver SHA-256 and completion semantics
- compare throughput before/after 8090 tuning
- ensure no stale `192.168.49.x` route is used when live session is on LAN

## Current branch commits worth knowing

Selected checkpoints from this work:

- `dd8a86b792dc489d5b46aedfcea6279fee1a9a07` — live-session file routing
- `62792ff34fd28498a2a977519ad298129534b999` — file-routing regression tests / early PR head
- `b68eeff...` — signaling target/session safety + control-frame handling
- `a82e2cc...` — port 8090 performance batch
- `8e5d5b0...` — AUTO transport timeout/fallback batch
- `b122e69...` — APK installer UX batch
- `8361b88c40d62733f6f17dac315d280326329085` — test fix; last known fully green area before later runtime changes
- `f67237e6f92d91b2606f1158280c9c22e4dd7048` — guarded App lifecycle/runtime refactor
- `a618b919bdcbdedaf7e8dc912d3ab22975002494` — BackgroundRuntime tests
- `e9d136112e94543ef25aa13dc807226e7be7b66c` — non-destructive DB v3 migration work
- `e133852f6821be64edb25f4e1c890e52803386bf` — JS persistence wrappers
- `314e39eb3278e4fb03fd83407b7a01e75307b79c` — migration regression guard
- `9c7b38c4ba6d2ca00239958c973237b578fa2dde` / `653bf36d8fa0a02dee5ab7ded553e8ce683f391b` — native incoming-call module/receiver work
- `283194fd2a956f42f6cdbd9787a99d67afcb5101` — service package/native wiring
- `ea872c710692740dbb4a70a20d51408695d7786b` — manifest/call notification support + camera optionality
- `208737883f9061d83b202129af09745be840e16d` — CallRuntime foundation
- `7f58fed334288a799ec5034055a13f4c0d0c882f` — connect background signaling to persistent call runtime

Abbreviated SHAs above should be resolved from Git history if needed.

## Files to inspect first on resume

- `src/App.js`
- `src/webrtc/signaling.js`
- `src/services/BackgroundRuntime.js`
- `src/services/CallRuntime.js`
- `src/services/Persistence.js`
- `src/network/ConnectionCoordinator.js`
- `src/network/TransportFallbackEngine.js`
- `src/network/SignalingSession.js`
- `src/media/FileShare.js`
- `android/app/src/main/java/com/m200/filesharing/FileTransferModule.kt`
- `android/app/src/main/java/com/m200/service/ConnectionService.kt`
- `android/app/src/main/java/com/m200/service/ServiceModule.kt`
- `android/app/src/main/java/com/m200/service/StorageModule.kt`
- native incoming-call module/receiver files added in this branch
- `android/app/src/main/AndroidManifest.xml`
- `.github/workflows/build.yml`
- `__tests__/backgroundRuntime.test.js`
- transfer/signaling/fallback regression tests

## Definition of done for this phase

This runtime-hardening phase is not done merely because code compiles.

It is done only when:

- one authoritative session/connection path is clear
- fallback does not hang
- background UI removal does not silently make the peer offline
- incoming call notification actions drive the actual call state
- no microphone opens before user acceptance
- call history is durable and deduplicated by callId
- file transfers route over the live session, retain SHA-256 integrity, and handle cancellation correctly
- database upgrades preserve existing history
- CI is green
- Samsung/Motorola field tests pass

Until then keep PR #2 as Draft and do not merge to the stable branch.
