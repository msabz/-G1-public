# G1 Current Continuation

This is the rolling resume pointer. Update it at every material phase transition. Dated checkpoint files remain the historical archive.

Last prepared: 2026-08-18 after Phase 5d LAN stabilization merge.

## Read first

Master execution strategy:
GitHub issue #5 — `Master execution strategy: release-ready G1 → independent I2P overlay`.

Historical Phase 5c checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-18_INCOMING_LAN_ADOPTION_PHASE5C.md`.

Current Phase 5d checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-18_LAN_STABILIZATION_PHASE5D.md`.

## Current verified baseline

- Canonical repository: `msabz/-G1-public`.
- Canonical branch: `main`.
- Current merged code baseline before this documentation update: `8b3e6aad2783697c2df0fb6278a7830b8cc998fe` (`fix: harden LAN race promotion edge cases`).
- PR #10 merged the first Phase 5d stabilization at `efb58b20281e363d4a9517260f6ff19a3d053bd2`.
- PR #11 merged the follow-up race hardening at `8b3e6aad2783697c2df0fb6278a7830b8cc998fe`.
- PR #10 final PR-head validation: `b07e44b0fff611cfdb44a9c5ef39943eeb19293e`, GitHub Actions run #141 (`32145478513`), success.
- PR #11 final PR-head validation: `81f255cf6a2234fe02839a6d59b4aa682fda0196`, GitHub Actions run #158 (`32148524198`), success. JavaScript tests, production bundle, Android unit tests, debug APK, release APK, and both APK artifacts completed successfully.
- CodeRabbit status on the final PR #11 head was success, with no review threads returned at merge time.
- Phase 5d is therefore CODED / UNIT VERIFIED / CI VERIFIED. It is **not DEVICE VERIFIED after the fixes yet**.

## Physical ordinary-LAN evidence captured before Phase 5d fixes

### CONFIRMED working behavior

- Ordinary Wi-Fi LAN discovery works bidirectionally with stable peer records and current `wlan0` endpoints.
- A normal single-initiator LAN connection can remain stable with signaling connected, heartbeat running, recovery false, and two-way chat.
- Bidirectional simultaneous application traffic after a normally established session works: text in both directions, simultaneous text sends, and simultaneous voice-note sends were observed working.
- Voice calls can establish and remain active for multiple minutes with WebRTC/ICE connected; at least one later call and normal teardown completed without a transport failure.
- The native file/data plane remains separate from signaling.

### CONFIRMED pre-stabilization device symptoms

1. **Simultaneous-connect race was not reliably convergent.** Repeated physical tests produced a healthy-looking signaling state (`connected=true`, heartbeat running, recovery false) while only one chat direction delivered. The failed direction changed across attempts, so this was not a fixed-device defect.
2. **Repeated disconnect/reconnect could leave one side unable to initiate outbound while it could still accept inbound.** The symptom was observed with more than one peer and could reverse sides, so it was a session lifecycle/ownership problem rather than a Moto-only problem.
3. **Physical socket flapping/recovery occurred.** A captured A16 log showed outbound recovery sockets becoming active and then being replaced roughly every 5 seconds for multiple cycles before a later socket stabilized.
4. A captured failure showed `SEND type=chat` on an outbound recovery socket followed by `SESSION_DISCONNECTED` about 94 ms later. That proves a write attempt close to teardown, not remote receipt or packet-loss cause.
5. Another captured sequence showed duplicate inbound/outbound races, `coordinator-rejected`, a later `disconnect-ack`, `SESSION_DISCONNECTED`, `Attempted to write to closed socket`, and `SESSION_DESTROYED reason=closeSignaling` before a later inbound session was admitted.

## Phase 5d stabilization implemented

### CONFIRMED fixed in code and automated tests

