# G1 connection ownership map

**Verified against:** `main@cd8bbbd869fc57dbb2d30fcb140b43b620df8274`  
**Date:** 2026-08-18  
**Scope:** connection/session ownership before the first surgical networking migration.

This document distinguishes current code ownership from the target model. A class or file existing in the repository does not make it the live owner. The live call path is the deciding evidence.

## Evidence classification

- **CONFIRMED** — demonstrated by current code/tests/CI.
- **LIKELY** — strongly supported but missing one decisive observation.
- **HYPOTHESIS** — plausible and awaiting reproduction.
- **GOAL** — intended target behavior, not current fact.
- **NOT VERIFIED** — no current device evidence.

## Current ownership map

| Concern | Current live owner | Parallel / secondary owner | Classification and evidence |
|---|---|---|---|
| LAN discovery | `src/network/LanDiscovery.js` + Android `LanDiscoveryModule`; startup is initiated by `App.js` | `PeerRegistry` receives LAN results through callbacks wired by `App.js` | **CONFIRMED.** `App.js` starts advertising/discovery and forwards found/lost peers into `PeerRegistry`. |
| Wi-Fi Direct discovery | `App.js` + Android `DirectConnectionModule` | Wi-Fi Direct DNS-SD is a confidence signal inside the same flow | **CONFIRMED.** `App.js` owns discovery sequencing, scan generations, invitations, fresh-peer selection and UI state. |
| Peer registry | `src/network/PeerRegistry.js` for stable peer records and transport-scoped endpoints | `App.js` still keeps `discoveredRef`, `targetPeerRef`, `peerIpRef`, `connectionAddressTrackerRef` and contact state | **CONFIRMED.** The registry is authoritative only for the data written to it; the live App still maintains overlapping route/peer state. |
| Candidate selection | `App.js` in the live contact-connect flow | `TransportFallbackEngine` implements LAN → P2P → Bluetooth policy but is not the live contact-connect path | **CONFIRMED.** Live flow checks LAN, calls `handleConnectLan`, then falls back to fresh Wi-Fi Direct discovery/negotiation. |
| Signaling listener/server | `src/webrtc/signaling.js` using `SignalingListener` | `ConnectionCoordinator` can construct its own `SignalingSession` for inbound handling, but that path is not wired into `App.js` | **CONFIRMED.** `App.js` starts `startPersistentListener(8089)` directly. |
| Outgoing signaling socket | `src/webrtc/signaling.js::connectToSignalingServer()` / `connectOutboundSocket()`; invoked directly by `App.js` | `ConnectionCoordinator.connectLanPeer()` has a separate outbound implementation | **CONFIRMED.** Two implementations exist; the App live path bypasses the coordinator for LAN. |
| Active signaling session | module-global `activeSession` in `src/webrtc/signaling.js` | `ConnectionCoordinator.activeSession` is a second state holder | **CONFIRMED.** The App message/disconnect callbacks and FileShare route lookup use the `signaling.js` session, not coordinator state. |
| Signaling heartbeat | `src/webrtc/signaling.js` | `ConnectionCoordinator` has a second 6 s / 18 s heartbeat implementation | **CONFIRMED.** Duplicate ownership exists in code; the signaling implementation is the one used by the live App path. |
| Same-route transient signaling recovery | `src/webrtc/signaling.js` | `App.js` adds a later reconnect layer after signaling recovery exhausts | **CONFIRMED.** Signaling has a bounded recovery grace; App's disconnect callback can then invoke `attemptReconnect()`. |
| Cross-route reconnect/fallback | `App.js` today | `TransportFallbackEngine` has initial-connect fallback policy but is not wired as the live owner | **CONFIRMED.** There is no single authoritative cross-transport recovery owner. |
| Duplicate connection arbitration | live enforcement in `src/webrtc/signaling.js` | `ConnectionCoordinator.shouldYieldToInbound()` contains stable-device-id tie breaking but is not the live arbiter | **CONFIRMED.** Live signaling rejects duplicate inbound/late outbound based on current active socket/endpoint. Stable peer-id tie breaking is not wired into the live path. |
| Network bind/unbind | sequencing in `App.js`; OS action in Android `DirectConnectionModule` | none | **CONFIRMED.** App calls Wi-Fi Direct bind/unbind directly around signaling creation/reconnect. |
| P2P group lifecycle | sequencing/state in `App.js`; Android group operations in `DirectConnectionModule` | none | **CONFIRMED.** App owns connect/create-group/cleanup/recovery sequencing and related timers. |
| Transport migration | no complete live owner | target behavior exists in architecture docs only | **GOAL.** Current code performs initial fallback/reconnect but does not implement validated make-before-break route migration. |
| File-transfer route | `src/media/FileShare.js` + native `FileTransferModule` | `App.js` supplies compatibility `peerIp`; `FileShare` prefers the live signaling peer address | **CONFIRMED.** Port 8090 data-plane lifecycle is separate from signaling and route selection prefers the active signaling route. |
| Call signaling semantics | `App.js` call controller and `CallRuntime` both react to call control messages | `BackgroundRuntime` forwards call signals to `CallRuntime` even while UI is attached | **CONFIRMED.** Call ownership is still duplicated and is intentionally deferred until network ownership is stabilized. |
| Background runtime | `src/services/BackgroundRuntime.js` for detached-UI message/file persistence, notifications and call forwarding | `App.js` handles the foreground UI copy of the same signaling stream | **CONFIRMED.** It observes signaling rather than owning the signaling session. |
| Call runtime | `src/services/CallRuntime.js` for call identity/records/native actions | `App.js` still owns ringtone, in-call refs, RTC setup and many call transitions | **CONFIRMED.** Not yet a single call state machine. |
| UI / product state | `App.js` | several refs duplicate transport/session facts | **CONFIRMED.** `App.js` is currently both presentation controller and a substantial networking/call orchestrator. |

