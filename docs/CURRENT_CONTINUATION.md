# G1 Current Continuation

This is the rolling resume pointer. Update it at every material phase transition. Dated checkpoint files remain the historical archive.

Last prepared: 2026-08-18 after LAN Phase 5d physical revalidation and Stage A5 Phase 6a P2P ownership-boundary merge.

## Read first

Master execution strategy:
GitHub issue #5 — `Master execution strategy: release-ready G1 → independent I2P overlay`.

Historical Phase 5c checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-18_INCOMING_LAN_ADOPTION_PHASE5C.md`.

Phase 5d checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-18_LAN_STABILIZATION_PHASE5D.md`.

## Current verified baseline

- Canonical repository: `msabz/-G1-public`.
- Canonical branch: `main`.
- PR #10 merged first LAN stabilization at `efb58b20281e363d4a9517260f6ff19a3d053bd2`.
- PR #11 merged LAN race hardening at `8b3e6aad2783697c2df0fb6278a7830b8cc998fe`.
- PR #12 merged foreground/task-dismissal session rehydration at `f90c4d913a4efe30edb67ca788544ce9fb3e74e8`.
- User physical revalidation after PR #12 passed the previously failing ordinary-LAN matrix: two-way chat, simultaneous connect, repeated disconnect/reconnect, files, voice/video call convergence, busy behavior, and foreground resume after removing one App task while the peer remained in-session.
- Phase 5d ordinary-LAN networking is therefore **CODED / UNIT VERIFIED / CI VERIFIED / DEVICE VERIFIED** for the tested matrix.
- PR #13 merged Stage A5 Phase 6a at `55b7d37c043651215757705fe0f8c4a883debe9d` (`refactor: establish coordinator-owned Wi-Fi Direct boundary`).
- PR #13 final head `5e7193569b46db6a79d68dac495a8c5f31582211` passed GitHub Actions run #179 (`32177708754`): JavaScript tests, production bundle, Android unit tests, Debug APK, Release APK and both artifact uploads.

## Phase 5d LAN conclusions

Confirmed in code/tests and then device revalidation:

- recovered outbound signaling sessions replay stable local G1 identity;
- simultaneous same-peer LAN races use deterministic stable-deviceId arbitration rather than socket arrival order;
- different peers cannot steal a healthy session;
- provisional duplicate promotion is make-before-break with rollback;
- coalesced and segmented signaling frames survive promotion;
- UTF-8 signaling frame limits are enforced consistently;
- graceful disconnect suppresses transient recovery redial;
- passive/background LAN session state can rehydrate a new React UI after task dismissal without opening a second socket;
- signaling remains the one socket/session/heartbeat/same-route-recovery owner.

Do not revive the historical TCP-KeepAlive root-cause claim. `SignalingSession` already enables keepalive best-effort and physical evidence did not establish KeepAlive as the cause.

## Current phase — Stage A5 / P2P migration

### Phase 6a — MERGED / UNIT VERIFIED / CI VERIFIED

PR #13 establishes the P2P ownership seam without yet replacing the live App P2P path.

Implemented:

- `WifiDirectTransportAdapter` owns Android Wi-Fi Direct route lifecycle: stable-identity-backed P2P observations, group negotiation, process bind/unbind and group cleanup.
- Raw Wi-Fi Direct MAC / `deviceAddress` is route metadata only and never becomes G1 peer identity by itself.
- `ConnectionCoordinator.connectP2pPeer()` owns logical P2P connection state.
- `signalingOwner` now supports both outbound signaling and group-owner inbound accept/wait through the existing `signaling.js` runtime.
- `signaling.js` remains the single signaling socket/session/heartbeat/recovery owner; the coordinator does not start a second heartbeat for externally managed sessions.
- Coordinator P2P cancellation/failure/terminal teardown delegates Android group cleanup to the P2P adapter.
- `TransportFallbackEngine` defaults P2P to the coordinator path when no compatibility handler is supplied, while legacy handler precedence remains during migration.
- Production bootstrap wires the P2P adapter into the coordinator and begins passive route observation.
- Tests cover P2P client/group-owner roles, cancellation, signaling failure cleanup, terminal signaling loss, explicit disconnect, stable identity vs route separation, bind/cleanup and fallback ownership.

### Phase 6a scope boundary

`src/App.js` still owns the currently live Wi-Fi Direct UI/orchestration path (`connectToPeer`, group-owner/client signaling bootstrap, and legacy P2P reconnect). Therefore **Stage A5 is not complete and P2P is not device-verified on the new coordinator path yet**.

## Immediate next engineering action — Phase 6b

Move the live App P2P intent onto the coordinator/adapter path in one bounded slice:

1. App remains presentation/user-intent only; it requests P2P connect but does not create/own signaling sockets.
2. Both outgoing and trusted incoming Wi-Fi Direct negotiation go through `ConnectionCoordinator.connectP2pPeer()` + `WifiDirectTransportAdapter`.
3. Native `PEER_CONNECTED` becomes adapter route evidence, not an App trigger to call `createSignalingServer()` / `connectToSignalingServer()`.
4. P2P `activeControlOwner` becomes coordinator-owned.
5. Remove/disable App-owned P2P signaling reconnect only after the coordinator-owned live path has deterministic tests.
6. Preserve file/data plane independence, message history and existing UI semantics.
7. After CI passes, perform one focused physical P2P bootstrap test in both group-owner/client roles before expanding the matrix.

Do not begin I2P. Stage B remains gated on the full Stage A release-ready bar.

## Remaining Stage A order

After P2P ownership migration:

- background/process lifecycle ownership;
- complete call state machine and durable call history;
- APK/APKS/signing/update correctness;
- file-transfer isolation/performance and messaging completeness;
- UI/UX and release/security/CI hardening.

Only then add I2P as an independent overlay route. I2P destination is route addressing, not peer identity. Cryptographic peer authentication/pairing is a hard prerequisite before Internet-reachable control signaling.

## Evidence rules

Use: `CONFIRMED`, `LIKELY`, `HYPOTHESIS`, `GOAL`, `NOT VERIFIED`.

Priority of truth:
1. current code/tests;
2. CI on the same SHA/tree;
3. reproducible raw device evidence;
4. this rolling continuation;
5. dated checkpoints/handoffs;
6. external-agent interpretations.

Do not store secrets or private identity material in the public repository.
