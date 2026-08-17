# G1 DirectChat — Networking Development Memory & Engineering Handoff

**Repository:** `msabz/G1`  
**Working branch:** `feat/zero-config-lan-discovery`  
**Application:** G1 DirectChat  
**Android package:** `com.directchat`  
**Primary signaling port:** TCP `8089`  
**Primary file-transfer port:** TCP `8090`  
**Document purpose:** Persistent engineering memory for any developer/agent continuing networking, discovery, background availability, file transfer, APK/APKS transfer, Wi‑Fi Direct, LAN, Bluetooth, or transport orchestration work.

> This document records the decisions, field observations, confirmed failures, fixes, architectural constraints, and remaining test work from the August 17, 2026 development/debugging session. Do not treat every hypothesis below as proven; sections explicitly distinguish confirmed evidence from inference.

---

## 1. Product networking philosophy — DO NOT BREAK

G1 is a direct communication application. Its transport architecture must preserve these rules:

1. **No transport depends on another transport for its own success.** LAN, Wi‑Fi Direct, and Bluetooth must each be capable of discovery/connection/session establishment independently.
2. **Independence does not prohibit preference or automatic switching.** An upper orchestration layer may prefer a better available transport, fall back to another transport, or later promote a session to a better transport.
3. **AUTO mode should hide networking complexity from normal users.** Discovery, endpoint selection, interface selection, route freshness, and preferred-transport selection should become automated. IP addresses should not be part of normal UX.
4. **Manual/Developer mode may force a transport.** LAN-only, P2P-only, Bluetooth-only, diagnostics, and manual endpoints are developer/advanced controls, not the normal connection flow.
5. **Transport orchestration is not protocol dependency.** Example: `LAN -> P2P -> Bluetooth` may be an AUTO preference order, but P2P must not require LAN to bootstrap and Bluetooth must not be a mandatory bootstrap for P2P.
6. **Peer identity is not an IP address.** One peer can simultaneously have multiple transport-scoped endpoints.
7. **A file-transfer session must not own or destroy a chat/signaling session.** Failure or completion on `8090` must not implicitly tear down `8089`.
8. **Do not migrate a healthy sensitive session merely because a nominally better transport appeared.** Track `currentTransport` separately from `preferredTransport`; migrate only with explicit policy and session-aware handover.

Target conceptual model:

```text
Peer Identity / Application Session
              |
       Session Manager
              |
     Transport Orchestrator
       /       |        \
     LAN      P2P     Bluetooth
```

Each transport owns its discovery/connection lifecycle. The orchestrator selects/switches; it does not make one transport a prerequisite for another.

---

## 2. External architecture research used in decisions

The project was compared against patterns from libp2p, Syncthing, Briar, LocalSend, Jami, Warpinator, PairDrop, Apple Multipeer Connectivity, Google Nearby Connections, Android Quick Share concepts, and the open-source Bada Quick Share implementation.

The patterns intentionally adopted as design guidance are:

- **libp2p:** identity/address/transport separation and modular transports.
- **Syncthing:** a device may have multiple addresses; endpoint freshness and interface/network provenance matter.
- **Briar:** independent communication transports can serve the same peer/application identity.
- **LocalSend/Jami:** file transfer should have an explicit offer/accept/transfer/completion lifecycle rather than treating EOF alone as success.
- **Warpinator:** multi-interface systems can select the wrong interface; G1 should solve this automatically rather than asking normal users to choose an interface.
- **PairDrop:** fallback belongs to connection orchestration, not to application protocol semantics.
- **Quick Share/Bada:** useful robustness patterns include re-resolving stale endpoints, separating discovery/control/bulk transfer concepts, and safe transfer completion. G1 intentionally does **not** copy Quick Share's bootstrap hierarchy.

Do not attempt to clone proprietary Quick Share protocol behavior. Reuse architecture lessons only.

---

## 3. Relevant historical reference: MusabChat / H100

Repository `msabz/H100` (MusabChat) was inspected as a read-only reference because it reached a more advanced stage in several areas.

Useful patterns found there:

- A heartbeat was intentionally sent during connected operation to keep the signaling/control channel alive during long transfers.
- `activeTransfersRef` was used so transient signaling disconnects during an active transfer did not immediately collapse the UI/session.
- A reconnect grace period was attempted before final teardown.
- Native file transfer used a separate TCP server/connection from signaling.
- APK/APKS packaging and installation support already existed conceptually.

