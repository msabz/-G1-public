# G1 development checkpoint — signaling connect cancellation phase 3

**Date:** 2026-08-18  
**Repository:** `msabz/-G1-public`  
**Base verified before work:** `main@bef2cc29033c59457622ca612f55582d908b7a60`  
**Work branch:** `agent/signaling-connect-cancel-phase3`  
**PR:** #4 — `refactor: separate signaling connect cancellation`

## Problem

Phase 2 introduced a high-level signaling-owner contract in `ConnectionCoordinator`, but the live signaling runtime exposed only `closeSignaling()` for cancellation-like behavior. `closeSignaling()` is intentionally a full lifecycle close: it destroys the active session as well as cancelling a pending connect operation. Wiring coordinator attempt cancellation to that function would violate the invariant that cancelling an obsolete attempt must never destroy an unrelated healthy active session.

## Characterization before production migration

The PR first added `__tests__/signalingCancellationCharacterization.test.js` to prove the existing full-close semantics:

- `closeSignaling()` settles a pending outbound attempt;
- a socket that completes after that close is destroyed/not promoted;
- `closeSignaling()` also destroys a healthy active signaling session and therefore cannot be used as a connect-attempt-only primitive.

Characterization HEAD `ed29a2e8cbb63cb9cc86aeadad85f67f5fde2422` passed GitHub Actions run **#39** (`32092237236`) before production code changed.

## Decision

Add one deliberately narrow API to the existing live signaling owner:

```js
cancelSignalingConnectAttempt(reason?)
```

Semantics:

- returns `true` only when a pending connect operation existed and was cancelled;
- returns `false` when no pending connect operation exists;
- settles/rejects the outer connect promise;
- does not stop heartbeat;
- does not cancel transient recovery;
- does not close the persistent listener;
- does not destroy or clear `activeSession`;
- does not emit a healthy-session disconnect event;
- a later completion from the cancelled outbound operation is rejected/destroyed by the existing settled-operation guard.

`closeSignaling()` remains the full-close API and now reuses the narrow primitive only for the pending-connect portion while retaining its existing session/listener/client-wait cleanup behavior.

## Production implementation

Production seam commit:

`b39d869956d8def9c551f0ded03e18f1989d1735` — `refactor: expose connect-only signaling cancellation`

Focused regression commit:

`a18d0c8d5f65b6aee9eeaf18582505cc1cb2883c` — `test: protect connect-only signaling cancellation`

The focused regression suite covers:

1. full close still cancels a pending attempt with full-close semantics;
2. full close still destroys a healthy active session;
3. connect-only cancellation settles the pending attempt and is idempotent/no-op when no attempt remains;
4. a late outbound socket after cancellation is destroyed/not promoted;
5. stronger race: while an outbound attempt is pending, an inbound healthy session may win; cancelling the obsolete outbound attempt preserves that inbound active session, emits no false disconnect, and later destroys only the obsolete outbound socket.

## CI evidence

Production/test HEAD `a18d0c8d5f65b6aee9eeaf18582505cc1cb2883c` passed GitHub Actions run **#43** (`32093247258`):

- Install Node Dependencies: success;
- JavaScript unit tests: success;
- React Native production bundle: success;
- Android unit tests: success;
- Debug APK: success;
- Release APK: success;
- Debug APK artifact upload: success;
- Release APK artifact upload: success.

No warning/deprecation output is promoted to a root cause merely because it appeared in a successful run.

## Device evidence

**NOT VERIFIED / not required for this phase.** `App.js` live transport orchestration was not moved. This checkpoint claims code and CI evidence only.

## Invariants preserved

> Cancelling an obsolete connection attempt must never close an unrelated healthy active signaling session.

> A cancelled/obsolete attempt must never be promoted after a late completion.

> One active control-channel session has one heartbeat/recovery owner.

> `closeSignaling()` remains an explicit full-close lifecycle operation; connect-attempt cancellation is a separate responsibility.

## Known limitation intentionally not expanded in this phase

`connectOutboundSocket()` itself does not yet expose an AbortSignal/token that interrupts its underlying retry/socket timer immediately. This phase cancels and settles the owning signaling operation, and the existing settled guard destroys a later socket completion. Do not broaden this surgical seam unless evidence shows the underlying retry lifetime is itself a causal problem.

## Next engineering steps

1. Introduce a thin signaling-owner adapter around the existing `src/webrtc/signaling.js` runtime using `connectToSignalingServer()`, `cancelSignalingConnectAttempt()`, `sendSignalingMessage()`, `closeSignaling()`, `getActiveSession()`, and disconnect observation.
2. Add deterministic coordinator state synchronization for signaling disconnect/recovery exhaustion.
3. Only after both are green, move the live LAN connection intent out of direct `App.js -> connectToSignalingServer()` ownership into the coordinator/orchestrator path.
4. Do not move Wi-Fi Direct, calls, or add a new transport in the same migration.

## Master product direction

The durable master strategy is tracked in GitHub Issue #5: finish and verify the existing G1 product to release-ready status first, then add I2P as an independent overlay route without violating transport independence, peer-identity separation, control/data-plane separation, make-before-break, security, or current-route regression gates.
