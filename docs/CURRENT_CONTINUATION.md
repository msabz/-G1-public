# G1 Current Continuation

This is the rolling public resume pointer. Prefer exact current code/tests, same-SHA CI, and reproducible device evidence over older documentation.

Last prepared: 2026-08-20 14:22 BST after exact Build253 installation/verification on the active Samsung A16 + Motorola moto g35 5G pair, cross-OEM P2P discovery evidence, and research-first root-cause analysis of the current DNS-SD BUSY/passive-listen failure.

## Read first

Master execution strategy:
GitHub issue #5 — `Master execution strategy: release-ready G1 → independent I2P overlay`.

Current public PR:
#18 — `Phase 6b-b: migrate outbound P2P ownership to coordinator`.

Canonical cross-project handoff:
`msabz/shizuku-controller/G1_PROJECT_HANDOFF_2026-08-20.md`.

Private physical-lab rolling continuation:
`msabz/shizuku-controller/CURRENT_CONTINUATION.md`.

## Evidence vocabulary

Use: `CONFIRMED`, `LIKELY`, `HYPOTHESIS`, `GOAL`, `NOT VERIFIED`.
Completion grades: `CODED`, `UNIT VERIFIED`, `CI VERIFIED`, `DEVICE VERIFIED`, `CROSS-OEM VERIFIED`, `RELEASE READY`.

Priority of truth:
1. current code/tests;
2. CI on the same SHA/tree;
3. reproducible raw device evidence;
4. direct human observation during a controlled physical test;
5. current handoff/continuation;
6. dated checkpoints/history;
7. external analogies.

CI success is not physical-device success.

## Permanent engineering method

For nontrivial bugs, especially networking/P2P:
1. read exact current code and failing evidence;
2. inspect H100/G1/public history and prior fixes;
3. check Android/AOSP/official behavior and CTS where relevant;
4. compare mature open-source implementations close to the failing layer;
5. eliminate plausible competing explanations;
6. design the smallest causal patch with explicit PASS/FAIL criteria;
7. run diff review/unit/CI first;
8. use physical phones only as the final proof gate, not as a random hypothesis generator.

Move faster by doing research/analysis/patch/CI in one bounded engineering cycle instead of many speculative device pokes.

## Verified baseline

Ordinary LAN Phase 5d remains device-verified for the previously tested matrix. `signaling.js` remains the one socket/session/heartbeat/same-route-recovery owner.

Historical Samsung A16+A06 Wi-Fi Direct baseline remains valid:
- bidirectional peer visibility/discovery;
- real P2P group formation;
- A06 Group Owner / A16 client in a controlled run;
- G1 connected/chat state;
- bidirectional basic chat;
- one transient Broken-pipe recovery observation.

Do not claim the Samsung pair never worked.

## Stage A5 ownership invariants

Merged earlier phases established:
- `WifiDirectTransportAdapter` owns Android P2P route lifecycle;
- raw Wi-Fi Direct `deviceAddress` is route metadata, not stable identity;
- `ConnectionCoordinator` owns logical P2P connection orchestration;
- `p2pAppBridge` is the App→Coordinator handoff seam;
- `signaling.js` remains the sole signaling/socket/session/heartbeat owner.

Do not big-bang rewrite these boundaries.

## Current engineering phase — PR #18 / Phase 6b-b

Repository: `msabz/-G1-public`
Branch: `phase6b-b/outbound-p2p-coordinator`
Current canonical PR head at this checkpoint:
`c1166ffd98900d18bcd0a6f50e8aabbcc639766b`

PR state: OPEN / DRAFT / NOT MERGED.

CI on exact head:
- workflow run number `253`
- run id `32323155248`
- conclusion: SUCCESS.

Exact physical artifact/build:
- `G1-DirectChat-debug-apk`
- artifact id `9390566857`
- package `com.directchat`
- versionCode `253`
- APK SHA-256 `87cddf9b91140f13d353f333bcff4ed1ef6d867a1a53d233f268eadfceb90ae8`.

Build253 is installed/verified on the active A16 + Motorola pair.

A rejected unreferenced staging commit `0460c53a952046ffb167aaf2d16061f859865607` was created only for diff inspection and accidentally showed 133 unrelated `App.js` deletions. The PR branch was never moved to it. Treat it as rejected/non-canonical staging only.

## Active physical devices

Primary active pair:
- Samsung A16
- Motorola moto g35 5G

Backup only:
- Samsung A06

Motorola G1LAB onboarding to protocol `2.2-overlay` is complete. Do not ask the user to redo bootstrap/auth unless fresh machine evidence proves a new failure.

## Current Build253 P2P result

CONFIRMED:
- generic Wi-Fi Direct discovery can expose A16 and Motorola to each other cross-OEM;
- DNS-SD identity confirmation still reports `Clear service requests failed: 2 (BUSY)`;
- generic Wi-Fi Direct peers are correctly shown as unverified rather than falsely confirmed DirectChat identity;
- after one side initiates search, the phones can appear briefly and later disappear again from nearby P2P lists.