## Current live connection flow

### Startup

1. `App.js` starts the persistent TCP signaling listener on port 8089.
2. Device identity is loaded.
3. Identity is copied into `ConnectionCoordinator` and `SecureHandshake`, but the coordinator is not then used as the live LAN session owner.
4. `App.js` starts LAN advertising/discovery through `LanDiscovery` and forwards LAN observations to `PeerRegistry`.
5. A separate App effect initializes Wi-Fi Direct, performs startup cleanup/unbind, advertises P2P identity and starts passive listening.

### Contact connection

1. `App.js` checks a LAN endpoint from the contact or `PeerRegistry`.
2. If LAN exists, `App.js::handleConnectLan()` calls `connectToSignalingServer()` directly.
3. On LAN failure, `App.js` performs/awaits fresh Wi-Fi Direct discovery.
4. `App.js::beginWifiNegotiation()` invokes `DirectConnection.connectToPeer()`.
5. When a P2P group forms, `App.js` binds the process to the P2P network and opens signaling as owner/server or client.

`TransportFallbackEngine` is therefore not the authoritative live candidate selector despite containing similar policy.

### Disconnect/recovery

1. `signaling.js` owns heartbeat and a bounded transient same-endpoint recovery window.
2. Only after signaling recovery exhausts does its disconnect callback reach `App.js`.
3. `App.js` adds another grace period and, for the P2P path, can call its recursive bounded `attemptReconnect()` implementation.

This is layered recovery with two owners rather than one explicit connection state machine.

## Confirmed architectural inconsistencies

1. **Two session ownership implementations exist.** `signaling.js` and `ConnectionCoordinator` can each own a `SignalingSession`, active-session state and heartbeat.
2. **The live App bypasses the intended coordinator.** `ConnectionCoordinator` is used by the live App to set identity, while LAN connection/session ownership remains direct in `App.js` + `signaling.js`.
3. **Fallback policy is duplicated.** The live App implements LAN → P2P behavior while `TransportFallbackEngine` implements a parallel LAN → P2P → Bluetooth policy.
4. **The fallback engine is hard-bound to the global coordinator singleton.** This couples a policy helper to one state owner and makes isolated race tests easy to write incorrectly.
5. **A current race test is misleading.** `discoveryFallbackRace.test.js` creates and mocks a local `ConnectionCoordinator`, but `TransportFallbackEngine` currently calls the imported singleton instead; that test can pass through an incidental singleton failure rather than the mocked `ECONNREFUSED` path.
6. **Live duplicate arbitration is not the stable-id policy documented in `ConnectionCoordinator`.** Live signaling currently chooses/rejects sessions using active socket/endpoint state. The coordinator's device-id tie-break is not wired in.
7. **Peer identity and route are still mixed transiently in the LAN UI path.** `handleConnectLan()` temporarily creates `peerId: lan_${ip}` until the remote identity message replaces the UI/session identity. This should not become durable identity.
8. **There is no live make-before-break migration owner yet.** Initial fallback is not equivalent to migration of an already healthy session.
9. **Call lifecycle has two owners.** `BackgroundRuntime`/`CallRuntime` and the App call controller both consume call signaling. This is out of scope for the first networking migration.

