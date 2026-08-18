# G1 Development Checkpoint — Live LAN Phase 5b

Date: 2026-08-18

## Purpose

This checkpoint records the first live App integration of the Phase 5 LAN ownership seams. The scope is intentionally outbound/known-peer LAN plus transport-aware teardown. It does **not** claim incoming persistent-listener LAN is complete and it does **not** move live Wi-Fi Direct ownership out of `App.js` yet.

## Source-of-truth state at checkpoint creation

- Verified base `main`: `585468c6d68043e482f75e986a1bf470598a1ba3`.
- Phase 5b branch: `agent/live-lan-app-wiring-phase5b`.
- Draft PR: #8 — `refactor: wire live known-LAN through coordinator`.
- Corrected live code head: `f4d3cddd1aa3984f57a3eb0cca6924c8bcd4b7df`.
- Corrected-head CI: run #83, run id `32101066718`.
- #83 completed successfully: JavaScript unit tests, React Native production bundle, Android unit tests, Debug APK, Release APK, Debug artifact upload and Release artifact upload all passed.
- No new physical-device evidence was produced by this checkpoint.

## Live behavior now implemented on the corrected code head

### Known-contact LAN

- `connectToContact()` resolves a stable LAN target through `resolveKnownLanTarget()`.
- Known-contact LAN no longer calls the manual-IP `handleConnectLan(ip)` path.
- `ConnectionCoordinator.connectLanPeer()` owns the logical known-LAN connection attempt.
- Historical live LAN attempt policy is preserved explicitly: 5 total attempts, 800 ms retry delay.
- The App promotes the session only after:
  - the coordinator remains `CONNECTED`;
  - the coordinator still points at the expected `deviceId`;
  - the coordinator transport remains `LAN`;
  - live signaling health is connected;
  - sending the local G1 identity succeeds while signaling remains healthy.
- Failure cleanup is scoped to the same `deviceId + LAN` coordinator state before P2P fallback.

### Peer identity and route separation

- The historical synthetic identity `lan_<ip>` is removed.
- A LAN IP is stored as `host`, not `deviceAddress`.
- Existing P2P `deviceAddress` information is preserved when the same peer also has a LAN route.
- `Tiers.LAN` is explicit; the invalid historical `Tiers.WIFI` value is no longer used.
- Manual-IP diagnostics remain provisional/legacy. They have a `host` route but do not pretend the IP is a stable peer identity.

### Transport/control-plane ownership

The App now tracks two independent facts:

- active transport: LAN / P2P / Bluetooth;
- active control-plane owner: coordinator / legacy App / none.

Current intended mapping:

- known LAN = `TRANSPORTS.LAN + COORDINATOR`;
- manual diagnostic LAN = `TRANSPORTS.LAN + LEGACY_APP`;
- current Wi-Fi Direct = `TRANSPORTS.P2P + LEGACY_APP`;
- Bluetooth remains outside the signaling control plane.

This keeps `Transport != Signaling Session` explicit in the live App.

### Disconnect and recovery behavior

- Explicit and remote signaling disconnects now finish according to the current transport/control-owner plan.
- Generic session cleanup no longer calls `DirectConnection.unbindNetwork()`.
- Wi-Fi-Direct-native cleanup remains in the P2P-only cleanup path.
- `DirectConnection.unbindNetwork()` remains only in startup stale-P2P cleanup and `cleanupWifiDirect()`.
- Delayed `PEER_DISCONNECTED` broadcasts from Android are ignored when the active transport is not P2P.
- App-level legacy reconnect remains P2P-only in this phase.
- Terminal LAN signaling loss does not enter the P2P reconnect loop.

### File-transfer isolation

- The old outgoing-only `activeTransfersRef` counter is removed.
- `TransferActivityGate` tracks incoming and outgoing transfer IDs independently.
- Incoming transfer activity starts on `FT_INCOMING_START` and is released on matching DONE/ERROR.
- Outgoing activity is released by the `sendFileNative()` Promise `finally`, matching the native completion/error contract.
- Terminal signaling teardown can be deferred until the independent data plane becomes idle.
- File transfer still does not own or close signaling.