Do **not** blindly restore H100's old signaling architecture. G1's newer persistent listener/session-generation work is preferable. H100 is a behavioral reference, not a codebase to revert to.

---

## 4. Initial LAN failure and zero-configuration work

### Original field failure

Devices observed during testing included:

- Samsung `SM-A165F`: LAN `192.168.0.182`
- Motorola `moto g35 5G`: LAN `192.168.0.36`

The original connection attempt to `192.168.0.36:8089` produced `ECONNREFUSED` because the signaling listener was historically started only in a Wi‑Fi Direct flow instead of remaining available while the app was idle.

### Direction taken

The project moved toward:

- persistent TCP signaling listener on `0.0.0.0:8089`;
- mDNS/NSD zero-configuration LAN discovery (`_g1chat._tcp.`);
- peer identity based discovery rather than manual IP entry;
- self-discovery filtering;
- normal UI showing peers, not IP addresses;
- developer diagnostics retaining low-level information.

### Verified field behavior

A later test showed successful LAN discovery:

```text
LAN_PEER_FOUND: moto g35 5G (...) at 192.168.0.36:8089 interface=wlan0
```

and an established signaling socket:

```text
192.168.0.182:<ephemeral> <-> 192.168.0.36:8089 ESTAB
```

mDNS diagnostics later showed both advertising and discovering as true on both devices.

---

## 5. Critical stale-endpoint / interface bug discovered during P2P

During Wi‑Fi Direct testing, NSD produced:

```text
LAN_PEER_FOUND: moto g35 5G (...) at 192.168.49.1:8089
```

only ~620 ms after a P2P group had formed, where `192.168.49.1` was the Wi‑Fi Direct Group Owner address, not a true LAN address.

After P2P teardown, the registry did not receive a fresh LAN discovery for `192.168.0.36`, so `192.168.49.1` could remain cached as if it were LAN. Another observed failure was a SYN attempt toward `192.168.49.1` through `wlan0`, which is the wrong interface for that address.

### Architectural conclusion

Never model a peer as:

```text
peerId -> peerIp
```

Use transport-scoped endpoints:

```text
peerId
  LAN endpoint:
    address
    interface
    generation/network epoch
    discoveredAt
    reachable/stale

  P2P endpoint:
    address
    p2p interface
    group generation/epoch
    reachable/stale

  Bluetooth endpoint:
    transport-specific address/state
```

### Implemented direction

`PeerRegistry` was strengthened with independent transport generations/provenance. LAN endpoint invalidation must not invalidate P2P or Bluetooth, and vice versa. Native LAN/P2P lifecycle work was extended so P2P network disappearance can trigger LAN refresh/invalidation rather than allowing a P2P address to remain a valid LAN route.

A key invariant for future work:

> A `192.168.49.x` P2P endpoint must never survive P2P group teardown as a valid LAN endpoint.

---

## 6. Broken-pipe signaling failure after file-transfer testing

### Field observation

In a LAN-only test, signaling connected successfully around `06:12:10`. Voice/WebRTC negotiation succeeded. File transfer on `8090` showed actual data flow and reached `TIME-WAIT`. Later:

```text
06:14:14.104 SEND type=chat
06:14:14.158 SOCKET_ERROR Broken pipe
06:14:14.158 SESSION_DISCONNECTED
```

The saved log was from Samsung only. It did **not** prove why Motorola closed or lost its side of `8089`. It also did not prove that file transfer itself killed signaling.

### Important correction to an earlier hypothesis

It is **not proven** that Android/router idle timeout caused the socket death. What was proven from code was that the LAN legacy path did not have the same heartbeat behavior as the coordinator/P2P path, so a dead/half-dead socket could remain undetected until the next write.

### Root architectural problem

LAN was still going through a legacy path roughly equivalent to:

```text
handleConnectLan()
  -> connectToSignalingServer()
```

while the newer coordinator had heartbeat behavior. Thus liveness semantics differed by connection path.

---

## 7. Signaling liveness/recovery changes made

The chosen approach was to move liveness into the signaling session itself rather than making heartbeat a property of a particular transport.

Implemented/targeted behavior includes:

- heartbeat approximately every 6 seconds;
- automatic `pong` handling;
- heartbeat/liveness timeout approximately 18 seconds;
- TCP keepalive;
- `TCP_NODELAY` where applicable;
- heartbeat messages are control messages and must not leak into chat/RTC message handling;
- transient recovery/grace window approximately 4 seconds;
- outbound side may reconnect to the same endpoint/transport during the grace window;
- inbound side can wait for a replacement session on the persistent listener;
- only after recovery fails should upper layers receive a final disconnect.

