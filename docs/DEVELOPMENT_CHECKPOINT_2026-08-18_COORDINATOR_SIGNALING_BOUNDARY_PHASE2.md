# G1 development checkpoint — coordinator/signaling ownership boundary phase 2

**Date:** 2026-08-18  
**Repository:** `msabz/-G1-public`  
**Base verified before work:** `main@dbf705a39c1ddf9ff024ce9c0966c8ee0162b93f`  
**Work branch:** `agent/coordinator-signaling-boundary-phase2`  
**PR:** #3 — `refactor: route coordinator toward signaling owner`

## Problem

`ConnectionCoordinator.connectLanPeer()` historically opened its own TCP socket, created its own `SignalingSession`, and started its own heartbeat. The live application simultaneously uses `src/webrtc/signaling.js` as the real control-channel owner. Routing the live App directly into the old coordinator implementation would therefore create a second signaling/session ownership system rather than remove one.

Phase 2 creates the ownership boundary required before any live LAN-path migration.

## Evidence before migration

**CONFIRMED:** `App.js` still uses `src/webrtc/signaling.js` directly for the live LAN and Wi-Fi Direct signaling path.

**CONFIRMED:** the legacy coordinator LAN implementation creates a separate `SignalingSession` and coordinator heartbeat.

**CONFIRMED:** the coordinator's logical connection semantics need to survive the migration: successful LAN connection means `CONNECTED`, same stable peer object, transport `LAN`, and one connection callback; a cancelled obsolete attempt must not be promoted by a late socket.

## Pre-migration characterization

Commit `73f92662c7eea1081ce23c8d539ec4e03e0b92f2` added `__tests__/connectionCoordinatorLanCharacterization.test.js` covering:

- successful legacy LAN attempt logical state/callback semantics;
- cancellation of a pending legacy LAN attempt and suppression/destruction of a late socket.

GitHub Actions run **#25**, run id `32089394565`, completed green before production code changed:

- JavaScript tests: success;
- React Native production bundle: success;
- Android unit tests: success;
- Debug APK: success;
- Release APK: success;
- both artifacts: success.

## Decision

Add an optional high-level `signalingOwner` contract to `ConnectionCoordinator`.

When a signaling owner is supplied:

- the coordinator owns logical peer/transport/connection state;
- the injected signaling owner owns the actual socket/session;
- the injected owner owns heartbeat and same-route signaling recovery;
- send/disconnect/cancel operations are delegated to the owner;
- the coordinator must not start a second heartbeat for that session.

The existing coordinator LAN implementation remains as a temporary compatibility fallback when no owner is supplied. This is deliberate surgical migration, not a rewrite.

## Invariants

> One active control-channel session has one heartbeat/recovery owner.

> Cancelling an obsolete connection attempt must never close an unrelated healthy active signaling session.

> A cancelled/obsolete attempt must never be promoted after a late completion.

> An invalid signaling-owner contract must fail before mutating coordinator state.

## Implementation

Commit `e542a2b0f659fd76a2d3eb229bc3c04ef5014048` added the signaling-owner boundary.

Self-review then found a deterministic contract bug before merge: an injected owner missing `connectOutbound()` would have allowed `connectLanPeer()` to enter `CONNECTING` before rejecting. This was corrected in commit `40acb970e69ca2ce640559ac26f38631065fb165` so owner validation occurs before state mutation, with regression coverage.

### Current externally-owned LAN behavior

- `connectLanPeer()` delegates to `signalingOwner.connectOutbound(...)`.
- The coordinator mirrors the owner's active session handle through `getActiveSession()` for logical state only.
- `activeSessionManagedExternally` records that the coordinator does not own socket destruction.
- coordinator heartbeat stays stopped for externally managed sessions.
- `sendMessage()` delegates to `signalingOwner.sendMessage()`.
- cancellation delegates to `signalingOwner.cancelConnect()`.
- disconnect delegates to `signalingOwner.disconnect()` rather than directly destroying the owner's session.
- real connection failure becomes coordinator `ERROR` and is rethrown.
- cancelled/obsolete attempts return without promotion.
- replacing a signaling owner while CONNECTING/CONNECTED is rejected.

## Files changed

- `src/network/ConnectionCoordinator.js`
- `__tests__/connectionCoordinatorLanCharacterization.test.js`
- `__tests__/connectionCoordinatorSignalingOwner.test.js`
- this checkpoint document

## Tests added

`__tests__/connectionCoordinatorSignalingOwner.test.js` covers:

1. external LAN delegation and no second heartbeat;
2. send/disconnect delegation without direct session destruction;
3. cancelled pending external attempt stays IDLE;
4. real external failure is surfaced as ERROR;
5. invalid owner contract fails before coordinator state mutation;
6. signaling owner cannot be replaced while connecting/connected.

Legacy characterization remains in place so the temporary fallback path cannot silently change during the transition.

## CI evidence

Phase 2 migration HEAD before this documentation commit: `40acb970e69ca2ce640559ac26f38631065fb165`.

GitHub Actions run **#29**, run id `32089934877`, completed successfully:

- JavaScript test suites: **15 passed / 15 total**;
- JavaScript tests: **75 passed / 75 total**;
- React Native production bundle: passed;
- Android unit tests: passed;
- Debug APK: built successfully;
- Release APK: built successfully;
- Debug APK artifact: uploaded successfully;
- Release APK artifact: uploaded successfully.

Warnings about package/API deprecations and npm audit findings were not causal failures for this migration and are not classified as root causes.

## Device evidence

**NOT VERIFIED / not required for this phase.** No live `App.js` transport path has been moved to the coordinator yet. This checkpoint claims code/CI evidence only and does not claim new Samsung or Motorola behavior.

## Remaining limitations

- the global `connectionCoordinator` is not yet wired to `src/webrtc/signaling.js`;
- the coordinator external-owner path does not yet subscribe to signaling disconnect/recovery-exhausted events, so it must not become the live logical owner until state synchronization is added;
- the legacy coordinator-owned `SignalingSession` and heartbeat remain temporarily available as a fallback and must be removed only after all callers move safely;
- incoming session handling in `ConnectionCoordinator` is still its legacy session path;
- `App.js` still directly owns the live LAN → P2P connection sequence;
- duplicate inbound/outbound arbitration in the live signaling path is still not the coordinator's stable-device-id policy;
- make-before-break cross-transport migration remains a **GOAL**;
- call ownership remains duplicated and is intentionally out of scope until networking ownership is stabilized.

## Next engineering step

Do not connect the coordinator to `closeSignaling()` as a generic cancellation function. `closeSignaling()` destroys the active session and would violate make-before-break/obsolete-attempt safety.

The next small migration should add a **connect-attempt-only cancellation API** to `src/webrtc/signaling.js` and deterministic tests proving:

1. a pending signaling connect can be cancelled and settles;
2. a late socket from the cancelled attempt is destroyed/not promoted;
3. cancelling a pending attempt does not destroy an unrelated healthy active session;
4. cancelling an attempt does not emit a false session-disconnect event for a healthy active session.

After that, introduce a thin signaling-owner adapter around the existing signaling runtime and then add coordinator disconnect-state synchronization before changing the live `App.js` LAN path.