## Self-review invariants checked on `f4d3cddd...`

Confirmed absent from the resulting `src/App.js`:

- `lan_${ip}`;
- `deviceAddress: ip` for manual LAN;
- `deviceAddress: lanInfo.host` for known LAN;
- `activeTransfersRef`;
- generic `cleanupAll()`;
- known-contact `await handleConnectLan(...)`;
- invalid `Tiers.WIFI`.

Confirmed present/limited:

- known-LAN coordinator state / identity / signaling-health gate before App promotion;
- `DirectConnection.unbindNetwork()` only in startup stale-group cleanup and P2P-native cleanup;
- current P2P live signaling ownership remains App-owned.

## Important limitations that remain

### Incoming LAN is not complete

The persistent listener can already accept a TCP signaling session and heartbeat it, but it initially knows only a route address. Application peer identity arrives later in the `identity` message. Today the App identity handler records identity/history but does not promote a passive incoming LAN session into the coordinator/UI as a connected LAN session and does not perform a deliberate one-time reciprocal identity reply for that passive LAN case.

This is the next networking checkpoint.

### Security

The current `SecureHandshake` still does not cryptographically authenticate a claimed `deviceId`. Expected identity consistency and route separation reduce accidental misbinding, but cryptographic peer authentication/pairing remains a hard gate before exposing the control plane over Internet-reachable I2P.

### Duplicate arbitration / make-before-break

Stable-device-id duplicate arbitration and general cross-route make-before-break are still later Phase A work. This checkpoint does not claim them complete.

### Persistence coupling

Known-LAN promotion currently loads/saves peer history while the signaling session is active. Session health is revalidated after those awaits. A later cleanup may make persistence best-effort so local storage failure cannot unnecessarily reject an otherwise healthy transport; this is not the current Phase 5b merge gate.

## Exact next implementation step after Phase 5b merge

Create `agent/incoming-lan-adoption-phase5c` from the verified merged main and do **not** reopen the outbound socket.

1. Characterize a new coordinator API for adopting an already-active signaling-owner session.
2. Require an externally managed active session; allow `requireInbound` and verify `SignalingSession.isOutbound === false` when requested.
3. Adoption must not call `connectOutbound`, must not create a second heartbeat, and must reuse the existing owner disconnect subscription/generation protections.
4. Test successful inbound adoption, outbound-session rejection when inbound is required, terminal disconnect synchronization, idempotent same-session adoption, and the same-peer CONNECTING race.
5. In App passive identity handling, only treat an identity as passive incoming LAN when App is IDLE/DISCONNECTED and a live signaling session exists; P2P `WIFI_CONNECTING` and outbound LAN must not enter this branch.
6. Build/update the LAN registry route as `deviceId + host + port`, never IP-as-identity.
7. Adopt the existing session in the coordinator, send local identity once, load peer/history, then promote UI state to LAN CONNECTED.
8. Full CI.
9. After inbound + outbound LAN are both code/CI green, perform two-device physical LAN certification before moving live P2P ownership.

## Physical test gate after Phase 5c

At minimum on the Samsung and Motorola devices:

- known peer A -> B over LAN;
- known peer B -> A over LAN;
- receiving side promotes the passive session correctly;
- chat both directions;
- explicit disconnect from each side;
- terminal socket loss and recovery exhaustion;
- large outgoing and incoming file transfer while signaling is disturbed;
- no Wi-Fi Direct group cleanup caused by a LAN disconnect;
- P2P still works after LAN attempts/failures;
- app/background/task-dismiss behavior recorded separately.

## Progress

G1-before-I2P remains **40%** at checkpoint creation because Phase 5b has not yet been fast-forwarded into `main`. Raise only after the final documentation head is CI-green and merged into the verified baseline.