- **Outbound recovery identity replay:** recovered outbound signaling sessions replay the last stable local G1 `identity`; the historical explicit App identity send is idempotent. Recovery no longer depends on returning through the initial App connect path.
- **Stable-identity simultaneous LAN arbitration:** a duplicate persistent inbound candidate is held only long enough to validate stable identity, then the coordinator stable-deviceId rule decides whether inbound or outbound survives instead of raw socket arrival order.
- **Same-peer guard:** a known but different LAN peer cannot replace a healthy active outbound session merely because its stable-id ordering would prefer inbound.
- **Single provisional inspector:** only one duplicate inbound candidate can be in provisional identity inspection at a time.
- **Make-before-break duplicate promotion:** the old outbound session remains alive until normal inbound admission/coordinator adoption commits. If final admission fails, the candidate is destroyed and the healthy outbound session is restored.
- **Graceful disconnect classification:** `disconnect-request` / `disconnect-ack` socket closure suppresses transient recovery so the runtime does not redial immediately before deliberate App cleanup.
- **Frame preservation:** both complete coalesced frames and a partial trailing JSON frame survive provisional-parser promotion into the real `SignalingSession`.
- **UTF-8 frame limit parity:** provisional duplicate parsing applies the same 64 KiB signaling limit by UTF-8 byte size to complete frames and residual data.
- **Call presentation correction:** CallScreen no longer starts duration at screen mount, shows connected presentation once `audioEngine` reaches WebRTC, and resets duration when the engine leaves WebRTC. This is a presentation fix only, not the final A8 call-state-machine migration.
- **Developer diagnostics:** signaling direction, passive-admission state, recovery state, graceful-disconnect state, and live health refresh are exposed for device evidence.

## Remaining call-state limitation

`audioEngine === 'webrtc'` is still only an establishment/backend signal, not a complete durable RTC lifecycle state machine. A later peer-connection `disconnected` / `failed` / `closed` transition still requires explicit propagation to App/CallScreen. Per the master strategy, full `CallRuntime` / App / native call / persistence convergence remains Stage A8 after networking ownership is device-stabilized. Do not mark the call subsystem release-ready from the current presentation fix.

## Causal analysis status

### Resolved code findings

Before Phase 5d, `beginTransientRecovery()` created replacement outbound sessions without replaying identity, while passive persistent LAN required identity within five seconds. That code defect is fixed and regression-tested.

Before Phase 5d, a healthy active outbound session caused a new inbound socket to be rejected before stable identity was available, so simultaneous same-peer races could be resolved by arrival timing. That weakness is replaced by provisional identity validation plus deterministic stable-id arbitration with same-peer, concurrency, rollback, segmentation, and UTF-8 hardening.

### NOT CONFIRMED

- `react-native-tcp-socket` TCP KeepAlive being the root cause of the historical ~5 s cycle is not established. `SignalingSession.attachSocket()` already calls `setKeepAlive(true, 5000)` best-effort and the application heartbeat runs every 6 s. Do not change heartbeat cadence merely from the external-agent KeepAlive hypothesis.
- A `Broken pipe` or `Attempted to write to closed socket` establishes a write against a dead/closed socket, not why the peer closed it.

## Immediate execution gate

The next engineering action requiring new evidence is physical ordinary-LAN revalidation on the merged Phase 5d code:

1. normal A→B and B→A LAN connect + two-way chat;
2. repeated simultaneous connects — deterministic convergence and two-way chat every time;
3. repeated disconnect/reconnect with both initiator roles — neither side loses outbound ability;
4. transient recovery — no repeated identity-timeout-style flap and the recovered route remains usable;
5. graceful disconnect — no unwanted recovery redial after request/ack;
6. call smoke — signaling stays healthy and call UI reflects establishment/teardown correctly;
7. file smoke both directions while signaling remains healthy.

Do not begin P2P ownership migration until this corrected LAN path becomes DEVICE VERIFIED.

## Release order remains unchanged

Stage A: finish and device-verify G1 core reliability (networking ownership, background lifecycle, calls/call history, APK/APKS correctness, file-transfer isolation/performance, messaging completeness, UI/UX, security/CI/release hardening).

Stage B: only after Stage A is release-ready, add I2P as an independent overlay route. I2P destination is route addressing, not peer identity. Cryptographic peer authentication/pairing is a hard prerequisite before Internet-reachable control signaling.

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
