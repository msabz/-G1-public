# G1 Current Continuation

This is the rolling resume pointer. Update it at every material phase transition. Dated checkpoint files remain the historical archive.

Last prepared: 2026-08-20 after Phase 6b-b PR #18 remained CI green, the legacy G1LAB installer failure was reproduced and confirmed not to install build 242, and the protocol-2.2 staged-installer/self-update repair was merged in the private lab repository.

## Read first

Latest Phase 6b-b checkpoint:
`docs/DEVELOPMENT_CHECKPOINT_2026-08-19_PHASE6BB_PR18.md`

Master execution strategy:
GitHub issue #5 — `Master execution strategy: release-ready G1 → independent I2P overlay`.

Private physical-lab continuation:
`msabz/shizuku-controller/CURRENT_CONTINUATION.md`.

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

## Current engineering phase — Stage A5 / Phase 6b-b

PR #18:
`Phase 6b-b: migrate outbound P2P ownership to coordinator`

Branch:
`phase6b-b/outbound-p2p-coordinator`

CI-verified head:
`c31a4ef7dd5dee82375997deb6d78736093f8274`

PR #18 remains **open and draft**. Do not merge before physical regression.

### Implemented live slice

For outbound Wi-Fi Direct where stable G1 identity is provable:
- `App.js` delegates through `p2pAppBridge` to `ConnectionCoordinator`;
- coordinator ownership prevents the legacy App `PEER_CONNECTED` path from opening a second signaling path;
- coordinator-owned P2P does not fall back into App legacy reconnect;
- coordinator-owned cleanup is awaited before App finalizes logical disconnect;
- raw P2P route addresses are rejected as logical identities;
- incoming invitations and identity-unproven P2P peers remain on the legacy path for this surgical slice;
- incoming invitation handling, scanning, manual LAN connection and Bluetooth connection are blocked while an outbound coordinator P2P attempt is active, preventing concurrent control owners;
- `signaling.js` remains the sole signaling/socket/session/heartbeat owner.

### CI verification

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
- expected versionCode `242`.

Current code grade: **CODED / UNIT VERIFIED / CI VERIFIED**.

Current device grade for Phase 6b-b: **NOT DEVICE VERIFIED**.

## Device deployment evidence — authoritative

Original automated install:
`phase6bb-install-031`

Controlled reproduction:
`phase6bb-install-retry-034`

Both legacy G1LAB daemons failed at the same stdin-based installer boundary.

Immediate independent post-state verification:
`phase6bb-verify-after-retry-035`

Result:
- A16 remained `com.directchat` versionCode `215`;
- A06 remained `com.directchat` versionCode `215`.

Therefore build 242 was **not installed** on either phone. This confirms the legacy lab transport defect rather than merely missing Package Manager output.

Do not retry the same stdin-based installer and do not classify this as a PR #18 product failure.

## G1LAB protocol-2.2 repair

Private lab PR #3 merged as:
`3e5d74bb00d95808857a11425bab1ed0b4186ba4`

The repaired lab runtime adds:
- shared-storage staging of the validated APK;
- Shizuku-shell copy into `/data/local/tmp`;
- path-based `pm install -r` rather than stdin APK transport;
- explicit remote installer exit marker and structured evidence;
- post-install exact version verification;
- cleanup of temporary APK material;
- retry + `pm list packages --show-versioncode` fallback for transient package-state reads;
- daemon-side typed `SYNC_AGENT_RUNTIME` self-update;
- corrected tmux supervisor singleton verification.

The repair is **MERGED IN LAB CODE but NOT YET DEPLOYED/DEVICE VERIFIED**.

## Direct controller command path — VERIFIED

The user does not need to type a local test trigger for normal device missions.

Direct structured commands from the controller were autonomously consumed by both persistent daemons, including `daemon-status-autonomous-20260820-002` and `legacy-daemon-status-after-v22-pending-037`.

At the latest checkpoint both phones still reported G1LAB `protocol_version: 2`, proving command delivery is healthy while the new self-update handler is not yet installed.

Migration command:
`lab-runtime-migrate-v22-036`

is pending and correctly produced no STARTED/REPORT from the legacy protocol-2 daemons because `SYNC_AGENT_RUNTIME` is not in their installed allowlist.

## Current blocker — one-time lab runtime migration

The installed protocol-2 daemons cannot safely replace their own Termux-private runtime because they do not contain a self-update handler.

The first transition to protocol 2.2 must use an already-trusted bootstrap/recovery process in Termux context. Do not bypass this boundary with command injection, path traversal, arbitrary-shell listeners, unrelated UI automation or manual APK installation.

After the one-time migration, future lab runtime updates are designed to be controller-driven through the typed `SYNC_AGENT_RUNTIME` action without local `اختبر` triggers.

## Immediate execution order

1. Migrate both A16 and A06 from G1LAB protocol 2 → 2.2 using the trusted bootstrap/recovery path.
2. Verify each device reports protocol 2.2 and exactly one healthy daemon responder.
3. Exercise daemon-side `SYNC_AGENT_RUNTIME` once to prove future autonomous self-update.
4. Issue a fresh `INSTALL_RUN_ARTIFACT` for CI run 242 using a new command ID.
5. Require independent post-install `com.directchat` versionCode 242 on both phones.
6. Start G1 and confirm runtime health.
7. Run one focused outbound Phase 6b-b P2P regression on the A16+A06 pair.
8. If device evidence passes, checkpoint Phase 6b-b as DEVICE VERIFIED and then decide whether PR #18 is ready to merge.
9. If device evidence fails, fix only the causal product/lab defect and repeat the targeted regression.

After Phase 6b-b, continue Stage A in planned order. Do not begin I2P until the full Stage A release-ready gate is satisfied.

## Invariants

- stable peer identity is independent of route/IP/MAC;
- LAN and Wi-Fi Direct remain independent transport candidates;
- signaling/control stays separate from bulk data;
- one owner per concern;
- make-before-break where applicable;
- bounded recovery;
- security/consent first;
- no generic arbitrary-shell lab control path;
- Shizuku/rish is lab-only and never a G1 production dependency.

## Security note

Do not store secrets, credentials, private keys, signing material, raw MAC addresses, Android IDs, serials, IMEIs or equivalent unique device identifiers in the public repository.