Important rule:

> Recovery of a LAN session means recovery of LAN. It must not secretly bootstrap P2P or Bluetooth. AUTO fallback is a separate orchestrator decision.

Tests were added around ping/pong, timeout, recovery, and symmetric route behavior. At one point CI JavaScript tests failed because Jest did not mock newly used React Native `NativeModules`; that test infrastructure issue was corrected in later commits.

---

## 8. Asymmetric file sending — confirmed code cause

A major field symptom after an installed build was:

- one phone could send files;
- the other phone rejected sending essentially everything with a generic failure;
- signaling no longer necessarily disconnected.

A direct code cause was found: the sender path still rejected a transfer when `peerIpRef.current` was empty **before** reaching the newer `FileShare` logic that could derive the peer address from the live signaling session.

This particularly hurts the passive/inbound side: it may have a perfectly valid `8089` session without having populated the legacy `peerIpRef` in the same way as the initiating side.

### Fix direction implemented

Every active signaling session, inbound or outbound, announces its local socket/network route (`my-ip` style exchange), with native network resolution as fallback when socket-local information is unavailable.

This makes route knowledge symmetric rather than dependent on which device initiated the connection.

Also, file routing was changed so the **live signaling session endpoint wins over a cached/explicit old peer IP**. Cached endpoint data is fallback only.

Critical invariant:

```text
live 8089 peer endpoint > cached peer IP
```

This prevents stale `192.168.49.1` from beating a healthy live LAN session to `192.168.0.36` when opening `8090`.

---

## 9. File-transfer protocol hardening

Port `8090` remains the bulk-transfer channel and must remain independent of signaling lifecycle.

Changes/decisions made:

- transfer is streaming; do not load large files wholly into memory;
- support `content://` and `file://` inputs correctly;
- unknown file size must be represented consistently (protocol uses `0` for unknown) rather than passing `-1` into validation that rejects it;
- transfer limit was raised to support larger files (current work used a multi-GB ceiling rather than the old ~512 MiB assumption);
- MIME handling was improved, including APK/APKS/image cases;
- SHA-256 is computed while streaming;
- receiver verifies transfer size/hash;
- receiver sends an explicit completion ACK;
- sender must not emit final success solely because it wrote EOF/closed the socket;
- sender reports completion only after matching receiver ACK (transfer identity/size/hash semantics);
- transfer failure/completion on `8090` must not close `8089`.

Desired state machine concept:

```text
OFFER -> ACCEPT -> CONNECTING -> TRANSFERRING -> VERIFYING -> COMPLETE_ACK -> CLOSED
```

Further protocol formalization can happen later, but do not regress to “TCP EOF equals guaranteed successful transfer”.

---

## 10. APK/APKS problem inherited from MusabChat

There are **two distinct APK problems**. Do not conflate them.

### 10.1 Packaging a modern installed Android application

Modern installed apps may consist of:

```text
base.apk
split_config.arm64_v8a.apk
split_config.xxhdpi.apk
split_config.<language>.apk
...
```

Sending only `ApplicationInfo.sourceDir` (`base.apk`) may transfer successfully while producing an incomplete/non-installable application.

H100 had useful concepts:

- collect `sourceDir` + `splitSourceDirs`;
- if single APK, send an `.apk`;
- if split app, package components into a single `.apks` archive;
- install `.apks` by placing all APK entries into one Android `PackageInstaller` session.

G1 work adopted/improved this direction. Do not scan arbitrary neighboring APK files unless there is a strong reason; prefer Android's declared `sourceDir` + `splitSourceDirs`.

A single installed APK should be staged/copied under the **real application name** rather than transmitting `/data/app/.../base.apk` directly.

Examples:

```text
G1 DirectChat.apk
Telegram.apk
```

Split apps become:

```text
Application Name.apks
```

The installer path must support `content://`, `.apk`, `.apks`, and Android's “install unknown apps” permission flow. An APKS bundle must contain `base.apk` and its split components should be committed in one installer session.

### 10.2 Filename collision bug: `.apk (1)`

This is a separately diagnosed MusabChat inheritance.

Android/MediaStore could save duplicate incoming files as:

```text
MusabChat.apk (1)
```

