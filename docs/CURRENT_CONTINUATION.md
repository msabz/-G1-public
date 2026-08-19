# G1 Current Continuation

This is the rolling resume pointer. Update it at every material phase transition. Dated checkpoint files remain the historical archive.

Last prepared: 2026-08-19 after stable CI update continuity, Wi-Fi Direct physical recovery/verification on the Samsung A16+A06 pair, bidirectional chat verification, and device-agent conformance hardening.

## Read first

Master execution strategy:
GitHub issue #5 — `Master execution strategy: release-ready G1 → independent I2P overlay`.

Historical Phase 5c checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-18_INCOMING_LAN_ADOPTION_PHASE5C.md`.

Phase 5d checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-18_LAN_STABILIZATION_PHASE5D.md`.

## Evidence vocabulary

Use: `CONFIRMED`, `LIKELY`, `HYPOTHESIS`, `GOAL`, `NOT VERIFIED`.

Completion grades:
- `CODED`
- `UNIT VERIFIED`
- `CI VERIFIED`
- `DEVICE VERIFIED`
- `CROSS-OEM VERIFIED`
- `RELEASE READY`

Priority of truth:
1. current code/tests;
2. CI on the same SHA/tree;
3. reproducible raw device evidence;
4. direct human observation during the controlled physical test;
5. this rolling continuation;
6. dated checkpoints/handoffs;
7. external-agent interpretation.

CI success is not physical-device success.

## Verified baseline

### Ordinary LAN — Phase 5d

Phase 5d remains **CODED / UNIT VERIFIED / CI VERIFIED / DEVICE VERIFIED** for the tested matrix.

Previously revalidated physically after PR #12:
- two-way chat;
- simultaneous connect;
- repeated disconnect/reconnect;
- files;
- voice/video call convergence;
- busy behavior;
- foreground resume after removing one app task while the peer remained in-session.

Signaling remains the one socket/session/heartbeat/same-route-recovery owner.

Do not revive the historical TCP-KeepAlive root-cause claim; physical evidence did not establish it.

### Stage A5 ownership seams

PR #13 — Phase 6a — merged and CI verified:
- coordinator-owned Wi-Fi Direct boundary;
- `WifiDirectTransportAdapter` owns Android P2P route lifecycle;
- raw Wi-Fi Direct MAC / `deviceAddress` remains route metadata, never stable peer identity;
- `ConnectionCoordinator.connectP2pPeer()` owns logical P2P connection state;
- `signaling.js` remains the single signaling socket/session/heartbeat/recovery owner.

PR #14 — Phase 6b-a — merged and CI verified:
- introduced `p2pAppBridge` as the App→Coordinator handoff seam;
- stable G1 identity stays separate from P2P addressing;
- logical connect delegates toward the coordinator boundary.

Live App P2P ownership is still only partially migrated; Phase 6b-b remains the next engineering migration step.

## Stable CI Debug signing/update gate — CLOSED

The earlier CI Debug update problem is resolved.

- PR #15 made CI Debug APK updates installable with a stable protected development signing identity and CI-derived advancing `versionCode`.
- Run #197 installed cleanly.
- Run #201 installed over #197 without uninstall and preserved the application update path.
- The human tester physically confirmed the in-place update worked.
- PR #16 documented the verified stable CI update continuity and was merged.

Status: **DEVICE VERIFIED on the tested device** for stable CI Debug in-place update continuity.

Do not expose or commit signing secrets/private key material.

## Wi-Fi Direct / P2P physical status — RECOVERED AND VERIFIED ON TESTED PAIR

The earlier statement that P2P discovery was not device verified is superseded by later controlled physical evidence.

Test devices:
- Samsung A16
- Samsung A06

Installed tested build:
- G1 `versionName 1.0`
- `versionCode 215`

### Discovery

CONFIRMED on the tested pair:
- A06 discovered A16 in machine-observed P2P evidence.
- The human tester directly observed A16 discover A06 in repeated scan rounds.
- Earlier A16 shell-agent reports showing zero peers/zero samples were diagnostic-capture false negatives and must not be interpreted as proof that A16 discovery failed.

Status: **DEVICE VERIFIED** for bidirectional peer visibility/discovery on the tested A16+A06 pair.

### Real P2P connection/group formation

Mission `p2p-connect-observe-006` physically established a real Wi-Fi Direct group.

CONFIRMED:
- A06 became Group Owner.
- A16 became the client.
- Android reported `groupFormed: true` on both sides.
- G1 reached connected/chat state.
- No terminal disconnect was observed during that connection check.

Status: **DEVICE VERIFIED** for P2P group/connection establishment on the tested pair.

### Chat over Wi-Fi Direct

