# G1 Development Checkpoint — Live LAN Coordinator Phase 5

Date: 2026-08-18

This file is the durable continuation point for the current G1 engineering session. It is intentionally detailed enough that a new ChatGPT/Codex session can resume by inspecting this file, PR #7, the current branch head, and GitHub Actions rather than relying on chat history.

## Source of truth order

1. Current code/tests on `main` and the active Phase 5 branch.
2. Current GitHub Actions/CI for the exact head SHA.
3. Real-device evidence.
4. This checkpoint / PR #7 body.
5. Older architecture/runbook/handoff documents.
6. Historical chat assumptions.

Never claim device verification from CI. Never claim a CI checkpoint green until the exact head SHA has passed the full workflow including Debug APK, Release APK and both artifact uploads.

## Repository / ownership state

- Repository: `msabz/-G1-public`
- Base branch: `main`
- Current verified main baseline before Phase 5: `fb992f83abcf951c8ac70789a765e79623a08d83`
- Active branch: `agent/live-lan-coordinator-phase5`
- Active PR: #7 `refactor: move live LAN ownership into coordinator`
- Phase 5 is intentionally limited to known-peer LAN ownership migration first. Do not move live Wi-Fi Direct in the same change.

## Fully CI-verified Phase 5 checkpoints

### Checkpoint A — transport-specific cleanup policy

Commit: `9b6afbafd1e8d7c79c1432bc3d5594f275ebd607`

Changes:
- Added `src/network/sessionCleanupPolicy.js`.
- Added `__tests__/sessionCleanupPolicy.test.js`.
- Policy: only `TRANSPORTS.P2P` requires Wi-Fi-Direct-specific cleanup; LAN, Bluetooth and unknown/null transports do not.
- No App/runtime call path was changed at this checkpoint.

Validation:
- GitHub Actions run #57 (`32095348404`) fully green.
- JavaScript unit tests: success.
- React Native production bundle: success.
- Android unit tests: success.
- Debug APK: success.
- Release APK: success.
- Debug artifact upload: success.
- Release artifact upload: success.

### Checkpoint B — idempotent signaling-owner rebinding

Commits:
- `ff6014a83957a1bf087ff99ec0caf2ea6167a824`
- `a1ac0226fff2a91c357f267c9e163b3c5cd816f4`
- `dd7e405875e912462805be6dcacfadc228c5d272`

Changes:
- `ConnectionCoordinator.setSignalingOwner(owner)` now returns immediately when the exact same owner object is passed again.
- Replacement with a different owner remains forbidden while `CONNECTING` or `CONNECTED`.
- Existing ownership test now proves same-owner rebinding is safe while connecting and connected, while different-owner replacement still throws.
- Trailing newline was restored to keep the test diff clean.

Validation:
- GitHub Actions run #63 (`32095873354`) fully green across the same full workflow gates.

### Checkpoint C — live signaling owner bound at JS bootstrap

Commit: `5185fdb269acecbe472df3ecc6559c906e2434a7`

Changes:
- `index.js` imports the global `connectionCoordinator` and live `signalingOwner`.
- `connectionCoordinator.setSignalingOwner(signalingOwner)` runs during JS module initialization, before React Native root registration.
- Added `__tests__/indexConnectionRuntimeBootstrap.test.js`.
- The bootstrap test mocks App/native-facing dependencies and proves the live owner is bound exactly once before `AppRegistry.registerComponent()`.

Validation:
- GitHub Actions run #65 (`32096252878`) fully green across JavaScript tests, RN bundle, Android unit tests, Debug/Release APK and both artifact uploads.

## Current architectural facts

- `src/webrtc/signaling.js` remains the live signaling/socket/heartbeat/transient-recovery owner.
- `ConnectionCoordinator` owns logical peer/transport state when used through the external signaling owner path.
- The bootstrap does not start a network connection by itself.
- `TransportFallbackEngine` stores a coordinator reference on construction and only connects on explicit `connect()`.
- Runtime use of `fallbackEngine` outside tests is currently diagnostics mode get/set, not an automatic hidden connection path.
- `App.js` is still the live orchestrator for LAN/P2P UI flow and most cleanup logic.
- Wi-Fi Direct live ownership has NOT been migrated in Phase 5 yet.

## External-source design evidence already checked

### Android

- `WifiP2pManager.removeGroup()` removes the current Wi-Fi Direct/P2P group. It is transport-specific and must not be used as generic LAN/session cleanup.
- `ConnectivityManager.bindProcessToNetwork(null)` clears process-level network binding. This is network-route state, not peer identity state.

