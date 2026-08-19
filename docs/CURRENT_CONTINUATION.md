# G1 Current Continuation

This is the rolling resume pointer. Update it at every material phase transition. Dated checkpoint files remain the historical archive.

Last prepared: 2026-08-19 after Phase 6b-b PR #18 reached CI green and the first automated device installation attempt exposed a G1LAB installer capability defect.

## Read first

Latest Phase 6b-b checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-19_PHASE6BB_PR18.md`

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
4. direct human observation during a controlled physical test;
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

`signaling.js` remains the one socket/session/heartbeat/same-route-recovery owner.

### Stage A5 ownership seams

PR #13 — Phase 6a — merged and CI verified:
- `WifiDirectTransportAdapter` owns Android P2P route lifecycle;
- raw Wi-Fi Direct MAC / `deviceAddress` remains route metadata, never stable peer identity;
- `ConnectionCoordinator.connectP2pPeer()` owns logical P2P connection state;
- `signaling.js` remains the signaling socket/session/heartbeat/recovery owner.

PR #14 — Phase 6b-a — merged and CI verified:
- introduced `p2pAppBridge` as the App→Coordinator handoff seam;
- stable G1 identity stays separate from P2P addressing;
- logical connect delegates toward the coordinator boundary.

## Stable CI Debug signing/update gate — CLOSED

PR #15 established stable protected CI Debug signing and advancing CI `versionCode`.
Run #197 installed cleanly; run #201 updated over it without uninstall, and the physical tester confirmed the in-place update path worked.
PR #16 documented that result and was merged.

Status: **DEVICE VERIFIED on the tested device** for stable CI Debug update continuity.

Do not expose or commit signing secrets/private key material.

## Wi-Fi Direct physical baseline — DEVICE VERIFIED ON TESTED PAIR

Test devices:
- Samsung A16
- Samsung A06

The pre-Phase-6b-b build physically established:
- bidirectional peer visibility/discovery;
- real Wi-Fi Direct group formation;
- A06 Group Owner / A16 client in the controlled connection test;
- G1 connected/chat state;
- bidirectional basic chat;
- transient signaling recovery on one observed Broken-pipe event.

Status: **DEVICE VERIFIED** for that tested baseline on the Samsung A16+A06 pair.

This is not `CROSS-OEM VERIFIED`.

Do not repeatedly rerun the old baseline before installing the new code under test.

## PR #17 diagnostics

PR #17 (`diag: capture Wi-Fi Direct discovery evidence`) remains diagnostic work, not proof of a production discovery defect.

Earlier A16 shell-agent zero-sample results were false negatives relative to direct UI observation. Do not resume the obsolete hypothesis that A16 cannot discover A06.

Decide later whether PR #17 is useful enough to retain/merge or should be retired; do not merge it solely because CI is green.

## Current engineering phase — Stage A5 / Phase 6b-b

PR #18:
`Phase 6b-b: migrate outbound P2P ownership to coordinator`

Branch:
`phase6b-b/outbound-p2p-coordinator`

CI-verified head at this checkpoint:
`c31a4ef7dd5dee82375997deb6d78736093f8274`

PR #18 remains **open and draft**. Do not merge before physical regression.

### Implemented live slice

For outbound Wi-Fi Direct where stable G1 identity is provable:
- `App.js` delegates through `p2pAppBridge` to `ConnectionCoordinator`;
- coordinator ownership prevents the legacy App `PEER_CONNECTED` path from opening a second signaling path;
- coordinator-owned disconnect does not fall back to legacy App reconnect;
- coordinator-owned cleanup is awaited before App finalizes logical disconnect;
- raw P2P route addresses are rejected as logical identities;
- incoming invitations and identity-unproven P2P peers remain on the legacy path for this surgical slice;
- incoming invitation handling, scanning, manual LAN connection, and Bluetooth connection are blocked while an outbound coordinator P2P attempt is active, preventing concurrent control owners.

The UI remains on the conversations/contact flow rather than intentionally switching to a full-screen legacy connection owner during this coordinator-owned outbound attempt.

### Verification

Final CI run: **#242 / SUCCESS**.

Verified on the same head:
- JavaScript tests;
- RN bundle;
- Android tests;
- Debug APK build;
- stable CI Debug signing/certificate verification;
- Release APK build;
- artifact upload.

Debug artifact:
- `G1-DirectChat-debug-apk`
- artifact id `9385559100`
- versionCode `242`

Current code grade: **CODED / UNIT VERIFIED / CI VERIFIED**.

Current device grade for Phase 6b-b: **NOT DEVICE VERIFIED**.

## Immediate blocker — G1LAB INSTALL_RUN_ARTIFACT

Private G1LAB command:
`phase6bb-install-031`

Target:
A16 + A06.

Both persistent daemons accepted the command and correctly produced one `STARTED` followed by `FAILED`.

Both failed at the same installer boundary:
`RuntimeError: pm install -r failed:`

No actionable `pm` stdout/stderr was preserved in the report.

Interpretation:
- command bus and persistent daemons are functioning;
- failure reporting is functioning;
- the `INSTALL_RUN_ARTIFACT` capability itself is incomplete/defective;
- do not assume build 242 is installed on either phone;
- do not classify PR #18 as DEVICE VERIFIED;
- do not make manual APK installation the normal workaround.

The private lab repository contains the detailed continuation and must be read before resuming device work.

## G1LAB must evolve from real usage

The lab is an engineering system, not a static harness.

Operational rule:

`real failure → preserve evidence → identify causal lab weakness → improve lab code/protocol → add regression coverage → deploy runtime update → retry original mission → verify improvement`

An automatable lab capability should be repaired rather than replaced by repeated manual work.

Human interaction is reserved for genuinely physical/system-consent operations that Android does not permit the lab to automate safely.

## Immediate execution order for next session

1. Read this file and `docs/DEVELOPMENT_CHECKPOINT_2026-08-19_PHASE6BB_PR18.md`.
2. Read private `msabz/shizuku-controller/CURRENT_CONTINUATION.md`.
3. Do **not** edit PR #18 first; its code and CI are already green.
4. Diagnose and repair G1LAB `INSTALL_RUN_ARTIFACT` using `phase6bb-install-031` as the real failure case.
5. Improve installer evidence so stdout/stderr/exit status and package-version verification are preserved.
6. Add regression coverage for the installer capability.
7. Safely update the persistent lab runtime on A16/A06.
8. Retry build 242 with a **new command ID**; never reuse `phase6bb-install-031`.
9. Verify `com.directchat` versionCode 242 on both devices.
10. Run one focused outbound Phase 6b-b P2P regression on the A16+A06 pair.
11. If device evidence passes, checkpoint as DEVICE VERIFIED and then decide whether PR #18 is ready to merge.
12. If device evidence fails, fix only the causal Phase 6b-b defect and repeat the targeted regression.

After Phase 6b-b, continue Stage A in the planned order. Do not begin I2P until the full Stage A release-ready gate is satisfied.

## Invariants

- stable peer identity is independent of route/IP/MAC;
- LAN and Wi-Fi Direct remain independent transport candidates;
- signaling/control stays separate from bulk data;
- one owner per concern;
- make-before-break where applicable;
- bounded recovery;
- security/consent first;
- Shizuku/rish is lab-only and never a G1 production dependency.

## Security note

Do not store secrets, credentials, private keys, signing material, raw MAC addresses, Android IDs, serials, IMEIs, or equivalent unique device identifiers in the public repository.
