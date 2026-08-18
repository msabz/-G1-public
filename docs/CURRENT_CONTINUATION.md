# G1 Current Continuation

This is the rolling resume pointer. Update it at every material phase transition. Dated checkpoint files remain the historical archive.

Last prepared: 2026-08-18 after physical ordinary-LAN testing.

## Read first

Master execution strategy:
GitHub issue #5 — `Master execution strategy: release-ready G1 → independent I2P overlay`.

Latest merged Phase 5c checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-18_INCOMING_LAN_ADOPTION_PHASE5C.md`.

Working stabilization branch:
`fix/lan-recovery-identity-replay`.

## Current verified baseline

- Canonical repository: `msabz/-G1-public`.
- Canonical branch: `main`.
- Current merged `main`: `07f889ec8378624f1322018f71e8193b7ce0e7a7` (`docs: checkpoint incoming LAN adoption Phase 5c`).
- PR #9 is merged at that exact SHA.
- GitHub Actions run #115 (`32107399461`) completed successfully on that exact SHA.
- CodeRabbit status is success.
- Phase 5c is therefore CI VERIFIED, but the physical LAN certification exposed defects that block calling it DEVICE VERIFIED.

## Physical ordinary-LAN evidence captured on 2026-08-18

### CONFIRMED working behavior

- Ordinary Wi-Fi LAN discovery works bidirectionally with stable peer records and current `wlan0` endpoints.
- A normal single-initiator LAN connection can remain stable with signaling connected, heartbeat running, recovery false, and two-way chat.
- Bidirectional simultaneous application traffic after a normally established session works: text in both directions, simultaneous text sends, and simultaneous voice-note sends were observed working.
- Voice calls can establish and remain active for multiple minutes with WebRTC/ICE connected; at least one later call and normal teardown completed without a transport failure.
- The native file/data plane remains separate from signaling.

### CONFIRMED defects / device symptoms

1. **Simultaneous-connect race is not reliably convergent.** Repeated physical tests produced a healthy-looking signaling state (`connected=true`, heartbeat running, recovery false) while only one chat direction delivered. The failed direction changed across attempts, so this is not a fixed-device defect.
2. **Repeated disconnect/reconnect can leave one side unable to initiate outbound while it can still accept inbound.** The symptom was observed with more than one peer and could reverse sides, so it is a session lifecycle/ownership problem rather than a Moto-only problem.
3. **Physical socket flapping/recovery occurred.** A captured A16 log shows outbound recovery sockets becoming active and then being replaced roughly every 5 seconds for multiple cycles before a later socket stabilized.
4. A captured failure showed `SEND type=chat` on an outbound recovery socket followed by `SESSION_DISCONNECTED` about 94 ms later. That proves a write attempt close to teardown, not remote receipt or packet loss cause.
5. Another captured sequence shows duplicate inbound/outbound races, `coordinator-rejected`, a later `disconnect-ack`, `SESSION_DISCONNECTED`, `Attempted to write to closed socket`, and `SESSION_DESTROYED reason=closeSignaling` before a later inbound session was admitted.

## Current causal analysis

### CONFIRMED code defect

`src/webrtc/signaling.js` creates a replacement outbound `SignalingSession` inside `beginTransientRecovery()` and activates it, which only announces `my-ip`. The live App sends `identity` after the original outbound connect, but the signaling-owned recovery path does not replay the G1 identity on the replacement socket.

The passive persistent-LAN receiver requires an `identity` frame within `PASSIVE_INBOUND_IDENTITY_TIMEOUT_MS = 5000`; `my-ip` is explicitly consumed only as metadata before identity. Therefore an outbound recovered socket is not self-sufficient as a valid new passive session on the peer.

Physical logs showing repeated ~5 s replacement cycles are strongly consistent with this defect. The exact remote rejection reason was not captured on the peer, so the physical symptom linkage remains `LIKELY`, while the missing recovery identity replay itself is `CONFIRMED` from code.

### CONFIRMED architecture weakness

`attachIncomingSession()` currently rejects any new inbound socket whenever a healthy `activeSession` already exists, before the passive identity is known. Deterministic same-peer duplicate arbitration exists at coordinator level only after identity/admission, so the signaling runtime can resolve simultaneous inbound/outbound races by arrival timing rather than stable peer identity. This is incompatible with the master invariant that simultaneous same-peer races converge deterministically.

### NOT CONFIRMED

- `react-native-tcp-socket` TCP KeepAlive being the root cause of the ~5 s cycle is not established. `SignalingSession.attachSocket()` already calls `setKeepAlive(true, 5000)` best-effort and the application heartbeat runs every 6 s. Do not change heartbeat cadence merely from the external-agent KeepAlive hypothesis.
- A `Broken pipe` or `Attempted to write to closed socket` establishes a write against a dead/closed socket, not why the peer closed it.

## Immediate stabilization strategy

Before P2P ownership migration, calls refactor, I2P, UI expansion, or performance work:

1. Make outbound signaling identity part of signaling-session ownership, so every original or recovered outbound session announces stable G1 identity before application frames.
2. Add deterministic tests for recovery identity replay and for application frames not being sent on an un-identified replacement.
3. Move simultaneous same-peer LAN duplicate arbitration to a point where stable identity is available; never let arrival order alone choose the surviving logical session.
4. Ensure disconnect/close clears both signaling runtime and coordinator logical ownership exactly once; repeated connect/disconnect must return both sides to a reusable IDLE state.
5. Add characterization/regression tests for repeated disconnect/reconnect and side-reversal.
6. Run full CI on the stabilization branch.
7. Only then repeat the physical ordinary-LAN matrix. No P2P migration until LAN race/recovery/reconnect passes.

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