### React Native

- G1 uses React Native `0.75.4` and React `18.3.1`.
- Runtime/module bootstrap must tolerate development reload/re-evaluation; therefore same-owner rebinding was made idempotent instead of coupling ownership to a React screen lifecycle.

### Mature OSS references

- KDE Connect keeps stable `Device` identity separate from one or more current `DeviceLink` paths. Losing one link is not equivalent to destroying the peer or another transport.
- LocalSend was reviewed for multi-channel discovery/address updates but is not copied blindly; its security/discovery model is not a direct G1 template.
- Briar was reviewed as a transport-abstraction reference where transport connection mechanics are separate from higher-level identity/security.

### I2P future constraint — research only, no implementation yet

- I2P Streaming provides reliable ordered socket-like streams and is conceptually compatible with a future signaling transport.
- I2P identity is based on `Destination`, not IP address.
- I2CP is the lower-level Java-facing protocol/API; SAM is a bridge alternative.
- Android/router lifecycle evidence implies future I2P runtime should not be tied to React screen lifetime.
- Do NOT decide SAM vs I2CP yet. First finish current P0 reliability/ownership work and reach device-test readiness.

## Confirmed live-LAN migration findings

### 1. Retry-policy mismatch must be preserved deliberately

Current `App.handleConnectLan()` calls:

`connectToSignalingServer(ip, port, 5, 800)`

Current `ConnectionCoordinator.connectLanPeer()` external owner path calls:

- `maxRetries: 3`
- `retryDelayMs: 600`

`connectOutboundSocket()` increments `attempt` starting from 1 and retries only while `attempt < maxRetries`. Therefore the parameter named `maxRetries` actually means total attempts, not retries-after-the-first-attempt.

Consequence: migrating live LAN directly to the coordinator today would silently change behavior from five total attempts / 800 ms delay to three total attempts / 600 ms delay.

Required fix before moving the live LAN call: make coordinator LAN connection policy explicitly configurable while retaining current 3/600 defaults for existing fallback callers; live App later passes 5/800.

### 2. Stable known-contact identity is already available

Signaling `identity` handling currently:
- sets `peerIdRef.current = msg.deviceId`;
- persists `savePeer(msg.deviceId, ...)`;
- stores the same value on the active peer;
- persists resolved addresses under that peer ID.

Therefore a saved/known contact's `contact.deviceId || contact.peerId` is an application-level stable device identity after handshake and may be used to look up/pass the `PeerRegistry` peer.

Manual IP connection remains provisional and must NOT invent a permanent peer identity from the IP.

### 3. Current LAN success leaves `activePeerRef` stale

`handleConnectLan()` currently calls `setActivePeer(peer)` directly.

`activePeerRef.current` is only written by `setActivePeerInfo()` and cleared by `resetActiveSessionUi()`.

Therefore LAN can display an active peer in React state while `activePeerRef.current` remains stale/null. The live LAN migration should use `setActivePeerInfo()` rather than preserve this bug.

### 4. Cleanup is currently Wi-Fi-Direct-centric

`cleanupAll()` mixes generic session cleanup with `DirectConnection.unbindNetwork()`.

`finishWifiDisconnect()` calls `cleanupAll()` and then `cleanupWifiDirect()`.

`disconnectAll()` always ends with `await finishWifiDisconnect()` after sending `disconnect-request` / waiting for ACK.

Incoming `disconnect-request` / legacy `hangup` also schedules `finishWifiDisconnect({ remote: true })` unconditionally.

Therefore both terminal disconnect and explicit disconnect can enter Wi-Fi-Direct cleanup even when the live session is LAN. This must be split before live LAN ownership is moved.

### 5. Signaling terminal-disconnect ordering is usable

On recovery exhaustion in `src/webrtc/signaling.js`:
1. disconnect observers are notified first;
2. the legacy `setOnDisconnect` callback is called afterward.

The live `signalingOwner` exposes the observer mechanism to `ConnectionCoordinator`.

Therefore the intended transitional ordering is valid:
- coordinator drops logical session/peer state first;
- App callback performs transport-aware UI/resource cleanup second.

Do not add a second heartbeat/recovery owner.

### 6. Incoming LAN is asymmetric/incomplete today

The persistent signaling listener can accept an inbound LAN socket and activate a signaling session.

When the inbound side later receives `identity`, App currently saves peer identity/history and updates display information, but does not promote App state to `CONNECTED`, does not explicitly mark the active transport, and does not automatically send reciprocal G1 identity as part of session activation.

