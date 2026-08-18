# G1 Development Checkpoint — Live LAN Phase 5 Seams Complete

Date: 2026-08-18
Repository: `msabz/-G1-public`
PR: #7 — `refactor: prepare live LAN coordinator migration`
Base `main` at start of this phase: `fb992f83abcf951c8ac70789a765e79623a08d83`
Verified seam code head before this documentation-only checkpoint: `56f5dde32ac0a98a408a0bcd4d9867d20b5e0b43`

## Status
Phase 5 preparation seams are complete and CI-verified. `src/App.js` has intentionally NOT been modified in this PR. The next phase must use these seams in a separate live-wiring branch so any behavior regression can be attributed to the App integration rather than to the ownership abstractions.

## Verified CI sequence
- Run #57 (`32095348404`) — transport-specific cleanup policy — fully green.
- Run #63 (`32095873354`) — idempotent signaling-owner rebinding — fully green.
- Run #65 (`32096252878`) — JS runtime bootstrap binding global coordinator to live signaling owner — fully green.
- Run #69 (`32096845932`) — configurable LAN retry policy — fully green.
- Run #71 (`32097238173`) — stable known-LAN target resolver — fully green.
- Run #73 (`32097801437`) — transport teardown/control-owner disconnect plan — fully green.
- Run #75 (`32098204508`) — transfer activity gate — fully green.

Each listed run passed JavaScript tests, RN production bundle, Android unit tests, Debug APK, Release APK and both artifact uploads.

## Seams now available
1. `sessionCleanupPolicy.js`: Wi-Fi-Direct-specific cleanup belongs only to `TRANSPORTS.P2P`.
2. `ConnectionCoordinator.setSignalingOwner()`: rebinding the exact same owner is idempotent; replacing an active owner remains forbidden.
3. `index.js`: global `connectionCoordinator` is bound to the live `signalingOwner` before React Native root registration.
4. `ConnectionCoordinator.connectLanPeer(peer, timeoutMs, connectOptions)`: explicit LAN attempt policy can preserve the historical live-App `5` total attempts / `800 ms` retry delay while existing callers retain `3/600` defaults.
5. `knownLanTarget.js`: stable peer identity is resolved independently from LAN host; manual IP-only connections remain provisional; identity mismatch between contact and registry is rejected.
6. `sessionDisconnectPlan.js`: transport teardown and signaling/control ownership are independent dimensions. Known LAN may be `LAN + COORDINATOR`, manual LAN is `LAN + LEGACY_APP`, current P2P is `P2P + LEGACY_APP`, and a future non-P2P transport such as I2P does not inherit Wi-Fi Direct teardown.
7. `transferActivityGate.js`: incoming/outgoing transfer IDs are tracked independently and terminal session teardown can be deferred until the data plane is idle without giving file transfer ownership of signaling.

## Confirmed App/runtime findings that drive the next phase
- Current known-contact LAN path still calls `connectToSignalingServer(host, port, 5, 800)` directly and invents `peerId: lan_<ip>`.
- Current LAN success calls `setActivePeer()` directly while `activePeerRef.current` is only synchronized by `setActivePeerInfo()`.
- Persisted `peerId` is the remote signaling `identity.deviceId`; it is therefore a stable G1 identity for saved contacts, not an IP/MAC route.
- `cleanupAll()` currently mixes logical-session cleanup with `DirectConnection.unbindNetwork()`.
- `cleanupWifiDirect()` also calls `unbindNetwork()`, so P2P cleanup currently duplicates that operation and LAN teardown can incorrectly enter P2P-native cleanup.
- `disconnectAll()` and incoming `disconnect-request` currently always finish through `finishWifiDisconnect()` regardless of transport.
- Signaling terminal loss notifies coordinator disconnect observers before the legacy App `setOnDisconnect` callback. This lets coordinator logical state converge first and App perform UI/resource cleanup second.
- Current App-level `attemptReconnect()` is P2P-specific. Terminal LAN loss must not enter it after signaling recovery is already exhausted.
- Current `activeTransfersRef` counts only outgoing `sendFileNative()` calls. Incoming native transfers emit stable IDs but are not counted. A one-shot terminal signaling callback can therefore be lost while a transfer is active, leaving App UI logically CONNECTED after coordinator has gone IDLE.
- Native file transfer is correctly a separate TCP 8090 data plane with transactional ACK/SHA-256 completion. `FT_INCOMING_START/DONE/ERROR` and outgoing DONE/ERROR carry transfer IDs suitable for the new gate.
- Incoming persistent-listener LAN is still asymmetric: receiving `identity` persists peer/history but does not promote App state to CONNECTED/active transport, and activation sends route information but not reciprocal G1 identity. Incoming LAN promotion remains a separate checkpoint after outbound known-LAN wiring.