which no longer ends with `.apk`. Field evidence from the older project showed that manually renaming the file so `.apk` returned to the end caused Android to recognize the package/icon correctly. Therefore this failure is a filename/extension problem, not APK contents or network corruption.

Correct naming must be:

```text
MusabChat.apk
MusabChat (1).apk
MusabChat (2).apk
```

and for APKS:

```text
MusabChat.apks
MusabChat (1).apks
```

Never:

```text
MusabChat.apk (1)
MusabChat.apks (1)
```

### Implemented defensive MediaStore strategy

Before insertion, generate a unique filename that keeps the extension at the end. After `MediaStore.insert()`, read back the actual `DISPLAY_NAME`. If the platform/provider still changed an APK/APKS name into an invalid extension form, reject/delete that insertion and retry with the next valid candidate.

Incoming transfer events should use the **actual saved display name**, not merely the requested original name, so UI/install logic references the real file.

The commit that introduced this particular fix was:

```text
0884a17786a9fe226bfecb78915f29395a7896e6
fix: preserve APK extensions across MediaStore filename collisions
```

---

## 11. Background availability — WhatsApp-like requirement and limits

A major product gap was identified: G1 historically tied too much connection ownership to the React/UI lifecycle. A messaging/calling app should remain reachable when the Activity is not foregrounded.

Important Android states are different:

- Activity closed/backgrounded while process survives;
- screen off / Doze;
- process killed by Android;
- device reboot;
- explicit user Force Stop.

**Force Stop is a platform boundary.** Do not promise that a fully local app can wake itself after the user explicitly force-stops it. WhatsApp also benefits from centralized infrastructure/push services; G1's serverless/direct model changes what is possible.

### Direction implemented/started

`ConnectionService` was moved toward two modes:

```text
Availability / Idle
  foreground service alive
  listener/discovery readiness
  avoid unnecessary heavy locks

Active Session
  connection in progress/active
  stronger Wi-Fi/Wake lock behavior as required
```

Signaling lifecycle was connected to service state rather than making the service a P2P-only concept:

- persistent listener available -> availability mode;
- signaling session active -> active mode;
- recovery -> reconnecting state;
- session ends -> return to availability rather than blindly killing the service.

This is an intermediate architecture. Long-term, true robust background reachability requires moving more networking ownership into native/service/headless lifecycle rather than assuming the React runtime/UI owns listeners.

---

## 12. AUTO discovery/selection vision

Normal user experience should eventually be:

1. app/service discovers peers quietly;
2. multiple observations of the same peer are merged by peer identity;
3. orchestrator evaluates currently reachable transports;
4. it selects the preferred route automatically;
5. user sees the peer/person, not an IP/interface;
6. if current transport fails, orchestrator may fall back according to policy;
7. if a better transport appears, it may become `preferredTransport`, but a stable active call/large transfer should not be recklessly migrated.

Conceptually:

```text
currentTransport != necessarily preferredTransport
```

Developer mode should expose diagnostics and manual forcing without becoming the default UX.

---

## 13. Diagnostics observations and improvements

Observed diagnostics before fixes included blank `Device ID:` even while discovered peer IDs were populated. The diagnostics screen was relying too heavily on props from its parent. Work was done to let diagnostics resolve identity from persistence as fallback and expose more networking state.

Useful diagnostics should include:

- protocol version;
- local device ID/name;
- local IP/interface(s);
- listener state on `8089`;
- file-transfer listener state on `8090` where relevant;
- mDNS advertising/discovery state;
- transport mode (`AUTO`/manual);
- discovered peers;
- per-transport endpoint, interface, generation, freshness/stale/reachable state;
- active signaling peer endpoint;
- heartbeat state/last activity;
- recovery state;
- current/preferred transport.

Do not use a single `Local IP` field as proof of the route used by a particular session on a multi-interface Android device.

---

## 14. Field tests performed so far

### LAN test — partially successful

Confirmed in at least one LAN-only session:

- zero-config discovery found Motorola at `192.168.0.36` on `wlan0`;
- signaling `8089` established;
- WebRTC voice negotiation connected;
- file transfer `8090` showed actual bytes in flight and reached `TIME-WAIT`;
- no Android fatal crash was observed;
- later chat write exposed a dead signaling socket via `Broken pipe`.

The saved Samsung log did **not** prove why Motorola's signaling side died.

### Wi‑Fi Direct historical test

Confirmed at different points:

- P2P group formation;
- Samsung P2P address such as `192.168.49.40`;
- Motorola Group Owner `192.168.49.1`;
- signaling connection over P2P;
- file transfer had succeeded in at least one earlier P2P test;
- stale P2P address pollution into LAN discovery/registry was observed and became a major fix target.

### Latest installed-build symptom before current fix batch

- signaling connection no longer necessarily collapsed during file operations;
- one phone could transfer;
- the other phone rejected sending images/files/apps generically;
- this led to discovery of asymmetric route state / legacy `peerIpRef` gating and additional file-provider size handling issues.

The current fix batch has **not yet been field-validated on both phones** at the time this document was created.

---

## 15. Important commits from this development session

The following commits were referenced during the session. This is not guaranteed to be an exhaustive git log; it is the engineering trail discussed during debugging.

```text
85cf501c  generic signaling heartbeat
05859ed6  TCP keepalive/no-delay
5e047142  heartbeat tests
5bac783b  file completion ACK + SHA-256
db1848ad  transport-scoped endpoint generations
797dc36d  endpoint generation tests
fbae4af1  transient signaling recovery
4f18b078  recovery regression tests
d4e0eb8a  diagnostics identity/signaling health
a64ac5e4  native LAN network-refresh event
f5a92955  LAN endpoint invalidation on refresh
d919de8c  LAN refresh generation test
1aa9bd1f  live-session-first file routing
16c27344  file routing regression tests
287a1489  symmetric peer route exchange
d3a6a999  native route fallback
296d50cc  proper APK/APKS packaging
98cf94af  unknown/large transfer handling
55851f64  hardened bidirectional FileTransfer
c9fbe25d  APK/APKS installer + permission flow
5f067283  idle/active background service
880be487  availability service API
d073a6ce  signaling-driven background lifecycle
334f1489  symmetric-route/background regression tests
189183af  Android notification cleanup fix
0884a177  preserve APK/APKS extension across MediaStore filename collisions
```

When continuing development, verify the actual branch history with git/GitHub rather than assuming every abbreviated SHA above remains the head or that all intermediate commits passed CI independently.

---

## 16. CI history and current status at document creation

Many red GitHub Actions runs visible in the repository were created because the branch was being committed to rapidly. Each commit could trigger both `push` and `pull_request` workflow runs. Several red runs therefore represent intermediate states, not necessarily the current branch state.

One known historical failure was JavaScript unit tests after signaling began using React Native `NativeModules`; the Jest mock was then fixed.

At the time immediately before this document was written, the latest APK filename commit was:

```text
0884a17786a9fe226bfecb78915f29395a7896e6
```

GitHub Actions run `#79` / related latest runs were still in progress. A latest run had already passed:

- Node dependency install;
- JavaScript unit tests;
- WebRTC patch step;
- React Native JS bundling;

and was executing Android unit tests, with Debug/Release builds still pending.

**Do not install or call a build validated merely because older runs are green. Confirm CI success for the exact commit being tested.**

---

## 17. Next required field-test matrix

After CI is green for the exact head and the same APK is installed on both devices, perform tests in a controlled order and collect logs from **both phones** whenever possible.

### Phase A — LAN, same Wi‑Fi

1. Clean launch on both phones.
2. Confirm both discover each other through true LAN (`192.168.0.x`, `interface=wlan0`).
3. Connect.
4. Leave connection idle for >30 seconds; verify heartbeat/pong continues.
5. Send text A -> B and B -> A.
6. Voice call.
7. Video call.
8. Image A -> B and B -> A.
9. Generic document/file A -> B and B -> A.
10. Large file.
11. Single APK.
12. Same APK again; verify `Name (1).apk`, not `Name.apk (1)`.
13. Split application/APKS.
14. Send a text immediately after each file transfer.
15. Background one app / turn screen off; attempt incoming message/call according to supported service state.

Expected key logs include heartbeat/pong, explicit file completion ACK/hash, and no `Broken pipe` after transfer.

### Phase B — Wi‑Fi Direct only

Repeat bidirectional messaging/files/APK/APKS while verifying endpoints are `192.168.49.x` and bound/routed through P2P semantics, not `wlan0` LAN assumptions.

### Phase C — P2P teardown -> LAN return

