# G1 DirectChat — Development Handoff / Engineering Memory

**Date:** 2026-08-17  
**Repository:** `msabz/G1`  
**Working branch:** `feat/zero-config-lan-discovery`  
**Purpose:** Persistent engineering memory for anyone continuing G1 networking, discovery, signaling, file transfer, APK/APKS transfer, background availability, diagnostics, testing, or recovery work.

> This document records the live two-device findings, architectural decisions, implemented fixes, MusabChat/H100 lessons, external P2P design lessons, and remaining validation work. Do not treat an implemented fix as field-proven unless explicitly validated.

## 1. Architecture philosophy — DO NOT BREAK

G1 transports are independent. LAN, Wi-Fi Direct/P2P and Bluetooth must each be capable of discovery, connection and communication without requiring another transport to succeed first.

Independence does **not** forbid automatic preference, fallback or migration. A higher orchestrator may select a better available transport:

```text
Application / Session
        |
Transport Orchestrator
   /       |        \
 LAN      P2P     Bluetooth
```

The orchestrator may select, prefer, switch, recover and fall back. It must not create a mandatory dependency such as `Bluetooth success -> Wi-Fi Direct negotiation`.

Default UX should be zero-configuration: discovery, endpoint selection and transport selection hidden/automatic. Developer mode may expose LAN-only, P2P-only and Bluetooth-only overrides.

Keep `preferredTransport` distinct from `currentTransport`. Do not tear down a healthy call/transfer merely because a theoretically better transport appears.

## 2. Peer identity is not an IP

A peer cannot have one global `peerIp`. Android devices may simultaneously have normal Wi-Fi LAN (`wlan0`, e.g. `192.168.0.x`), Wi-Fi Direct (`p2p-*`, commonly `192.168.49.x`), Bluetooth and changing network generations.

Correct conceptual model:

```text
PeerIdentity
  +-- LAN endpoint(s): address, interface, generation, discoveredAt, reachable/stale
  +-- P2P endpoint(s): address, interface, group generation, reachable/stale
  +-- Bluetooth endpoint(s): identity/address, connection generation, reachable/stale
```

Endpoints belong to transports and network generations. They must not silently cross transport boundaries.

## 3. Initial LAN failure and zero-config discovery

Early live testing showed `ECONNREFUSED` connecting to `192.168.0.36:8089`. The listener was not consistently available while the remote app was idle.

Direction implemented during this project:

- persistent TCP signaling listener on `8089`,
- Android NSD/mDNS discovery using `_g1chat._tcp.`,
- no normal-user manual IP requirement,
- peer discovery by device identity/name,
- manual IP only as developer/emergency capability.

Later field evidence showed correct LAN discovery such as `LAN_PEER_FOUND ... 192.168.0.36:8089 interface=wlan0`, persistent `LISTEN *:8089`, and working self-discovery filtering.

## 4. Critical stale endpoint: P2P address registered as LAN

A major captured bug was `LAN_PEER_FOUND ... 192.168.49.1:8089` immediately after Wi-Fi Direct group formation. `192.168.49.1` was the P2P Group Owner, not a normal LAN endpoint. After group removal no fresh discovery updated the peer to `192.168.0.36`, leaving stale state.

Fix direction implemented:

- transport-scoped endpoint generations in PeerRegistry,
- interface/provenance metadata,
- stale/reachable semantics,
- native LAN network-refresh event,
- invalidate LAN endpoints on network transition without invalidating P2P/Bluetooth.

Relevant commits recorded during the session:

```text
db1848ad  transport-scoped endpoint generations
797dc36d  endpoint generation tests
a64ac5e4  native LAN network-refresh event
f5a92955  LAN endpoint invalidation on refresh
d919de8c  LAN refresh generation test
```

Never store a P2P `192.168.49.x` endpoint as a generic LAN address.

## 5. Wrong-interface P2P behavior

Monitoring showed a valid P2P signaling connection `192.168.49.40 <-> 192.168.49.1:8089 ESTAB`, but also a failed `192.168.0.182 -> 192.168.49.1:8089 SYN-SENT`. This demonstrated the danger of reaching a P2P Group Owner through normal `wlan0` after topology changes.

Rules: endpoint provenance matters; P2P endpoints expire with group generation; reconnect must not blindly reuse cached IP; re-resolve when freshness is uncertain.

## 6. Broken Pipe investigation

A LAN-only test established signaling successfully and WebRTC voice negotiation succeeded. Later a chat send produced:

```text
SEND type=chat
SOCKET_ERROR Broken pipe
SESSION_DISCONNECTED
```

The saved log was from one phone only. It proves a write to a dead socket, but does **not** prove why the remote phone closed it. Do not claim file transfer itself was proven to kill signaling; that causal link was never established.