`activateSession()` sends `my-ip`, not G1 identity.

Therefore incoming LAN promotion/identity is a separate required checkpoint. Do not hide it inside the outbound known-peer migration commit.

## Explicit active transport requirement

Do not use `activeTier` to distinguish LAN from Wi-Fi Direct: both are under the Wi-Fi tier.

Do not infer active transport from `lastConnectionRef`: that ref exists for Wi-Fi Direct reconnect details and is not a transport identity source.

The transitional App needs an explicit `activeTransportRef` using existing `TRANSPORTS` values:
- `TRANSPORTS.LAN`
- `TRANSPORTS.P2P`
- `TRANSPORTS.BLUETOOTH`
- clear/null when no active transport

Set it only on confirmed successful connection/promotion, not at attempt start.

Known locations already identified:
- LAN success: `handleConnectLan()` currently.
- P2P success: near `startConnectionService('متصل عبر واي فاي مباشر')` / `lastConnectionRef.current = { isOwner, ownerIP }`.
- Bluetooth success: `onBtConnected`.
- Bluetooth clear: `onBtDisconnected`.
- generic session reset/finish paths must clear it.

## Exact next implementation step at time of this checkpoint

The next change has NOT yet been committed.

Implement a backward-compatible configurable LAN connect policy in `ConnectionCoordinator` and test it before touching `App.js`.

Planned shape:

- Change `connectLanPeer(peer, timeoutMs = 8000)` to accept a third optional object such as `connectOptions = {}`.
- Read `maxRetries` and `retryDelayMs` from that object with existing defaults `3` and `600`.
- Pass the resolved values to the external `signalingOwner.connectOutbound(...)` path.
- Pass the same resolved values to the legacy `connectOutboundSocket(...)` path so behavior does not diverge based on owner wiring.
- Add/extend deterministic tests proving:
  1. defaults remain 3/600 for existing callers;
  2. an explicit policy such as 5/800 is forwarded exactly to the external owner;
  3. ideally the legacy path receives the same explicit values as well.

Do not change `App.js` in this retry-policy checkpoint.

After this checkpoint is full-CI green, proceed in this order:

1. Add explicit `activeTransportRef` and transport-aware cleanup seams, preferably minimizing full-file rewrites of the monolithic App.
2. Split generic logical/session cleanup from Wi-Fi-Direct-specific cleanup.
3. Make explicit `disconnect-request` handling finish the current transport rather than always calling `finishWifiDisconnect()`.
4. Move known-peer outbound LAN to `connectionCoordinator.connectLanPeer(peer, ..., { maxRetries: 5, retryDelayMs: 800 })`.
5. Use stable `deviceId || peerId`; do not manufacture `lan_<ip>` identity for known peers.
6. Update active peer using `setActivePeerInfo()` so state and ref stay consistent.
7. Keep manual-IP as provisional/developer flow until identity is established post-connect.
8. Keep live Wi-Fi Direct orchestration unchanged during this outbound LAN checkpoint.
9. Add a separate incoming-LAN promotion/reciprocal-identity checkpoint.
10. Then continue duplicate arbitration, make-before-break, broader P2P ownership migration, background runtime/calls/file/APK work, real-device validation, and only after G1 is cohesive/device-test-ready begin implementing I2P as an additional transport layer.

## Non-negotiable architecture reminders

- Discovery != Transport != Signaling Session.
- Peer Identity != IP Address.
- Control Plane != Data Plane.
- LAN / Wi-Fi Direct / future I2P are independent transport candidates.
- Any viable transport may bootstrap a signaling session.
- Make-before-break remains the goal.
- IP/socket/interface are ephemeral route attributes.
- Recovery must be explicit and bounded.
- File transfer must not own/close signaling.
- Duplicate inbound/outbound races must converge deterministically.
- Security and explicit consent over convenience.

## Resume procedure for a new chat/session

When resuming:

1. Read this checkpoint completely.
2. Fetch PR #7 and confirm its current head SHA.
3. Fetch `main` current SHA and verify whether it moved since the checkpoint.
4. Fetch workflow runs/jobs for the exact PR head and classify the latest full CI state.
5. Inspect the current diff against `main` before writing anything.
6. Resume from the `Exact next implementation step` above unless newer code/CI/PR evidence supersedes it.
7. If the active branch was merged, treat the merged `main` SHA + green CI as the new baseline and create the next phase branch from that exact SHA.
8. Do not rely on old chat text when repo/CI evidence disagrees.

This file is an engineering continuation record, not a claim that Phase 5 is complete or device-verified.