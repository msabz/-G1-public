# G1 Current Continuation

This is the rolling resume pointer. Update it at every material phase transition. Dated checkpoint files remain the historical archive.

Last prepared: 2026-08-18 during post-physical-LAN Phase 5d stabilization.

## Read first

Master execution strategy:
GitHub issue #5 — `Master execution strategy: release-ready G1 → independent I2P overlay`.

Historical Phase 5c checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-18_INCOMING_LAN_ADOPTION_PHASE5C.md`.

Current follow-up PR:
PR #11 — `fix: preserve segmented frames during LAN race promotion`.

## Current verified baseline

- Canonical repository: `msabz/-G1-public`.
- Canonical branch: `main`.
- Current merged `main`: `efb58b20281e363d4a9517260f6ff19a3d053bd2` (`fix: stabilize LAN recovery and simultaneous session races`).
- PR #10 is merged at that SHA via squash.
- Final PR-head validation for PR #10 ran on `b07e44b0fff611cfdb44a9c5ef39943eeb19293e`: GitHub Actions run #141 (`32145478513`) completed successfully, including JavaScript tests, production bundle, Android unit tests, debug APK, release APK, and artifacts.
- CodeRabbit completed its full review successfully and identified additional race-hardening findings. Those findings are being handled in PR #11 before new device verification.
- Phase 5d is therefore CODED / CI VERIFIED at the PR #10 tree level, but it is not DEVICE VERIFIED after the fixes yet.

## Physical ordinary-LAN evidence captured on 2026-08-18

### CONFIRMED working behavior

- Ordinary Wi-Fi LAN discovery works bidirectionally with stable peer records and current `wlan0` endpoints.
- A normal single-initiator LAN connection can remain stable with signaling connected, heartbeat running, recovery false, and two-way chat.
- Bidirectional simultaneous application traffic after a normally established session works: text in both directions, simultaneous text sends, and simultaneous voice-note sends were observed working.
- Voice calls can establish and remain active for multiple minutes with WebRTC/ICE connected; at least one later call and normal teardown completed without a transport failure.
- The native file/data plane remains separate from signaling.

### CONFIRMED pre-stabilization device symptoms

1. **Simultaneous-connect race was not reliably convergent before Phase 5d.** Repeated physical tests produced a healthy-looking signaling state (`connected=true`, heartbeat running, recovery false) while only one chat direction delivered. The failed direction changed across attempts, so this was not a fixed-device defect.
2. **Repeated disconnect/reconnect could leave one side unable to initiate outbound while it could still accept inbound.** The symptom was observed with more than one peer and could reverse sides, so it was a session lifecycle/ownership problem rather than a Moto-only problem.
3. **Physical socket flapping/recovery occurred.** A captured A16 log showed outbound recovery sockets becoming active and then being replaced roughly every 5 seconds for multiple cycles before a later socket stabilized.
4. A captured failure showed `SEND type=chat` on an outbound recovery socket followed by `SESSION_DISCONNECTED` about 94 ms later. That proves a write attempt close to teardown, not remote receipt or packet loss cause.
5. Another captured sequence showed duplicate inbound/outbound races, `coordinator-rejected`, a later `disconnect-ack`, `SESSION_DISCONNECTED`, `Attempted to write to closed socket`, and `SESSION_DESTROYED reason=closeSignaling` before a later inbound session was admitted.

## Phase 5d stabilization now implemented

### CONFIRMED fixed in code and automated tests

- **Outbound recovery identity replay:** recovered outbound signaling sessions now replay the last stable local G1 `identity`; the historical explicit App identity send remains idempotent. Recovery no longer depends on returning through the initial App connect path.
- **Stable-identity simultaneous LAN arbitration:** a duplicate persistent inbound candidate is held only long enough to validate stable identity, then the coordinator stable-deviceId rule decides whether inbound or outbound survives instead of raw socket arrival order.
- **Graceful disconnect classification:** `disconnect-request` / `disconnect-ack` socket closure suppresses transient recovery so the runtime does not redial immediately before deliberate App cleanup.
- **Coalesced frame preservation:** complete application frames that arrive in the same TCP read after identity are preserved through race promotion.
- **Call presentation correction:** CallScreen no longer starts duration at screen mount and no longer displays the voice call as permanently “connecting” after `audioEngine` reaches the connected WebRTC state. This is a presentation fix only, not the final A8 call-state-machine migration.
- **Developer diagnostics:** signaling direction, passive-admission state, recovery state, and graceful-disconnect state are visible/copied for device evidence.

### Follow-up hardening in PR #11

CodeRabbit and self-review found additional edge cases in the provisional duplicate-inbound path. PR #11 addresses them before physical retest:

- preserve a partial trailing JSON frame across promotion when a TCP read contains `identity\n` plus only the beginning of the next frame;
- apply the 64 KiB signaling limit by UTF-8 byte size to both complete provisional frames and the residual buffer;
- prevent a different LAN peer from replacing the current healthy outbound session merely because its stable-id ordering would prefer inbound;
- allow only one provisional duplicate-inbound inspection at a time;
- use make-before-break during duplicate promotion: keep the old outbound session alive until normal inbound admission/coordinator adoption commits, and roll back to the old session if final admission fails;
- reset CallScreen duration when WebRTC leaves the connected engine;
- refresh Developer Diagnostics signaling health while the modal remains open.

## Remaining call-state limitation

CodeRabbit correctly noted that `audioEngine === 'webrtc'` is still only a backend/establishment signal, not a complete durable RTC lifecycle state machine. A later peer-connection `disconnected`/`failed`/`closed` transition can still require explicit propagation to App/CallScreen. Per the master strategy, the full `CallRuntime` / App / native call / persistence convergence remains Stage A8 after networking ownership is stabilized; do not falsely mark the call subsystem release-ready from the current presentation fix.

## Causal analysis status

### Resolved code findings

Before Phase 5d, `beginTransientRecovery()` created replacement outbound sessions without replaying identity, while passive persistent LAN required identity within 5 seconds. That code defect is now fixed and regression-tested.

Before Phase 5d, a healthy active outbound session caused a new inbound socket to be rejected before stable identity was available, so simultaneous same-peer races could be resolved by arrival timing. That weakness is now replaced by provisional identity validation plus deterministic stable-id arbitration, with PR #11 adding rollback/concurrency/different-peer hardening.

### NOT CONFIRMED

- `react-native-tcp-socket` TCP KeepAlive being the root cause of the historical ~5 s cycle is not established. `SignalingSession.attachSocket()` already calls `setKeepAlive(true, 5000)` best-effort and the application heartbeat runs every 6 s. Do not change heartbeat cadence merely from the external-agent KeepAlive hypothesis.
- A `Broken pipe` or `Attempted to write to closed socket` establishes a write against a dead/closed socket, not why the peer closed it.

## Immediate execution gate

1. Finish PR #11 and require full Build & Validate CI on its final head.
2. Merge only if CI is green and no unresolved causal review finding remains in the changed networking path.
3. Then repeat the physical ordinary-LAN matrix: single-direction connect both ways, simultaneous connect, repeated disconnect/reconnect, transient recovery, graceful disconnect, two-way chat, call smoke, and file smoke.
4. Do not begin P2P ownership migration until the corrected LAN race/recovery/reconnect path becomes DEVICE VERIFIED.

## Release order remains unchanged

Stage A: finish and device-verify G1 core reliability (networking ownership, background lifecycle, calls/call history, APK/APKS correctness, file-transfer isolation/performance, messaging completeness, UI/UX, security/CI/release hardening).

Stage B: only after Stage A is release-ready, add I2P as an independent overlay route. I2P destination is route addressing, not peer identity. Cryptographic peer authentication/pairing is a hard prerequisite before Internet-reachable control signaling.

## Evidence rules

Use: `CONFIRMED`, `LIKELY`, `HYPOTHESIS`, `GOAL`, `NOT VERIFIED`.

Priority of truth:
1. current code/tests;
2. CI on the same SHA;
3. reproducible raw device evidence;
4. this rolling continuation;
5. dated checkpoints/handoffs;
6. external-agent interpretations.

Do not store secrets or private identity material in the public repository.