## 7. Heartbeat wiring gap and fix

The tested LAN path used `App.js handleConnectLan() -> signaling.js connectToSignalingServer()`, while a complete heartbeat existed elsewhere in ConnectionCoordinator. Thus LAN could appear connected while a dead TCP session remained undetected until the next write.

Heartbeat/liveness was moved into the signaling session layer itself so it is transport-independent:

- ping roughly every 6 s,
- automatic pong,
- timeout roughly 18 s,
- TCP keepalive,
- TCP_NODELAY,
- heartbeat frames consumed internally rather than forwarded to chat/RTC,
- explicit liveness logging.

```text
85cf501c  generic signaling heartbeat
05859ed6  TCP keepalive/no-delay
5e047142  heartbeat tests
```

## 8. Transient signaling recovery

H100/MusabChat demonstrated a useful resilience concept: do not instantly destroy visible session state during a transient signaling break, especially around long transfers.

G1 adopted the concept without restoring H100's older socket architecture:

- short recovery window (~4 s),
- outbound retries the same transport/endpoint,
- inbound waits for replacement connection on persistent listener,
- successful replacement avoids UI teardown,
- expiration propagates disconnect normally.

```text
fbae4af1  transient signaling recovery
4f18b078  recovery regression tests
```

Same-transport recovery is separate from orchestrator cross-transport fallback.

## 9. Asymmetric sending: one phone sent, the other rejected files

A direct code cause was found. `sendAsset()` had an old `peerIpRef.current` precondition. A passive/inbound peer could have a healthy `8089` session but no populated `peerIpRef`, so sending was rejected before newer route resolution ran.

Fix: every signaling session, inbound or outbound, exchanges the actual socket route (`my-ip`) symmetrically; native route resolution is a fallback when needed.

```text
287a1489  symmetric peer route exchange
d3a6a999  native route fallback
334f1489  symmetric-route/background regression tests
```

Connection initiator role must never determine whether a peer can send files.

## 10. File-transfer route freshness

FileShare could prefer cached/explicit peer IP over the endpoint of the live signaling socket. That allowed stale P2P `192.168.49.1` to outrank healthy LAN `192.168.0.36`.

Implemented tactical rule:

```text
live signaling session endpoint > cached/explicit peer IP
```

```text
1aa9bd1f  live-session-first file routing
16c27344  file routing regression tests
```

Long-term code should expose transport/session endpoint identity explicitly instead of generic peer-IP refs.

## 11. File transfer protocol (`8090`)

G1 keeps bulk transfer independent from signaling:

```text
8089 = signaling/control
8090 = bulk transfer
```

A file-transfer socket must never own or destroy signaling.

Protocol hardening implemented:

1. stream bytes,
2. calculate SHA-256 while streaming,
3. receiver verifies size/hash,
4. receiver sends completion ACK,
5. sender reports success only after valid ACK.

```text
5bac783b  file completion ACK + SHA-256
```

An additional bug was found: protocol used `0` for unknown size but some Android providers returned `-1`, causing immediate transfer-limit rejection. Changes normalized unknown size, improved URI handling, increased defensive transfer ceiling, retained streaming, and improved MIME handling.

```text
98cf94af  unknown/large transfer handling
55851f64  hardened bidirectional FileTransfer
```

## 12. MusabChat/H100 lessons

H100 was reviewed as a reference. Useful ideas:

- heartbeat during long transfers,
- active-transfer tracking,
- disconnect grace/reconnect,
- dedicated raw TCP bulk-transfer channel,
- APK/APKS packaging/installation.

Do not restore H100's older signaling/socket ownership wholesale. G1's persistent listener, endpoint generations and newer session ownership are intended to be stronger.

## 13. APK/APKS packaging

Modern Android App Bundle installs may contain `base.apk` plus multiple split APKs. Sending only `ApplicationInfo.sourceDir` can produce an incomplete app.

Desired architecture:

```text
Installed app -> AppPackageBuilder -> .apk or .apks -> normal FileTransfer -> selected transport
```

Single APK: create a stable temporary copy with human app name rather than sending `/data/app/.../base.apk` directly.

Split app: package base plus official `splitSourceDirs` into `.apks`. Do not blindly include every APK in the installation directory.

```text
296d50cc  proper APK/APKS packaging
```

## 14. APK/APKS installation

Received items may be `content://` URIs, so code must not assume filesystem `File(path)` access. `.apks` requires a PackageInstaller session containing base and required splits.

Hardening includes content URI support, APK/APKS MIME handling, unknown-sources permission flow and base.apk validation.

```text
c9fbe25d  APK/APKS installer + permission flow
```