## Exact next implementation step
After this checkpoint commit itself is CI-green and PR #7 is fast-forwarded into unchanged `main`, create a new branch dedicated to live App wiring, suggested name:

`agent/live-lan-app-wiring-phase5b`

On that branch, make one carefully reviewed `src/App.js` integration change using the full GitHub blob as source:
1. import `TRANSPORTS`, `resolveKnownLanTarget`, `CONTROL_PLANE_OWNERS`, `getSessionDisconnectPlan`, and `TransferActivityGate`;
2. track `activeTransportRef` independently from `activeControlOwnerRef`;
3. keep manual-IP LAN as a provisional legacy signaling path and remove fake stable identity `lan_<ip>`;
4. add a separate known-peer LAN handler using `connectionCoordinator.connectLanPeer(..., { maxRetries: 5, retryDelayMs: 800 })`;
5. set stable peer/history immediately from the selected known target because reciprocal incoming identity is not yet guaranteed;
6. use `setActivePeerInfo()` so React state and mutable peer ref stay synchronized;
7. on failed known-LAN attempt, reset coordinator to IDLE before P2P fallback;
8. split generic logical/session cleanup from Wi-Fi-Direct-native cleanup; never call `cleanupConnection()`/`unbindNetwork()` for LAN;
9. make explicit, remote and terminal disconnect choose behavior through the transport/control-owner plan;
10. retain the current App-level reconnect loop only for legacy P2P in this phase;
11. replace outgoing-only transfer counting with `TransferActivityGate`, tracking `out:<id>` and `in:<id>`, and release deferred terminal cleanup only after the final active transfer ends;
12. set/clear transport ownership explicitly on LAN, P2P and Bluetooth success/end paths;
13. keep Wi-Fi Direct connection ownership otherwise unchanged in this phase;
14. run JS tests, RN production bundle, Android units, Debug/Release APK and artifact validation before any device claim.

Then add a separate incoming-LAN promotion/reciprocal-identity checkpoint. Only after outbound+incoming LAN are CI-green should broader duplicate arbitration, make-before-break and P2P ownership migration proceed.

## External-reference conclusions retained
- Android Wi-Fi Direct group cleanup is transport-specific, not generic session cleanup.
- Mature designs such as KDE Connect keep stable device identity separate from current link/address.
- I2P remains a post-release-readiness goal. Its Destination-based endpoint model reinforces that future route abstractions must not assume IP host identity. No SAM-vs-I2CP implementation decision has been made.

## Progress tracking
Conversation progress metric toward “G1 complete before I2P” remains **39%** until this seam package is actually merged into `main`. It may move to 40% only after the verified checkpoint is fast-forwarded into `main`.

## Resume rule
If development is resumed in another chat, read in this order:
1. `docs/CURRENT_CONTINUATION.md`
2. this checkpoint
3. PR #7 / current `main` HEAD and its CI
4. `docs/PROJECT_KNOWLEDGE_INDEX.md`

Do not repeat the ownership investigation unless newer code/evidence contradicts this checkpoint.
