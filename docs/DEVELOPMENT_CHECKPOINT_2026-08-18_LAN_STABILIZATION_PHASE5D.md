# G1 Development Checkpoint — LAN Stabilization Phase 5d

Date: 2026-08-18

## Status

- Stage: Phase 5d post-physical-LAN stabilization.
- Code baseline merged through: `8b3e6aad2783697c2df0fb6278a7830b8cc998fe`.
- Rolling continuation documentation commit immediately after merge: `106df0ef95044d23cb3ff03f05e456d21ed431c4`.
- Verification level: **CODED / UNIT VERIFIED / CI VERIFIED**.
- **DEVICE VERIFIED: NO — physical revalidation of the fixed build is still required.**
- P2P ownership migration: blocked by the physical LAN gate.
- I2P production integration: blocked by Stage A release readiness and later cryptographic peer-authentication gate.

## Source-of-truth context

Master execution strategy: GitHub issue #5 — `Master execution strategy: release-ready G1 → independent I2P overlay`.

This checkpoint supersedes Phase 5c as the current networking code/CI checkpoint but does not erase the historical physical evidence captured before the fixes.

## Pre-fix physical evidence that drove Phase 5d

Physical ordinary-Wi-Fi tests on multiple peers established the following:

- normal single-initiator LAN sessions could be stable and carry two-way chat;
- simultaneous application traffic on an already healthy session could work in both directions;
- simultaneous *connection establishment* could converge into a healthy-looking signaling/heartbeat state while application chat worked only one way;
- the failed direction changed between attempts, so the defect was not tied to one specific device;
- repeated disconnect/reconnect could leave one side unable to initiate outbound while still accepting inbound, and the affected side could reverse;
- one captured A16 timeline showed recovered outbound sockets cycling roughly every 5 seconds before a later socket stabilized;
- one failed chat send was logged on a recovered socket about 94 ms before that socket disconnected;
- another captured sequence showed duplicate inbound rejection while outbound was active, a later `disconnect-ack`, socket disconnect, a closed-socket write, and a replacement session destroyed by deliberate App cleanup;
- call screenshots showed WebRTC/ICE connected while CallScreen still displayed a connecting state and the two local timers differed materially.

These observations are physical evidence of the symptoms. They do not by themselves prove TCP KeepAlive, Android, or packet loss as root cause.

## Confirmed code findings and fixes

### 1. Outbound recovery identity replay

Before Phase 5d, the initial App-driven outbound LAN connect sent the stable G1 `identity`, but signaling-owned transient recovery created a new outbound `SignalingSession` without returning through that App identity-send path. The passive persistent receiver requires identity within `PASSIVE_INBOUND_IDENTITY_TIMEOUT_MS = 5000` and treats `my-ip` only as route metadata.

Fix:

- `SignalingSession` remembers the last stable outbound identity;
- a fresh outbound session automatically replays it when attached;
- the historical explicit App identity send is idempotent when the same identity has already been replayed on that socket.

Regression coverage: `__tests__/signalingRecoveryIdentityReplay.test.js`.

### 2. Deterministic simultaneous LAN duplicate arbitration

Before Phase 5d, `signaling.js` rejected an inbound duplicate immediately whenever a healthy active signaling session existed. This could resolve a simultaneous same-peer outbound/inbound race by socket arrival order before stable identity reached coordinator arbitration.

Fix:

- a duplicate persistent inbound socket is provisionally inspected only long enough to obtain/validate stable identity;
- the existing coordinator `shouldYieldToInbound()` stable-deviceId rule decides the same-peer winner;
- a different endpoint/peer cannot replace the healthy active outbound session;
- only one provisional duplicate inspection is allowed at a time;
- the old outbound session remains alive until final inbound admission/coordinator adoption commits;
- failed final admission rolls back to the old healthy outbound session.

Regression coverage: `__tests__/signalingStableDuplicateRace.test.js` and `__tests__/lanPassiveAdmission.test.js`.

### 3. Frame preservation during race promotion

The provisional identity parser consumes bytes before the winning inbound socket becomes a normal `SignalingSession`. Phase 5d preserves:

- complete application frames coalesced after identity in the same TCP read;
- a partial trailing JSON frame split across the promotion boundary;
- the normal 64 KiB limit using UTF-8 byte length for complete provisional frames and residual data.

Regression coverage includes coalesced and segmented frame cases plus oversized multibyte UTF-8 input.

### 4. Graceful disconnect is not transient recovery