## 15. Inherited APK filename collision bug

MusabChat had a separately diagnosed naming problem. MediaStore could turn a duplicate:

```text
MusabChat.apk -> MusabChat.apk (1)
```

which no longer ends in `.apk`. Manually restoring the final `.apk` suffix restored Android recognition in the prior diagnosis.

Correct semantics:

```text
MusabChat.apk
MusabChat (1).apk
MusabChat (2).apk
```

and likewise for `.apks`.

G1 now resolves collisions before MediaStore insertion, preserves extension as final suffix, reads the actual resulting `DISPLAY_NAME`, and rejects/retries unsafe APK/APKS names. Incoming transfer events use the final saved display name.

```text
0884a177  preserve APK extensions across MediaStore filename collisions
```

This problem is independent from network transport and APK content/signature.

## 16. Background availability / WhatsApp-like behavior

A major architectural gap was identified: networking should not fundamentally belong to the React UI lifecycle.

Long-term target:

```text
React UI
   |
Native Connection/Availability Service
   |
Session Manager / Transport Orchestrator
   |
LAN / P2P / Bluetooth
```

First-stage work introduced availability vs active service state:

```text
Availability/Idle: listener available, service alive, avoid unnecessary heavy locks
Active Session: active connection/call/transfer, acquire required wake/Wi-Fi resources
```

Signaling lifecycle drives service state rather than only the Wi-Fi Direct UI path.

```text
5f067283  idle/active background service
880be487  availability service API
d073a6ce  signaling-driven background lifecycle
189183af  Android notification cleanup fix
```

This is not yet equivalent to WhatsApp + cloud push. Android process death, Doze, reboot and especially explicit Force Stop have platform constraints. Force Stop cannot be treated as a normal networking regression. A serverless direct app cannot wake a fully dormant remote peer exactly like a cloud-push messenger without additional infrastructure/platform mechanisms.

## 17. Diagnostics

Earlier diagnostics showed blank `Device ID:` despite persisted identity. Diagnostics was changed to fall back to persisted identity and expose more signaling/heartbeat/recovery/endpoint information.

```text
d4e0eb8a  diagnostics identity/signaling health
```

Diagnostics should become the primary field-debugging surface over time.

## 18. External design research — lessons only

Mature systems were reviewed conceptually:

- **libp2p:** identity separate from transport address; modular transports.
- **Syncthing:** multiple addresses per device; address freshness/interface matters.
- **Briar:** messaging identity can communicate through independent transports.
- **LocalSend/Jami:** transfer negotiation, explicit lifecycle, endpoint != identity, receiver confirmation.
- **Quick Share/Nearby/Bada:** automatic transport UX, endpoint re-resolution, separation of discovery/control/bulk transfer, robust large-transfer close behavior.

G1 must not copy a mandatory Bluetooth-bootstrap -> Wi-Fi hierarchy. Its transports remain independently usable.

## 19. AUTO transport policy

Desired normal behavior:

- user sees peer identity, not IP/interface,
- discovery runs automatically,
- same peer across multiple transports is deduplicated,
- AUTO chooses best viable route,
- advanced mode can force a transport,
- fallback belongs to orchestrator,
- signaling recovery first tries same transport,
- promotion/migration is session-aware.

LAN may be preferred when healthy because of stability/performance, but cached LAN state is never proof of reachability.

## 20. CI/build-history warning

Many small commits were pushed during debugging. Actions runs on push and PR events, producing many historical red runs. Old red runs do not necessarily describe the current head.

A historical failure occurred after signaling started using NativeModules while Jest mocks were not yet updated; that test-infrastructure issue was later fixed.

At document creation, commit `0884a17786a9fe226bfecb78915f29395a7896e6` had current Actions runs still in progress. The observed latest run had passed JavaScript tests and RN bundling while Android unit tests were still running. Always check CI on the **current branch head** before installing or merging.

