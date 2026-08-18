# G1 development checkpoint — connection ownership phase 1

**Date:** 2026-08-18  
**Repository:** `msabz/-G1-public`  
**Base verified before work:** `main@cd8bbbd869fc57dbb2d30fcb140b43b620df8274`  
**Work branch:** `agent/connection-ownership-phase1`  
**PR:** #2 — `refactor: establish connection ownership boundary`

## Problem

The current networking implementation has duplicated ownership. The live app uses `src/webrtc/signaling.js` for the actual signaling session and `App.js` for LAN/P2P orchestration, while `ConnectionCoordinator` and `TransportFallbackEngine` contain a parallel connection architecture.

The first surgical target was intentionally smaller than moving the live LAN path: `TransportFallbackEngine` was hard-bound to the global `connectionCoordinator`, which made ownership implicit and allowed tests to mock a coordinator instance the engine never used.

## Evidence before migration

**CONFIRMED:** `discoveryFallbackRace.test.js` created a local `ConnectionCoordinator`, mocked its `connectLanPeer()`, then instantiated a default `TransportFallbackEngine`. The engine called its imported global singleton instead of the mocked local coordinator. The old test could therefore pass because the singleton failed incidentally, not because the intended `ECONNREFUSED` path was exercised.

**CONFIRMED:** `App.js` does not use `TransportFallbackEngine` as its live contact-connect path, so making this dependency explicit did not change live application routing behavior.

The full pre-migration ownership evidence and target model are recorded in `docs/CONNECTION_OWNERSHIP_MAP_2026-08-18.md`.

## Decision

Keep `connectionCoordinator` as the default dependency for compatibility, but make the dependency explicit and injectable through `TransportFallbackEngine` construction.

This is a testability/ownership seam, not a new connection state machine and not a live-path migration.

## Invariant

> `TransportFallbackEngine` must preserve its existing candidate order, timeout and fallback semantics, while every attempt is delegated to the exact coordinator instance that owns that engine.

The migration must not create another signaling owner and must not change `App.js` connection behavior.

## Files changed

- `docs/CONNECTION_OWNERSHIP_MAP_2026-08-18.md`
- `__tests__/transportFallbackOwnership.test.js`
- `src/network/TransportFallbackEngine.js`
- `__tests__/discoveryFallbackRace.test.js`

## Tests

Characterization coverage was added before the refactor to prove the default behavior:

- default LAN attempt delegates the exact peer and timeout to the global coordinator;
- explicit LAN refusal falls through to P2P while preserving the same peer object.

The race test was then corrected to inject the local coordinator it mocks and assert the LAN call explicitly. After the migration, CI output shows the intended failure evidence:

`[FallbackEngine] LAN connection failed, attempting next transport: ECONNREFUSED`

This replaces the previous incidental singleton/mock failure path.

## CI evidence

### Pre-migration characterization

GitHub Actions run **#17**, run id `32087954110`, completed successfully before the refactor. JavaScript tests, React Native production bundle, Android unit tests, Debug APK, Release APK and artifact uploads all passed.

### Migration validation

Commit: `90ac287507712cc0628b8f86f4a90e305dfceacb` — `refactor: inject fallback connection owner`

GitHub Actions run **#19**, run id `32088402447`, completed successfully:

- JavaScript test suites: **13 passed / 13 total**
- JavaScript tests: **67 passed / 67 total**
- React Native production bundle: passed
- Android unit tests: passed
- Debug APK: built successfully
- Release APK: built successfully
- Debug artifact: uploaded successfully
- Release artifact: uploaded successfully

Warnings in the run (dependency deprecations, Android API deprecations and npm audit findings) were not causal failures for this change and are not classified as this migration's root cause.

## Device evidence

**NOT VERIFIED / not required for this phase.** No live Android transport path was changed. This checkpoint does not claim new Samsung or Motorola networking behavior.

## Remaining limitations

- `App.js` still owns the live LAN → P2P contact-connect sequence.
- `src/webrtc/signaling.js` remains the live signaling owner while `ConnectionCoordinator` still contains a parallel `SignalingSession`/heartbeat implementation.
- reconnect ownership is still split between signaling micro-recovery and App-level P2P reconnect logic.
- stable-id duplicate arbitration in `ConnectionCoordinator` is not yet the live socket arbitration policy.
- make-before-break transport migration is still a **GOAL**, not an implemented feature.
- call ownership remains duplicated between `App.js` and `CallRuntime`; it remains intentionally out of scope until networking ownership is stabilized.

## Next engineering step

Do **not** route `App.js` directly into the current `ConnectionCoordinator.connectLanPeer()` implementation yet. That method creates its own `SignalingSession`, which would introduce the wrong signaling owner into the live path and bypass the observer/session semantics currently provided by `src/webrtc/signaling.js`.

The next networking migration should first define a LAN candidate/connection boundary in which `ConnectionCoordinator` orchestrates the attempt **through the existing signaling owner**, rather than becoming a second signaling implementation. Add characterization tests for that boundary before changing `App.js`.

A separate CI-efficiency follow-up is also warranted: the workflow currently validates both `push` and `pull_request`, which can duplicate feature-branch work, and every change still builds both Debug and Release. Optimize this separately so validation strength is not mixed with networking behavior changes.
