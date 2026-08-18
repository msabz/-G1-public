# G1 Current Continuation

This is the rolling resume pointer. Update it at every material phase transition. Dated checkpoint files remain the historical archive.

Last prepared: 2026-08-18

## Read first

Latest dated checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-18_LIVE_LAN_PHASE5B.md`

Master execution strategy:
GitHub issue #5 — `Master execution strategy: release-ready G1 → independent I2P overlay`.

## Current verified implementation state

- Verified base `main` before Phase 5b merge: `585468c6d68043e482f75e986a1bf470598a1ba3`.
- Active Phase 5b branch: `agent/live-lan-app-wiring-phase5b`.
- Active PR: #8 — `refactor: wire live known-LAN through coordinator`.
- Corrected live code head: `f4d3cddd1aa3984f57a3eb0cca6924c8bcd4b7df`.
- Corrected-head CI #83 (`32101066718`) is fully green: JS tests, RN bundle, Android units, Debug APK, Release APK and both artifacts.
- Phase 5b moves known-contact outbound LAN to `ConnectionCoordinator` and makes App disconnect cleanup transport/control-owner aware.
- `src/App.js` no longer invents `lan_<ip>` identity and no longer stores LAN IP in P2P `deviceAddress`.
- Manual-IP LAN remains a legacy/provisional diagnostic path.
- Current live Wi-Fi Direct ownership remains in App on purpose.
- Persistent-listener incoming LAN promotion/reciprocal identity is still incomplete and is the exact next networking checkpoint.
- No new physical-device evidence exists for Phase 5b yet.

## Phase 5b merge procedure

1. Inspect PR #8 head and final Actions state; do not assume merge from this file alone.
2. The corrected code head `f4d3cddd...` is green on #83.
3. This documentation checkpoint must itself receive a final full-green CI run.
4. Re-check that `main` is still `585468c6...` and that the PR head is strictly ahead/behind=0.
5. Fast-forward `main` non-force to the exact tested documentation head.
6. Verify PR #8 becomes `closed + merged=true` with the same SHA; do not create a different merge commit.

## Exact next engineering step after Phase 5b merge

Create branch:
`agent/incoming-lan-adoption-phase5c`

Then:

1. Add characterization tests for coordinator adoption of an already-active signaling-owner session.
2. Implement a transport-neutral `adoptSignalingOwnerSession(peer, transport, { requireInbound })`-style boundary (final name may vary) that:
   - uses `signalingOwner.getActiveSession()`;
   - does not call `connectOutbound`;
   - rejects a disconnected/missing session;
   - can require `session.isOutbound === false`;
   - does not start coordinator heartbeat for an externally managed session;
   - reuses generation/disconnect-subscription protections;
   - converges the same-peer CONNECTING/inbound race safely.
3. Wire passive LAN identity handling in App only when App is IDLE/DISCONNECTED with a live inbound session. P2P `WIFI_CONNECTING` and outbound LAN must not take this branch.
4. Upsert the LAN route as `deviceId + host + port`; never derive identity from IP.
5. Send local identity once as the reciprocal passive-LAN response, then promote App UI/history to LAN CONNECTED.
6. Full CI.
7. When both directions are code/CI green, stop networking refactoring and run the physical two-device LAN certification matrix before moving P2P ownership.

## Known limitations to keep visible

- incoming LAN passive session is not yet promoted into coordinator/UI;
- current deviceId claim is not cryptographically authenticated;
- general duplicate arbitration / make-before-break remains unfinished;
- P2P signaling/reconnect is still App-owned;
- background/process-death networking still needs later Android-runtime work;
- calls/APK/file-performance/messaging/UI release gates remain after networking stabilization.

## Progress metric

G1-before-I2P: **40%** before the Phase 5b fast-forward. Raise only on a verified merged milestone, not on commit count.

## Goal constraint

Finish and device-verify G1 P0/P1 reliability before implementing I2P. I2P is a future independent transport/overlay. I2P Destination is route addressing, not peer identity, and cryptographic peer authentication is required before Internet-reachable control signaling.