Because DNS-SD identity confidence failed, stable-identity coordinator connect/chat gates were intentionally not run from a generic peer card.

Do not connect unrelated/generic peers such as Fire TV just because Android reports availability.

## Current strongest root-cause model

Two distinct lifecycle defects are strongly supported.

### A. DNS-SD BUSY

Historical/current native flow inherited broad `clearLocalServices()` / `clearServiceRequests()` behavior before adding the exact newly owned service/request.

After comparison with H100 history, AOSP/Android behavior, Signal Android and Bada:
- broad `CLEAR_*` operations on a fresh/recreated P2P client/channel may return BUSY without activating P2P;
- activating operations such as `ADD_LOCAL_SERVICE`, `ADD_SERVICE_REQUEST`, `DISCOVER_SERVICES`, `DISCOVER_PEERS` move through active P2P paths;
- client/Channel removal already clears client-scoped service state, so broad clear-first is not justified as mandatory normal initialization on a fresh Channel;
- Signal Android owns a specific DNS-SD request and follows `addServiceRequest → discoverServices → remove exact request` rather than mandatory broad clear-before-add;
- Bada includes a modern OEM workaround that primes P2P with an activating discovery lifecycle.

This matches the physical symptom: DNS-SD clear fails BUSY while later generic peer discovery can work.

Treat this as high-confidence causal analysis, not final device proof until a corrected build passes cross-OEM.

### B. Appear-then-disappear peer visibility

H100 previously documented that cleanup/`stopPeerDiscovery()` can leave Samsung outside passive LISTEN and that advertising alone is insufficient.

Current manual `runFreshDiscovery()` performs one-shot cleanup/discovery but does not restore `startPassiveListening()` at the end of that scan path. This matches the human observation that phones can appear after a scan and disappear after the discovery window.

## Reference source corpus confirmed in G1 project sources

Confirmed uploaded ZIPs:
- `Bada-main.zip`
- `Signal-Android-main.zip`
- `briar-master.zip`
- `briar-mailbox-main.zip`
- `berty-master.zip`
- `meshenger-android-master.zip`

Current priority for the P2P bug:
1. Bada — modern Android Wi-Fi Direct/OEM lifecycle.
2. Signal Android — exact DNS-SD request ownership.
3. Briar/Briar Mailbox — bounded BUSY/channel recovery and multi-transport patterns.
4. Berty — identity/transport separation.
5. Meshenger — later direct call/signaling/addressing reference.

Check licenses before literal code reuse.

The user also requested a second source batch around AOSP Wi-Fi/CTS, KDE Connect, LocalSend/protocol and Jami. Verify actual project-source availability in the next session before claiming those files are present.

## Intended next patch direction

Do not implement from memory alone; re-read exact current files first.

Expected narrow direction:
- exact local-service/DNS-SD request ownership instead of mandatory broad clear on the normal hot path;
- assign ownership only after successful add;
- remove the exact owned service/request on stop/retry/cleanup where possible;
- broad clear only as bounded recovery/fallback if justified;
- Channel recreation remains bounded recovery, not default hammer;
- restore passive listening after manual one-shot discovery when not CONNECTING/CONNECTED/DISCONNECTING;
- do not modify coordinator/signaling/TCP P2P bind/stable identity/data plane without direct evidence.

Regression coverage should prove:
- no mandatory pre-add `clearServiceRequests()` in normal DNS-SD discovery;
- exact request ownership/removal;
- stale channel-scoped ownership resets on Channel recreation;
- manual fresh discovery restores passive listening;
- generic P2P availability remains unverified identity.

## Required next execution order

1. Read `msabz/shizuku-controller/G1_PROJECT_HANDOFF_2026-08-20.md`.
2. Verify current PR18 head before editing.
3. Re-read current `DirectConnectionModule.kt`, `src/App.js` fresh discovery flow, and existing lifecycle tests.
4. Complete the research-first comparison against Bada/Signal/Briar and relevant Android/AOSP behavior.
5. Eliminate competing explanations before any phone test.
6. Obtain the explicit source-write authorization for the specific patch batch.
7. Build the smallest patch and inspect the diff mechanically for unrelated changes.
8. Run JS/Android/unit/build CI.
9. Only after green CI install the exact successful artifact on A16+Motorola through G1LAB and verify exact build identity.
10. Run one bounded discovery gate: old BUSY string absent, stable DirectChat identity confirmed, peer visibility remains healthy after the one-shot scan window.
11. Only then run coordinator group formation, bidirectional chat and disconnect cleanup.
12. Do not merge PR #18 until physical gates pass and the user explicitly authorizes merge.

## Known G1LAB note

`extract_ui_hierarchy()` can false-fail when valid UI XML is split between stdout/stderr because the parser checks streams separately. `DUMP_G1_UI FAILED` with `uiautomator rc=0` and valid DirectChat hierarchy is not evidence of an app crash.

## Security

Do not store/expose credentials, device codes, private keys/signing material, raw MACs, Android IDs, serials, IMEIs or equivalent unique identifiers in the public repository.
Shizuku/rish remains lab-only and never a production dependency.