1. Establish P2P.
2. Confirm P2P endpoint.
3. Tear down P2P.
4. Confirm P2P endpoint becomes stale/unreachable immediately.
5. Confirm LAN refresh occurs.
6. Confirm peer returns at true `192.168.0.x` LAN address.
7. Reconnect via LAN.
8. Transfer a file and APK.
9. Verify no attempt to use old `192.168.49.1` for LAN/file transfer.

### Phase D — AUTO policy

Only after individual transports are stable:

- test automatic preferred-transport selection;
- test fallback after actual transport failure;
- test that manual mode prevents undesired fallback;
- test that an active healthy call is not migrated merely because another transport appears.

---

## 18. Logging requirements for future debugging

Future logs should make these events explicit and machine-searchable:

```text
[G1/SIGNAL] SESSION_ACTIVE
[G1/SIGNAL] PING
[G1/SIGNAL] PONG_RECEIVED
[G1/SIGNAL] HEARTBEAT_TIMEOUT
[G1/SIGNAL] RECOVERY_START
[G1/SIGNAL] RECOVERY_SUCCESS
[G1/SIGNAL] RECOVERY_FAILED

[G1/LAN] LAN_PEER_FOUND ... interface=... generation=...
[G1/LAN] LAN_NETWORK_REFRESH
[G1/P2P] GROUP_STARTED ... generation=...
[G1/P2P] GROUP_REMOVED ... generation=...

[G1/FT] ROUTE_SELECTED ... transport=... peer=... source=live-session|registry
[G1/FT] INCOMING_START ... transferId=... size=...
[G1/FT] VERIFY_OK ... sha256=...
[G1/FT] COMPLETE_ACK ...
[G1/FT] ERROR ...
```

When debugging asymmetric behavior, collect both devices' logcat over the same time window. A `Broken pipe` on one device proves that device wrote to a socket whose peer side was gone; it does **not** prove why the other device closed the connection.

---

## 19. Things that must not be “fixed” by hiding symptoms

Do not:

- keep stale endpoints indefinitely because reconnect appears to work sometimes;
- treat `TIME-WAIT` on `8090` as an error by itself;
- tear down signaling when file transfer closes normally;
- route P2P addresses through the default LAN interface;
- make Bluetooth a mandatory bootstrap for Wi‑Fi Direct;
- make LAN a mandatory prerequisite for P2P;
- use one global `peerIp` as the authoritative peer identity;
- assume a successful socket write means a complete verified file transfer;
- treat `base.apk` as a complete modern Android application without checking splits;
- allow Android filename collision logic to produce `.apk (1)`/`.apks (1)`;
- claim a root cause from one-sided logs when the peer-side cause is unobserved;
- promise WhatsApp-equivalent wake behavior after Android explicit Force Stop.

---

## 20. Recommended next architecture milestones after stabilization

These are **post-stabilization** tasks, not reasons to delay fixing current regressions.

1. Make the native/background connection service the durable owner of listener/session availability rather than the React screen.
2. Formalize a transport-neutral `Session` abstraction used by chat, RTC signaling, and transfer negotiation.
3. Formalize `TransportAdapter` contracts for LAN/P2P/Bluetooth.
4. Make `TransportOrchestrator` the only component deciding AUTO preference/fallback.
5. Introduce session-aware handover semantics if live migration becomes a requirement.
6. Persist queued incoming/outgoing message state so UI/process recreation does not lose application-level state.
7. Add integration/instrumentation tests that exercise two endpoints or a deterministic socket harness, not only unit tests.
8. Version the G1 wire protocol before incompatible signaling/file-transfer changes accumulate.

---

## 21. Handoff summary

If you are the next developer/agent, start from these facts:

- The product deliberately supports independent LAN/P2P/Bluetooth transports with automatic orchestration above them.
- Zero-config LAN discovery and persistent signaling listener are core direction.
- The project has already experienced real stale-interface/stale-endpoint bugs between `192.168.0.x` LAN and `192.168.49.x` P2P.
- Liveness belongs to signaling sessions, not to one transport.
- File transfer is separate from signaling and now has stronger integrity/completion semantics.
- Bidirectional sending previously failed because route state was asymmetric and legacy `peerIpRef` assumptions remained.
- APK transfer requires both correct split packaging and correct final filename extension handling.
- Background availability is being moved toward native service ownership but is not yet equivalent to centralized push-backed messengers in every Android lifecycle state.
- The latest fix batch requires disciplined two-device field validation before being considered stable.

**First action for any continuation:** check the exact branch head and its CI result, then read this document before changing networking behavior.