The physical tester subsequently confirmed bidirectional chat succeeded over the Wi-Fi Direct session and requested that this milestone be treated as passed rather than repeatedly rerun.

Supporting machine evidence from the prior chat mission included:
- formed P2P group retained;
- G1 connected state retained;
- signaling session became active;
- one transient `Broken pipe` socket error recovered and the session continued;
- outbound chat send evidence was captured.

Status: **DEVICE VERIFIED** for bidirectional chat over Wi-Fi Direct on the tested A16+A06 pair.

This is not `CROSS-OEM VERIFIED`; both devices are Samsung.

## P2P diagnostic branch / PR #17

PR #17 (`diag: capture Wi-Fi Direct discovery evidence`) remains diagnostic work, not proof of a production discovery defect.

Its CI head passed, but physical A16 capture behavior demonstrated that the diagnostic harness/agent could miss scan-period evidence while the UI visibly discovered the peer.

Therefore:
- do not continue debugging the hypothesis “A16 cannot discover A06”;
- do not treat zero A16 diagnostic samples as authoritative negative P2P evidence;
- decide separately whether PR #17 should be retained/merged as useful diagnostics or closed/retired;
- do not merge it merely because CI is green.

## Device-lab agent status

The physical-device evidence agents for A16 and A06 were hardened and then passed a final conformance check.

Current agent contract:
- fresh session evidence window per command;
- canonical separation of `human_observed`, `machine_observed`, and `not_observed`;
- top-level capture-health reporting;
- `COMPLETE / PARTIAL / FAILED / BLOCKED` grading from actual evidence;
- no stale-log reuse;
- no arbitrary GitHub comment execution;
- no unnecessary full-system logcat for status-only missions;
- historical command IDs are not rerun;
- duplicate execution of a completed command is prevented.

The final conformance mission completed successfully on both devices. No additional agent-conformance loop is required unless an agent/model/prompt/control protocol is materially reset or changed.

Shizuku/rish remains a lab diagnostic tool only and must never become a G1 production dependency.

## Current engineering phase — Stage A5 / P2P migration

The physical gate that paused Phase 6b-b is now cleared for the tested A16+A06 pair:
- discovery works;
- P2P group formation works;
- G1 reaches connected state;
- bidirectional chat works.

Next engineering step: resume **Phase 6b-b live App→Coordinator P2P ownership migration** using the established surgical strategy.

Do not big-bang rewrite.

Required migration discipline:
1. re-read current main HEAD and ownership map;
2. identify the smallest live App P2P responsibility that can move behind `p2pAppBridge` / coordinator without changing behavior;
3. add/retain characterization coverage;
4. make one migration;
5. run tests/CI;
6. fix only causal failures;
7. green checkpoint;
8. then proceed to the next ownership slice.

Keep these invariants:
- stable peer identity is independent of route/IP/MAC;
- LAN and Wi-Fi Direct remain independent transport candidates;
- signaling/control stays separate from bulk data;
- one owner per concern;
- make-before-break where applicable;
- bounded recovery;
- security/consent first.

## P2P UX requirement

The full-screen legacy `IdleScreen` transition during Wi-Fi Direct discovery/connection is not desired for normal use.

Normal connection should remain on the conversations/contact UI while discovery, group negotiation, network bind, and signaling run in the background. A compact per-peer/connection progress indication is acceptable. Android system permission/confirmation UI remains outside application control.

Remove the legacy full-screen transition as part of the live-path ownership migration, not as a workaround for transport behavior.

## Immediate execution order for next session

1. Verify current `main` HEAD and CI state before editing.
2. Review PR #17 status but do not merge automatically.
3. Resume Phase 6b-b with the smallest behavior-preserving App→Coordinator P2P handoff slice.
4. Add/maintain regression coverage around the moved ownership boundary.
5. Push → CI → causal fixes only → green checkpoint.
6. Use the physical A16/A06 lab only when the next code slice requires device evidence; do not repeat already-verified discovery/connection/chat milestones by default.

After P2P ownership migration, continue Stage A in the planned order:
- background/process lifecycle ownership;
- complete call state machine and durable call history;
- file-transfer isolation/performance and messaging completeness;
- UI/UX and release/security/CI hardening.

Do not begin I2P yet. Stage B remains gated on the full Stage A release-ready bar.

I2P, when reached, is an independent overlay route. I2P destination is route addressing, not peer identity. Cryptographic peer authentication/pairing is a hard prerequisite before Internet-reachable control signaling.

## Security note

Do not store secrets, credentials, private keys, signing material, raw MAC addresses, Android IDs, serials, IMEIs, or equivalent unique device identifiers in the public repository.