## Target ownership model

The target is one owner per concern, without a big-bang rewrite.

| Concern | Target owner | Boundary rule |
|---|---|---|
| LAN discovery | `LanDiscovery` / native `LanDiscoveryModule` | Emits transport-scoped candidates; never owns a signaling session. |
| Wi-Fi Direct discovery/group/bind | a thin Wi-Fi Direct transport adapter around `DirectConnectionModule` | Owns P2P discovery and Android group/network lifecycle only; never owns application identity or signaling semantics. |
| Stable peer + route inventory | `PeerRegistry` | `deviceId` is identity; IP/MAC/interface/socket are transport route attributes with generation/freshness. |
| Candidate ordering, connection attempts, fallback and cross-transport migration | `ConnectionCoordinator` | One authoritative connection orchestrator. UI issues intent; coordinator selects/validates candidates. |
| Fallback sequencing algorithm | `TransportFallbackEngine` as a policy/helper owned by the coordinator | No global session singleton dependency and no independent connection state authority. |
| Signaling listener/socket/session | `src/webrtc/signaling.js` plus `SignalingListener`/`SignalingSession` internals | One authoritative control-channel session implementation. Coordinator requests connect/adopt/close; signaling owns socket/session details. |
| Heartbeat + same-route micro-recovery | signaling session layer | Transport-independent and bounded. No duplicate App/coordinator heartbeat. |
| Cross-route recovery/migration | `ConnectionCoordinator` | Evaluates candidates after same-route recovery fails; make-before-break for healthy active sessions whenever the platform permits. |
| Duplicate inbound/outbound decision | `ConnectionCoordinator` | Stable peer identity/generation determines the winner; signaling layer enforces the decision on sockets. |
| File data plane | `FileShare` / native `FileTransferModule` | Independent transfer lifecycle; consumes a validated route but never owns or closes signaling. |
| Background persistence/notifications | `BackgroundRuntime` | Observes logical events; does not own transport/session. |
| Call lifecycle | `CallRuntime` after networking ownership stabilizes | One call state machine; App becomes UI/controller adapter rather than lifecycle owner. |
| Presentation | `App.js` and components | User intent + rendering only. Networking route details remain diagnostics, not normal UX. |

## Surgical migration sequence

1. **Characterize the existing fallback boundary before changing it.**
2. Make the coordinator dependency of `TransportFallbackEngine` explicit/injectable while keeping the current singleton as the default. This is intentionally behavior-preserving and creates a test seam.
3. Use that seam to make race/fallback tests operate on the coordinator instance they claim to test.
4. Next phase: define the LAN candidate/route contract and migrate only the live LAN connect intent from `App.js` toward one coordinator path while keeping `signaling.js` as the sole signaling-session owner.
5. Only after that path is green should reconnect ownership, duplicate arbitration, make-before-break and Wi-Fi Direct orchestration move incrementally.

## First migration invariant

> `TransportFallbackEngine` must preserve its current external candidate order and timeout/fallback behavior, but tests and future orchestration must be able to provide the exact coordinator instance that owns the attempt.

This migration must not change the live App connection behavior.

## Device evidence

**NOT VERIFIED for this migration.** The first phase is a code-ownership/testability change and does not claim new Samsung/Motorola behavior. Physical testing becomes necessary when a live transport path changes or when Android/OEM behavior is the unresolved evidence gap.
