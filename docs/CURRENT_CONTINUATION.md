# G1 Current Continuation

This is the rolling resume pointer. Update it at every material phase transition. Dated checkpoint files remain the historical archive.

Last prepared: 2026-08-18

## Read first

Latest dated checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-18_INCOMING_LAN_ADOPTION_PHASE5C.md`

Master execution strategy:
GitHub issue #5 — `Master execution strategy: release-ready G1 → independent I2P overlay`.

## Current verified implementation state

- Verified merged base before Phase 5c: `main@cce1c8f674c4e7c8862d41c92735e49df4d55b52`.
- Phase 5c branch: `agent/incoming-lan-adoption-phase5c`.
- Active Draft PR: #9 — `refactor: adopt passive incoming LAN signaling sessions`.
- Verified live-code head: `7f6b883eb83b96491bfc3df1af007be3ef367e48`.
- CI #113 (`32106767926`) is fully green on that exact code head: JS tests, RN production bundle, Android unit tests, Debug APK, Release APK, and both artifact uploads.
- No review threads or submitted reviews are blocking PR #9.
- `main` was re-checked after #113 and remained `cce1c8f6...`; the Phase 5c branch was strictly ahead with no base divergence.
- No new physical two-device evidence exists for Phase 5c yet.

### Networking ownership now

- Known-contact outbound LAN: coordinator-owned.
- Passive incoming LAN: signaling accepts the socket, shared admission validates it, then coordinator adopts the existing signaling-owner session; live App promotes it to LAN CONNECTED when mounted.
- Signaling owns socket/session heartbeat and bounded same-route recovery for coordinator-owned LAN sessions.
- File transfer remains independent on its native data channel.
- Wi-Fi Direct signaling/reconnect remains App-owned intentionally.
- Manual-IP LAN remains provisional/legacy diagnostic behavior.

### New Phase 5c invariants

- Passive LAN admission never derives peer identity from IP.
- A passive identity must already match a current/reachable LAN route for that `deviceId` and the live socket endpoint.
- Unadmitted passive application frames cannot reach App/BackgroundRuntime; identity has a bounded 5s deadline.
- Explicit P2P server mode bypasses the passive-LAN gate.
- A different endpoint cannot steal an inbound transient-recovery window.
- Same-peer outbound/inbound known-LAN races converge to the existing healthy inbound winner without a second socket or heartbeat.
- Immediate live messages are merged with persisted history instead of being overwritten during identity/history loading.

## Phase 5c verification chronology

- #89 expected red → missing coordinator adoption seam.
- #91 green → coordinator adoption verified.
- #93 expected red → inbound recovery endpoint race reproduced.
- #95 diagnostic red → previous socket address was lost before disconnect callback.
- #97 green → endpoint-bound inbound recovery verified.
- #99 expected red → shared passive admission seams missing.
- #101 functional gate behavior passed; only test dependency isolation failed.
- #103 rerun full green on unchanged code; first attempt's ApkFlinger Java heap OOM was transient, so Gradle config was not changed.
- #105 expected red → App promotion/context seams missing.
- #107 green → App policy/context/signaling ownership health verified.
- #109 expected red → history/live merge helper missing.
- #111 green → history/live convergence verified.
- #113 green → live App incoming LAN integration verified across JS/bundle/Android/APKs/artifacts.

## Exact next engineering step

First finish the Phase 5c merge procedure; then **stop networking refactoring and run the physical two-device ordinary-LAN certification matrix** before changing P2P ownership.

### Phase 5c merge procedure

1. This documentation-only checkpoint must receive its own full-green CI run.
2. Re-check `main` is still the Phase 5b base and the PR head is strictly ahead/behind=0.
3. Fast-forward `main` non-force to the exact tested documentation head; do not squash or create a different merge commit.
4. Verify PR #9 becomes `closed + merged=true` with the exact same SHA.
5. Raise G1-before-I2P progress only after that verified merge.

### Physical two-device LAN matrix after merge

Use two Android devices on the same ordinary Wi-Fi LAN:

1. Confirm both discover the expected stable peer over LAN.
2. A → B from a saved contact: one logical session; B passively promotes; correct stable identity; text both directions.
3. Clean disconnect and repeat B → A.
4. Simultaneous connect on both phones to the same saved peer: converge to one healthy session; no stuck `WIFI_CONNECTING`; no immediate disconnect.
5. Exercise a short signaling interruption/recovery when practical; successful recovery must not false-disconnect the UI.
6. File-transfer smoke test both directions while signaling remains connected.
7. On any failure capture current LAN IPs, initiator, `[G1/SIGNAL]`, coordinator transitions, and `[G1/LAN]` logs before further network code changes.

Do not proceed to P2P ownership migration until this matrix passes or failures are diagnosed.

## Known limitations to keep visible

- Current LAN identity admission is not cryptographic authentication. NSD/TXT + `deviceId` + route/socket matching remain spoofable by a capable LAN attacker.
- Cryptographic peer authentication/pairing is still mandatory before Internet-reachable I2P control signaling.
- General duplicate arbitration and make-before-break across transport families remain unfinished.
- Background UI re-attachment/process-death network ownership remains later work.
- P2P is still App-owned.
- Calls/call history, APK/APKS end-to-end validation, file performance, messaging completeness, UI, security/CI/release hardening remain later release gates.

## Progress metric

G1-before-I2P: **42%** until the Phase 5c documentation head is fully green and merged into `main`. After verified merge, raise cautiously to approximately **45%**; physical LAN certification is still the next release gate.

## Goal constraint

Finish and device-verify G1 P0/P1 reliability before implementing I2P. I2P remains a future independent overlay/transport. I2P Destination is route addressing, not peer identity. Cryptographic peer authentication is a hard prerequisite before Internet-reachable control signaling.
