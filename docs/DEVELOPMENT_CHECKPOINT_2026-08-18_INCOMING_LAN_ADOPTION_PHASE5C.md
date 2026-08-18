# Development Checkpoint — Incoming LAN Adoption Phase 5c

Date: 2026-08-18

## Verified baseline

- Base main before Phase 5c: `cce1c8f674c4e7c8862d41c92735e49df4d55b52`.
- Phase 5c branch: `agent/incoming-lan-adoption-phase5c`.
- Draft PR: #9 — `refactor: adopt passive incoming LAN signaling sessions`.
- Verified live-code head before this documentation commit: `7f6b883eb83b96491bfc3df1af007be3ef367e48`.
- CI #113 (`32106767926`) is fully green on that exact code head: JavaScript unit tests, React Native production bundle, Android unit tests, Debug APK, Release APK, and both artifact uploads.
- No new physical two-device evidence has been collected for Phase 5c yet.

## What Phase 5c changed

### 1. Coordinator adopts an existing signaling session

`ConnectionCoordinator` now has a boundary for adopting the active session already owned by the injected signaling owner instead of opening a second TCP connection.

Properties verified by characterization tests:

- no `connectOutbound` call during adoption;
- no second heartbeat owner;
- active connected signaling-owner session required;
- optional inbound-only guard rejects an outbound session;
- same-session/same-peer re-adoption is idempotent;
- an unrelated active logical connection is not overwritten;
- same-peer CONNECTING vs inbound race cancels only the pending outbound connect and adopts the inbound winner;
- terminal signaling-owner disconnect continues to drive coordinator state through the existing generation/disconnect protections.

### 2. Inbound transient recovery is endpoint-bound

A security/reliability race was characterized where any LAN endpoint could previously arrive during the inbound recovery grace and become the replacement session.

The fix preserves the previous inbound route as `peerInfo.host` and accepts a recovery redial only from the same normalized endpoint. IPv4-mapped IPv6 forms such as `::ffff:192.168.x.x` normalize to the same endpoint. A different endpoint is destroyed and the original recovery window remains available to the real peer.

This is route continuity, not peer authentication.

### 3. Passive inbound application messages are identity-gated

The persistent listener can receive a socket before the React UI owns a logical peer. Because `BackgroundRuntime` subscribes to signaling independently, an App-only identity check would not protect background call/message handling.

Phase 5c therefore adds a shared admission boundary in signaling before application-message dispatch for passive LAN sessions:

- heartbeat ping/pong stays internal to signaling;
- pre-identity `my-ip` is consumed as route metadata only and is not treated as identity proof;
- any other application frame before an accepted identity terminates the unadmitted passive session;
- passive identity must arrive within `PASSIVE_INBOUND_IDENTITY_TIMEOUT_MS = 5000`;
- rejection/timeout does not open a transient-recovery window or emit a false UI disconnect;
- explicit Wi-Fi Direct server mode bypasses the passive-LAN gate so current P2P behavior is preserved;
- successful same-endpoint transient recovery inherits the already-admitted state.

### 4. LAN admission uses stable identity plus current route evidence

New `LanPassiveAdmission` policy requires all of the following before coordinator adoption:

- an incoming `identity` message with a `deviceId`;
- that `deviceId` already exists in `PeerRegistry`;
- the peer has a LAN endpoint that is current for the current LAN discovery generation and is not stale/unreachable;
- the discovered LAN endpoint matches the live signaling socket peer address after endpoint normalization;
- the App runtime context allows passive LAN admission: IDLE/DISCONNECTED, or the exact same peer currently racing a known-LAN outbound attempt. Detached UI state does not permanently block the background runtime.

No peer identity is derived from an IP address, socket, interface, or P2P `deviceAddress`.

### 5. Live App promotes admitted inbound LAN sessions

When an admitted inbound LAN `identity` reaches the live App and the coordinator already owns that same peer over LAN, App now:

- promotes the UI to `CONNECTED` with `Tiers.LAN`;
- marks control ownership as `COORDINATOR`;
- uses the live signaling peer address as route host only;
- resolves the displayed peer/contact by stable `deviceId`/`peerId`;
- starts the independent file-transfer server and existing microphone guard;
- sends reciprocal local identity only for the admitted inbound LAN winner;
- preserves current outbound-LAN and Wi-Fi Direct identity behavior without converting them into passive LAN sessions.

### 6. Simultaneous known-LAN connect converges

