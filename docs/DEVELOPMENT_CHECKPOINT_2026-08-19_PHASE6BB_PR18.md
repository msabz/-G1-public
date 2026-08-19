# G1 Development Checkpoint — 2026-08-19 — Phase 6b-b / PR #18

## Scope

Stage A5 / Phase 6b-b: migrate the smallest live outbound Wi-Fi Direct ownership slice from `App.js` into `p2pAppBridge` / `ConnectionCoordinator` while preserving the existing incoming legacy path for this slice.

## Pull request

PR #18 — `Phase 6b-b: migrate outbound P2P ownership to coordinator`

Branch: `phase6b-b/outbound-p2p-coordinator`

Current verified head at checkpoint: `c31a4ef7dd5dee82375997deb6d78736093f8274`

PR remains open and draft. Do not merge until device regression passes.

## What changed

The live outbound P2P path now delegates to `p2pAppBridge` → `ConnectionCoordinator` when a stable G1 peer identity is provable.

The slice intentionally keeps incoming invitations and identity-unproven peers on the existing legacy path.

Ownership protections added in this slice include:
- coordinator-owned P2P sessions do not fall back into App legacy Wi-Fi Direct reconnect;
- raw Wi-Fi Direct `deviceAddress` remains route metadata and is rejected as stable logical identity;
- the legacy `PEER_CONNECTED` App path yields while the coordinator owns P2P connection setup;
- coordinator-owned teardown does not perform a second App-owned native Wi-Fi Direct cleanup;
- App waits for coordinator P2P cleanup state before final logical disconnect;
- incoming invitation handling, scanning, manual LAN connect, and Bluetooth connect are gated while an outbound coordinator P2P attempt is active, preventing concurrent control owners.

`signaling.js` remains the single signaling/socket/session/heartbeat owner.

## Verification

Final CI run for this checkpoint: run #242 (`32307946195`).

Result: SUCCESS.

Verified in the same run:
- JavaScript unit tests;
- React Native JS bundle;
- Android unit tests;
- Debug APK build;
- stable CI Debug signing and certificate verification;
- Release APK build;
- Debug and Release artifact upload.

Debug artifact:
- name: `G1-DirectChat-debug-apk`
- artifact id: `9385559100`
- workflow head: `c31a4ef7dd5dee82375997deb6d78736093f8274`
- CI versionCode: `242`

Status of this code slice: **CODED / UNIT VERIFIED / CI VERIFIED**.

It is **NOT DEVICE VERIFIED** yet.

## Device-install gate

G1LAB command `phase6bb-install-031` attempted `INSTALL_RUN_ARTIFACT` on both `samsung-a16` and `samsung-a06`.

Both daemons:
- accepted the command;
- posted one `STARTED` report each;
- reached the installation action;
- posted `FAILED` correctly rather than claiming success.

Observed failure on both devices:
`RuntimeError: pm install -r failed:`

The reports contained no useful `pm` stdout/stderr diagnostic payload.

Therefore:
- do **not** classify the APK or Phase 6b-b code as the cause;
- do **not** assume versionCode 242 was installed;
- do **not** bypass this automatically with a manual install as the normal workflow;
- first repair the G1LAB `INSTALL_RUN_ARTIFACT` capability so installation failures preserve actionable command output, use the correct Android installation path, verify the resulting package version, and can be regression-tested.

## Required next order

1. Repair and harden G1LAB `INSTALL_RUN_ARTIFACT` based on the real `phase6bb-install-031` failure.
2. Add regression coverage / deterministic failure evidence for the installer capability.
3. Update the persistent lab runtime safely on A16/A06.
4. Retry the same build 242 artifact with a new command ID; never reuse `phase6bb-install-031`.
5. Verify `com.directchat` versionCode 242 on both devices.
6. Run the focused Phase 6b-b physical P2P outbound regression on the A16+A06 pair.
7. Only after device success, mark the slice DEVICE VERIFIED and decide whether PR #18 is ready to merge.

Do not repeat already-established baseline discovery/group/chat tests before the new code is actually installed.

## Lab engineering principle discovered by use

The device-lab is not a static test harness. Real operational failures are inputs to its own engineering loop:

`real failure → preserve evidence → identify causal lab weakness → improve lab code/protocol → add regression coverage → deploy runtime update → retry original mission → verify improvement`

Manual workarounds should not replace an automatable lab capability. Human intervention remains appropriate only for genuinely physical/system-consent steps that Android does not permit the lab to automate safely.

## Security / evidence notes

- Do not expose secrets or signing material.
- Do not store raw device-unique identifiers in the public repository.
- CI green is not device verification.
- Machine evidence controls over optimistic prose summaries.