## 21. Important commits recorded in this session

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
0884a177  preserve APK extensions across MediaStore filename collisions
```

Verify short SHAs if history is later rebased/squashed.

## 22. Field evidence collected

Repeated test devices:

- Samsung `SM-A165F`, LAN around `192.168.0.182`.
- Motorola `moto g35 5G`, LAN around `192.168.0.36`.
- P2P Group Owner observed as `192.168.49.1`.

Proven at different stages:

- mDNS/NSD zero-config discovery can work,
- persistent signaling listener can remain on `8089`,
- LAN signaling can establish,
- WebRTC voice negotiation succeeded in a LAN test,
- bulk bytes flowed on `8090`,
- Wi-Fi Direct signaling established in earlier tests,
- file transfer was reported working on Wi-Fi Direct in an earlier build,
- stale P2P-as-LAN endpoint was captured,
- Broken pipe was captured on a dead signaling socket,
- asymmetric file sending was observed on a later build.

Not all newer fixes are yet field-proven.

## 23. Mandatory next test matrix

Use the **same exact green artifact** on both phones.

### LAN baseline

1. Same Wi-Fi LAN.
2. Open both apps.
3. Confirm discovery both ways.
4. Capture diagnostics both ways.
5. Connect.
6. Text A -> B and B -> A.
7. Idle >30 s.
8. Text both ways again.
9. Voice call.
10. Video call.

Expected liveness evidence: `PING`, `PONG_RECEIVED`, no unexpected timeout.

### Bidirectional LAN file transfer

Both directions: image, document, large file, single APK, split/APKS where available. Immediately send chat after every transfer. File transfer must not kill signaling.

### Duplicate APK/APKS names

Send same package repeatedly. Expect `App.apk`, `App (1).apk`, `App (2).apk`; never `App.apk (1)`. Repeat for `.apks`. Verify Android recognizes/install flow.

### Wi-Fi Direct independently

Do not require prior LAN success. Test messages both ways, calls, image/file/APK both ways, idle heartbeat and signaling after transfers.

### P2P -> LAN transition

Form P2P, record endpoint generation, remove group, observe refresh, confirm `192.168.49.x` becomes stale, rediscover fresh `192.168.0.x`, reconnect LAN and transfer. No LAN operation may reuse stale `192.168.49.1`.

### Background

Test Home, screen off, wait, incoming message/call/file, reopen UI. Keep Force Stop as a separate platform-limitation test.

## 24. Logging requirements

Capture logs from **both phones** for serious tests. Minimum useful events:

```text
LAN_PEER_FOUND
LAN_NETWORK_REFRESH
P2P group formed/removed
SESSION_ACTIVE
INBOUND_ACCEPTED
OUTBOUND_CONNECTED
PING
PONG_RECEIVED
HEARTBEAT_TIMEOUT
RECOVERY_START
RECOVERY_SUCCESS/failure
SEND type=chat
SOCKET_ERROR
FT_INCOMING_START
FT_INCOMING_DONE
FT_SENT_DONE
FT_ERROR
route/interface/endpoint used for 8089 and 8090
```

One-sided logcat cannot prove why the remote peer closed TCP. Always label conclusions as **proven**, **strongly inferred**, or **possible/unproven**.

## 25. Things future developers must NOT do

1. Do not restore one global `peerIp` as truth.
2. Do not treat `192.168.49.1` as permanent.
3. Do not make Bluetooth mandatory for LAN/P2P negotiation.
4. Do not let file-transfer lifecycle own signaling lifecycle.
5. Do not treat EOF/TIME-WAIT alone as integrity proof.
6. Do not send only `base.apk` for split-installed apps.
7. Do not assume Android URIs are filesystem paths.
8. Do not allow `App.apk (1)` naming.
9. Do not tear down healthy calls only because a better transport appeared.
10. Do not claim cloud-messenger background equivalence without lifecycle tests.
11. Do not diagnose remote closure from one phone's logs alone.
12. Do not merge networking changes solely because JS tests are green; require Android build/tests and field validation.

## 26. Recommended long-term architecture

```text
                 Peer Identity
                      |
                Session Manager
                      |
             Transport Orchestrator
              /        |        \
            LAN       P2P    Bluetooth
              \        |        /
          transport-independent
          signaling/message contract
                      |
          Native Availability Service
                      |
                React Native UI
```

File transfer should be a transaction over the selected transport, not a second identity system. Desired transfer state machine:

```text
OFFERED -> ACCEPTED -> CONNECTING -> TRANSFERRING -> VERIFYING -> ACKNOWLEDGED -> COMPLETED
```

## 27. Current engineering status

The working branch contains substantial work for zero-config LAN, persistent signaling, stale endpoint separation, heartbeat, transient recovery, bidirectional route exchange, file-route freshness, transfer integrity ACK, unknown-size/large transfers, APK/APKS packaging/install, safe APK duplicate names, first-stage native background availability and diagnostics.

But the correct status is:

**implemented != fully field-validated.**

The next developer should check CI on the latest head, install one exact green artifact on both devices, execute the matrix above, capture both-device logs and fix only failures demonstrated by that run.

## 28. Handoff principle

G1 must remain correct when devices change interfaces, addresses are reused, P2P groups are recreated, either side initiated the connection, transfers run long, UI leaves foreground, endpoints become stale, and preferred transport changes.

Prefer explicit identity, endpoint generations, transport provenance, session ownership and verifiable state transitions over timing assumptions and cached-IP shortcuts.