`connectKnownLanPeer()` now records the exact pending known-LAN peer before the outbound attempt. If a valid inbound session from that same peer wins first, coordinator adoption cancels only the pending outbound connect. The outbound App continuation then recognizes the same healthy admitted inbound LAN winner as success instead of disconnecting it or falling through to P2P.

A different peer or non-LAN session does not get this treatment.

### 7. Persisted history no longer overwrites immediate live messages

Signaling application callbacks are not awaited by the socket parser. A chat frame can therefore arrive immediately after accepted identity while App is still loading persisted history.

`mergePeerMessageHistory()` now merges persisted history with live in-memory messages for the passive promotion path. It uses stable message IDs when available, transfer IDs for transfer rows, and a deterministic fallback fingerprint. Live terminal fields win on duplicates, and neither input array is mutated.

## CI chronology and causal findings

- #89: intentional characterization red — coordinator adoption method missing.
- #91: coordinator adoption full green.
- #93: intentional characterization red — different endpoint could steal inbound recovery.
- #95: first recovery guard remained red because `SignalingSession` clears `session.socket` before `onDisconnect`; the previous endpoint had to be preserved as route metadata.
- #97: endpoint-bound inbound recovery full green.
- #99: intentional characterization red — passive admission seams missing.
- #101: admission runtime behavior tests passed; only test dependency isolation loaded the real TCP dependency.
- #103: after test isolation, all functional tests passed. First job attempt later hit `java.lang.OutOfMemoryError: Java heap space` inside `:app:packageDebug` / ApkFlinger. The same unchanged SHA was rerun and completed fully green, so no Gradle heap/config change was made.
- #105: intentional characterization red — App-promotion/context seams missing.
- #107: passive App policy, runtime-context gate, and signaling ownership health fields full green.
- #109: intentional characterization red — history/live-message merge helper missing.
- #111: history convergence full green.
- #113 (`32106767926`): final live App code head `7f6b883e...` fully green across JS, RN bundle, Android units, Debug APK, Release APK, and both artifact uploads.

## Security boundary — keep explicit

Phase 5c does **not** provide cryptographic peer authentication.

NSD/mDNS service data, `deviceId` claims, current-route generation, and socket-address matching are local discovery/admission evidence only. They reduce accidental/stale routing and several local races, but they do not prevent a capable LAN attacker from spoofing both discovery data and identity claims.

Cryptographic peer authentication/pairing remains a hard prerequisite before any Internet-reachable I2P control signaling is implemented.

## Intentional limitations after Phase 5c

- Wi-Fi Direct signaling/reconnect remains App-owned.
- Manual-IP LAN remains a provisional/diagnostic legacy path.
- General stable-identity duplicate arbitration across all transports and make-before-break are still unfinished.
- UI re-attachment to a background-owned session after Activity/process lifecycle transitions remains a later background-runtime task.
- Process-death networking ownership is not solved by this phase.
- Calls/call history, APK/APKS end-to-end certification, file performance, messaging completeness, UI hardening, CI/security/release hardening remain later release gates.
- The current `SecureHandshake` name must not be interpreted as cryptographic authentication.

## Exact next gate: physical two-device ordinary-LAN certification

Do **not** move P2P ownership yet. The next networking step is device evidence on two Android phones on the same ordinary Wi-Fi LAN.

Required matrix:

1. Verify both devices discover the other as the expected stable peer over LAN.
2. A → B from a saved/known contact:
   - exactly one logical session;
   - B passively promotes to the correct stable contact without initiating;
   - text messaging works both directions;
   - no IP-derived identity/contact is created.
3. Clean disconnect, then B → A with the same checks.
4. Simultaneous connect: initiate the same saved peer on both devices nearly together; the result must converge to one healthy LAN session, with neither device stuck in `WIFI_CONNECTING` and no immediate disconnect.
5. Transient recovery: briefly interrupt the signaling route and restore it within the recovery grace when practical; a successful recovery must not produce a false terminal UI disconnect.
6. File-transfer smoke test both directions while signaling remains healthy.
7. If any case fails, capture the device pair, current LAN IPs, initiator, `[G1/SIGNAL]`, coordinator state transitions, and `[G1/LAN]` logs before changing more networking code.

Only after this matrix passes, or any device failure is diagnosed and fixed, should ownership migration continue toward P2P/general make-before-break.

## Progress

G1-before-I2P remains **42%** until this Phase 5c documentation head itself passes final CI and is fast-forwarded into `main`. After that verified merge, raise the project progress cautiously; physical device certification remains the next release gate.