Physical logs showed deliberate disconnect control immediately followed by socket teardown and then recovery churn before delayed App cleanup.

Fix:

- sending `disconnect-request` or `disconnect-ack` marks graceful teardown pending;
- the expected socket close suppresses transient redial/recovery;
- normal App/coordinator cleanup remains responsible for the logical terminal state.

Regression coverage: `__tests__/signalingGracefulDisconnect.test.js`.

### 5. Call presentation evidence fix

The physical call screenshots showed established WebRTC/ICE while CallScreen still displayed connecting and used UI-mount-local timers.

Fix:

- CallScreen duration starts when `audioEngine === 'webrtc'`, not at screen mount;
- connected WebRTC presentation replaces the stale connecting label;
- duration resets when the engine leaves WebRTC.

Limitation: this is **not** the final call lifecycle architecture. A later peer-connection `disconnected` / `failed` / `closed` event still needs explicit durable propagation through the future unified call state machine in Stage A8.

### 6. Device diagnostics

Developer Diagnostics now surfaces and refreshes:

- signaling peer and direction;
- passive admission required/accepted state;
- heartbeat/recovery state;
- graceful-disconnect pending state;
- current peer transport endpoints.

This is intended to make the next physical certification causal rather than inference-driven.

## GitHub delivery and automated evidence

### PR #10 — first Phase 5d stabilization

- Title: `fix: stabilize LAN recovery and simultaneous session races`.
- Final PR head: `b07e44b0fff611cfdb44a9c5ef39943eeb19293e`.
- GitHub Actions: run #141 / `32145478513` — success.
- Coverage of the pipeline: JavaScript unit tests, RN production bundle, Android unit tests, debug APK, release APK, debug artifact, release artifact.
- Squash merge: `efb58b20281e363d4a9517260f6ff19a3d053bd2`.

### PR #11 — follow-up race hardening

- Title: `fix: harden LAN race promotion edge cases`.
- Final PR head: `81f255cf6a2234fe02839a6d59b4aa682fda0196`.
- GitHub Actions: run #158 / `32148524198` — success.
- JavaScript unit tests: success.
- Production RN bundle: success.
- Android unit tests: success.
- Debug APK: success.
- Release APK: success.
- Debug/release artifact uploads: success.
- CodeRabbit status: success; no review threads were returned at merge time.
- Squash merge: `8b3e6aad2783697c2df0fb6278a7830b8cc998fe`.

## Explicitly rejected/unsupported causal claims

- Do not claim TCP KeepAlive caused the historical ~5-second flap. `SignalingSession.attachSocket()` already requests TCP keepalive best-effort and signaling owns a 6-second application heartbeat. No raw evidence established KeepAlive as the cause.
- Do not claim a `Broken pipe` or `Attempted to write to closed socket` explains why the peer closed. It establishes only a write against a dead/closed socket.
- Do not claim the fixed LAN code is DEVICE VERIFIED until it is exercised on the target phones.

## Physical acceptance matrix required next

Run on the merged Phase 5d build, preferably with synchronized diagnostics/logs when a case fails:

1. normal A→B LAN connect, two-way text, stable heartbeat;
2. clean disconnect, then B→A, two-way text;
3. simultaneous connect, repeated multiple times — exactly one logical healthy session and two-way text every time;
4. repeated disconnect/reconnect with alternating initiator — neither side loses outbound capability;
5. transient signaling interruption/recovery where practical — recovered session remains admitted/usable and no repeated ~5-second recovery loop;
6. graceful disconnect — no unwanted recovery redial after disconnect request/ack;
7. call smoke — establish, hold, terminate, then two-way text; signaling stays healthy; CallScreen connected presentation/timer behaves coherently;
8. file smoke both directions while signaling remains connected and responsive.

Failure capture should include current LAN endpoints, initiator, Developer Diagnostics from both peers, `[G1/SIGNAL]`, coordinator state transitions where available, and `[G1/LAN]` before another network code change.

## Next architecture gate after device PASS

Only after the matrix passes:

- continue Stage A networking ownership migration into P2P using the same coordinator/session invariants;
- preserve LAN and P2P as independent route candidates;
- no second heartbeat/session/recovery owner;
- retain make-before-break and bounded recovery;
- keep native file transfer independent from signaling.

The final project goal remains the master issue #5 definition: release-ready existing G1 first, then an independent I2P overlay route with cryptographically trustworthy peer identity before Internet-facing signaling.
