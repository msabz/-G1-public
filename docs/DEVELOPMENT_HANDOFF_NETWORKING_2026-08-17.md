# G1 DirectChat — Development Handoff / Networking & File Transfer Memory

**Date:** 2026-08-17  
**Repository:** `msabz/G1`  
**Working branch:** `feat/zero-config-lan-discovery`  
**Package:** `com.directchat`  
**Purpose:** Persistent engineering memory for any developer/agent continuing G1 networking, transport, background availability, file transfer, APK/APKS transfer, diagnostics, testing, or bug fixing.

---

## 1. Product philosophy — do not break these rules

G1 is a direct peer-to-peer communication application. Its transport philosophy is intentionally different from systems where one radio/transport is a mandatory bootstrap for another.

### Core invariant

**No transport is allowed to depend on the success of another transport in order to function.**

LAN, Wi-Fi Direct/P2P, and Bluetooth must each be capable of their own discovery/connect/session lifecycle. However, independence does **not** mean all transports have equal priority or that automatic switching is forbidden.

The intended architecture is:

```text
Peer Identity / Application Session
              |
      Transport Orchestrator
       /        |         \
     LAN       P2P      Bluetooth
```

The orchestrator may automatically prefer a better available transport, fall back when one becomes unavailable, and eventually migrate/reconnect a logical peer session. That is orchestration, not protocol dependency.

### AUTO vs MANUAL

Default UX should ultimately be zero-configuration and automated. Discovery, endpoint selection, route/interface choice, and preferred transport should normally be hidden from ordinary users.

Advanced/developer controls may allow `LAN only`, `Wi-Fi Direct only`, `Bluetooth only`, etc. In explicit manual mode, the application must respect the user's transport choice rather than silently switching.

### Important distinction

Keep these separate:

```text
preferredTransport != currentTransport
```

Do not tear down a stable call/file transfer merely because a nominally higher-priority transport appeared. Promotion should be session-aware and avoid needless handovers during sensitive operations.

---

## 2. Initial field problem and first diagnosis

Original LAN connection attempts targeted port `8089` and failed with `ECONNREFUSED` because the signaling server was originally opened only in some Wi-Fi Direct flows. This motivated a persistent signaling listener.

The app then gained zero-configuration LAN discovery using Android NSD/mDNS (`_g1chat._tcp.`) and a listener on `0.0.0.0:8089`.

Field diagnostics confirmed successful discovery such as:

```text
LAN_PEER_FOUND: moto g35 5G (...) at 192.168.0.36:8089
```

and successful LAN signaling sessions on `8089`.

---

## 3. Major stale-endpoint/P2P contamination bug

A serious issue was reproduced while Wi-Fi Direct was active. Android NSD resolved a service on the P2P interface and emitted it as a LAN peer:

```text
LAN_PEER_FOUND ... at 192.168.49.1:8089
```

At the same time Android reported:

```text
groupFormed: true
Group Owner: 192.168.49.1
```

Therefore `192.168.49.1` was not a normal LAN endpoint; it was the Wi-Fi Direct group-owner address. After P2P teardown, no new LAN discovery necessarily arrived immediately, leaving the registry with stale `192.168.49.1` data.

This caused attempts such as:

```text
192.168.0.182 (wlan0) -> 192.168.49.1:8089
```

which remained `SYN-SENT`, because the app was attempting to reach a P2P-only address over the normal WLAN route.

### Architectural conclusion

Never model a peer as:

```text
peerId -> peerIp
```

Use transport-scoped endpoints:

```text
PeerIdentity
  LAN endpoint
    address
    interface
    generation/network epoch
    lastSeen
    reachable/stale

  P2P endpoint
    address/group-owner data
    interface
    group generation
    reachable/stale

  Bluetooth endpoint
    transport-specific identity/address
    generation
    reachable/stale
```

An IP address belongs to a **transport/network epoch**, not to the peer identity itself.

---

## 4. Discovery/registry improvements implemented

The LAN discovery path was changed to include interface provenance. LAN results must be associated with the interface/network on which they were resolved.

`PeerRegistry` was extended toward transport-scoped endpoint state with independent generations. Invalidating LAN must not invalidate P2P or Bluetooth and vice versa.

A native `LAN_NETWORK_REFRESH` event was added for relevant network/P2P transitions. LAN discovery invalidates stale LAN endpoints and starts a fresh generation rather than preserving an address indefinitely.

Diagnostics were expanded to expose transport/interface/generation/stale/reachable information so future field tests can prove what endpoint is actually being used.

---

## 5. Signaling architecture and Broken Pipe investigation

### Ports

- `8089`: persistent signaling/control channel.
- `8090`: bulk file-transfer channel.

These channels must remain logically independent. Failure or normal closure of a file-transfer socket must not own or destroy the signaling session.

### Field observation

LAN testing showed a valid signaling connection and successful RTC negotiation, but later:

```text
SEND type=chat
SOCKET_ERROR: Broken pipe
SESSION_DISCONNECTED
```

The captured Samsung log did **not** prove that file transfer itself closed `8089`. The remote Motorola log was unavailable for that exact event, so the precise reason the remote endpoint closed the signaling socket was not proven.

Important: do not repeat the unsupported claim that `8090 TIME-WAIT` proves it killed `8089`. It does not.

### Heartbeat wiring bug

Review showed that the old LAN UI path used:

```text
handleConnectLan()
  -> connectToSignalingServer()
```

while a heartbeat implementation existed elsewhere (notably `ConnectionCoordinator` and older P2P-specific UI wiring). Consequently the real legacy LAN path could remain idle without sending heartbeat packets.

This was a wiring/ownership problem: liveness should be a property of the signaling session, not of a particular UI/P2P path.

---

## 6. Generic signaling heartbeat implemented

Heartbeat was moved into the signaling/session layer so it applies regardless of whether the session arrived via LAN or Wi-Fi Direct.

Design values introduced during this work:

```text
heartbeat interval: ~6 seconds
heartbeat timeout: ~18 seconds
```

The signaling layer handles `ping`/`pong` internally rather than forwarding those packets into chat/RTC application logic.

TCP keepalive and `TCP_NODELAY` were also enabled where appropriate.

Expected diagnostic/log concepts include:

```text
PING
PONG_RECEIVED
HEARTBEAT_TIMEOUT
```

The heartbeat does two things:

1. Keeps the control path active.
2. Detects a dead peer before the user discovers it through the next chat write and receives `Broken pipe`.

Do **not** state that lack of heartbeat alone proves Android/router killed an idle socket. It only proves the app lacked active liveness detection.

---

## 7. Signaling recovery window implemented

A short transient recovery/grace mechanism was introduced around signaling loss (approximately 4 seconds in the implementation developed in this session).

Intent:

- Do not instantly tear down the user-visible session for a brief TCP interruption.
- Outbound side may reconnect to the **same transport/same endpoint**.
- Inbound side can wait for a new connection on the persistent listener.
- If recovery succeeds within the grace window, do not unnecessarily collapse the UI/session.
- If recovery fails, propagate disconnect normally.

This recovery is not permission to jump between transports. Cross-transport fallback belongs to the transport orchestrator, not the signaling socket recovery code.

---

## 8. Bidirectional file-send asymmetry — important root cause

A later field build had this behavior:

- One phone could send files.
- The other phone refused every send with a generic failure.
- Signaling itself remained connected.

A direct code-level cause was found: `sendAsset()` could reject before reaching the new `FileShare.sendFileNative()` logic when `peerIpRef.current` was empty.

This is especially likely on the passive/inbound side: it may have a perfectly valid `8089` session but never populated the legacy `peerIpRef` the same way as the initiating side.

### Fix direction implemented

Every active signaling session now symmetrically announces its route/local socket address (`my-ip` style route exchange), regardless of inbound/outbound role. Native network resolution is used as a fallback if the JS socket cannot provide a usable local address.

This is intended to eliminate the initiator-vs-receiver asymmetry.

### Critical invariant

File sending should prefer the **live signaling session's remote endpoint** over a cached/legacy peer IP. A stale P2P address such as `192.168.49.1` must not override a currently healthy LAN signaling peer such as `192.168.0.36`.

A regression test was added for live-session-first file routing.

---

## 9. File transfer protocol hardening

File transfer remains on `8090` and is intentionally independent from signaling `8089`.

### Problems addressed

1. Some Android content providers return unknown size. Existing code could represent that as `-1`, while the protocol/receiver expected `0` for unknown size. A negative size could be rejected immediately, creating device-dependent failures.
2. Large-file handling needed a less restrictive limit.
3. Completion was previously too dependent on TCP EOF/closure semantics.
4. Integrity needed stronger confirmation.

### New/strengthened behavior

- Unknown size normalized to the protocol's unknown-size representation (`0`).
- File transfer remains streaming; do not load entire files into memory.
- Transfer size allowance was increased substantially (implementation work used a multi-GB ceiling).
- SHA-256 is computed during streaming.
- Receiver validates size/hash.
- Receiver sends an explicit completion ACK containing transfer identity/result.
- Sender reports success only after receiving a valid completion ACK.

Conceptual protocol:

```text
metadata/header
  -> bytes stream
  -> receiver verifies size/hash
  -> completion ACK
  -> sender declares FT_SENT_DONE
```

Expected logs should distinguish successful completion from transport closure:

```text
FT_INCOMING_DONE
FT_SENT_DONE
FT_ERROR
```

A `TIME-WAIT` socket alone is not a failure; it can be normal TCP closure.

---

## 10. Lessons taken from H100 / MusabChat

The older `msabz/H100` project was inspected as a reference only.

Useful ideas found there:

- `activeTransfersRef` protects UI/session teardown while a transfer is active.
- A heartbeat was intentionally sent during long transfers to keep the control channel alive.
- Reconnect grace behavior existed around transfer-related disconnects.
- File transfer was already separated from signaling.

Do not blindly restore H100's older signaling implementation. G1 has since developed better persistent-listener/session ownership behavior. Reuse the concepts, not obsolete socket architecture.

---

## 11. External architecture research conclusions

Several established/open-source systems were reviewed conceptually for patterns, including libp2p, Syncthing, Briar, LocalSend, Jami, Warpinator, PairDrop, Android/Quick Share concepts, Nearby Connections, and Apple Multipeer Connectivity.

The relevant lessons for G1 are:

1. **Peer identity is not an IP address.**
2. **Endpoints are transport-scoped and ephemeral.**
3. **Multi-interface systems need endpoint provenance and freshness.**
4. **Discovery/connection/data transfer should be separable concerns.**
5. **File-transfer lifecycle must be separate from chat/signaling lifecycle.**
6. **AUTO selection can prefer/fallback among transports without making them protocol dependencies.**
7. **Re-resolve/re-discover before retrying a failed stale endpoint rather than looping forever on an old IP.**
8. **Transfer completion should use explicit protocol confirmation, not only socket EOF.**

### What NOT to copy

Do not copy Quick Share's idea of mandatory Bluetooth/BLE bootstrap into G1. G1's product philosophy requires each transport to remain independently usable.

---

## 12. APK/APKS transfer — inherited MusabChat problems

There are two separate APK-related problem families. Keep them distinct.

### A. Split APK packaging

Modern Android applications installed from App Bundles may consist of:

```text
base.apk
split_config.arm64_v8a.apk
split_config.xxhdpi.apk
split_config.ar.apk
...
```

Sending only `ApplicationInfo.sourceDir` (`base.apk`) can produce an incomplete/uninstallable application.

The H100 project already contained a useful approach: package `sourceDir + splitSourceDirs` into an `.apks` archive and install all APK entries in one `PackageInstaller.Session`.

G1 was updated toward this model:

- Single APK: copy to a stable cache/export path using the human application name before sending.
- Split application: create `<AppName>.apks` containing base + required split APKs.
- Do not scan arbitrary neighboring APK files merely because they share the install directory; prefer official `sourceDir + splitSourceDirs`.
- `.apk` and `.apks` should be transport-agnostic payloads: LAN/P2P/Bluetooth only carry bytes.

The installer was hardened to support APK/APKS input, including `content://` sources and Android's "install unknown apps" permission flow.

### B. Filename collision bug — diagnosed in MusabChat and inherited by G1

This is separate from split packaging.

If Android/MediaStore receives `MusabChat.apk` when a file already exists, some behavior can produce:

```text
MusabChat.apk (1)
```

instead of:

```text
MusabChat (1).apk
```

The former no longer ends in `.apk`, so Android may stop recognizing it as an installable package. The historical diagnostic evidence was that manually renaming the file so `.apk` became the final suffix restored normal Android recognition/icon behavior.

### Filename fix implemented

Incoming APK/APKS storage now attempts to own collision naming before MediaStore does:

```text
MusabChat.apk
MusabChat (1).apk
MusabChat (2).apk

MusabChat.apks
MusabChat (1).apks
```

The receiver also verifies the actual `MediaStore.DISPLAY_NAME` after insertion. If the platform/provider rewrites an APK/APKS filename into an invalid extension-ending form, the code rejects/deletes that candidate and retries with a safe collision name.

Incoming transfer events use the actual saved filename so UI/install logic does not continue referencing a stale requested name.

Commit associated with this filename fix during this session:

```text
0884a17786a9fe226bfecb78915f29395a7896e6
fix: preserve APK extensions across MediaStore filename collisions
```

---

## 13. Background availability / WhatsApp-like behavior discussion and implementation direction

A major product gap was identified: G1 historically tied too much networking lifetime to the React/UI lifecycle. A messaging app should remain available when the Activity is not visible.

### Architectural direction

Networking ownership should move progressively toward an Android native/background service:

```text
React/UI
   |
Connection Service
   |
   +-- persistent signaling listener
   +-- transport state
   +-- incoming events
   +-- active-session liveness
```

### Work implemented in this session

`ConnectionService` behavior was extended conceptually into two modes:

```text
Availability/Idle
  foreground service present
  listener can remain available
  avoid heavy locks

Active session
  connection/call/transfer active
  stronger wake/Wi-Fi lock behavior where justified
```

The signaling lifecycle was wired to drive service state so LAN is not treated as a second-class path that only gets background behavior after Wi-Fi Direct setup.

### Android limitation — never promise otherwise

If the user explicitly **Force Stops** the application from Android settings, Android intentionally prevents ordinary background resurrection until the user launches the app again. A direct local-only application cannot honestly promise WhatsApp-equivalent wakeup in that state.

Likewise, full process-death/Doze resilience still deserves further native/headless architecture work. The changes above are a foundation, not a claim that G1 has reached server-push/FCM-level background semantics.

---

## 14. Diagnostics improvements

Historical diagnostics showed `Device ID:` blank even while discovered peers had IDs. The diagnostics screen depended too heavily on parent props. A fallback was added so diagnostics can read persistent identity directly when needed.

Diagnostics should continue evolving to expose evidence, not assumptions:

```text
Device ID
Device Name
Local IP(s)
Listener 8089 state
mDNS advertising/discovering
Transport mode
Current signaling remote endpoint
Heartbeat state
Recovery state
Peer transport endpoints
Interface provenance
Generation/epoch
reachable/stale
```

This data is essential for future two-device testing.

---

## 15. Important commits produced during this development sequence

Representative commits created during the networking/file-transfer work include:

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

Do not assume every intermediate commit/build is independently production-ready. Many commits were incremental and triggered CI while the next fix was already being prepared.

---

## 16. CI history warning

GitHub Actions became visually noisy/red because many small commits triggered both push and pull-request workflow runs while development was still in progress.

Example: an older run failed JavaScript tests because introducing `NativeModules` into signaling required the Jest test to mock `react-native`. That was fixed in a later commit.

Therefore:

**Always judge the newest head workflow, not the historical red runs.**

At the time this document was created, head commit `0884a177...` had current workflow runs in progress. JavaScript unit tests and React Native bundling had passed in the observed latest run, while Android unit tests/build stages were still running. Re-check CI before distributing an APK.

---

## 17. Required two-device test matrix after a green build

Do not test everything randomly. Record logs from **both phones** whenever possible.

### Phase A — LAN only

Both devices on the same ordinary Wi-Fi network.

Verify:

1. Both discover each other with `192.168.0.x`-style LAN addresses and `interface=wlan0` (actual subnet may differ).
2. Establish signaling.
3. Leave connection idle >30 seconds.
4. Send text both directions.
5. Start/end audio call.
6. Start/end video call.
7. Send image A -> B.
8. Send image B -> A.
9. Send ordinary file A -> B.
10. Send ordinary file B -> A.
11. Send single-APK application both directions.
12. Send split-APK application (`.apks`) both directions.
13. Immediately send a chat message after each large transfer.
14. Repeat a filename collision and verify `Name (1).apk`, not `Name.apk (1)`.
15. Turn screen off/background app and test incoming message/call behavior.

Watch for:

```text
PING / PONG
HEARTBEAT_TIMEOUT
RECOVERY_SUCCESS
FT_INCOMING_DONE
FT_SENT_DONE
FT_ERROR
```

No generic success should be inferred merely from `8090 TIME-WAIT`.

### Phase B — Wi-Fi Direct only

Test independently. Do not require LAN or Bluetooth bootstrap.

Verify both-direction chat, call, image, file, APK/APKS transfer. Record P2P interface and group-owner/member addresses.

### Phase C — P2P teardown -> LAN rediscovery

1. Establish P2P.
2. Confirm P2P address (`192.168.49.x` typical).
3. Tear down P2P group.
4. Verify P2P endpoint becomes stale/unreachable.
5. Verify LAN discovery refreshes and returns the ordinary LAN address.
6. Reconnect via LAN.
7. Send file.
8. Confirm no file/signaling attempt uses stale `192.168.49.x` through `wlan0`.

### Phase D — AUTO orchestration

Only after individual transports are stable. Test automatic preference/fallback without making one transport a prerequisite for another.

---

## 18. Evidence discipline for future debugging

Always separate:

- **Proven from logs/code**
- **Strongly suspected**
- **Not proven**

Examples:

- `Broken pipe` proves a write was attempted on a TCP connection whose peer side was no longer writable from the sender's perspective.
- A Samsung-only log does **not** prove why Motorola closed the socket.
- `TIME-WAIT` on `8090` does **not** prove file-transfer failure.
- A stale `192.168.49.1` discovered while P2P group is active **is** proven P2P contamination when Android simultaneously identifies it as the group-owner address.

Do not turn correlation into root cause without the remote device log or direct code evidence.

---

## 19. Recommended next engineering sequence

1. Wait for the latest head CI to be fully green (JS, Android unit tests, Debug APK, Release APK).
2. Install the exact artifact from that head on both devices.
3. Run Phase A LAN test with logs from both devices.
4. Fix only reproducible failures from that matrix.
5. Run Phase B P2P independently.
6. Run Phase C P2P -> LAN transition.
7. Only then expand AUTO orchestration/handover logic.
8. Continue moving availability-critical networking ownership out of React UI lifecycle into native service architecture.
9. Add Bluetooth as an independent transport adapter when its own lifecycle is ready; never make it a mandatory bootstrap for LAN/P2P.

---

## 20. Non-negotiable architecture contract for future contributors

Before merging networking changes, verify all of these remain true:

- Peer identity is transport-independent.
- No global `peerIp` is treated as eternal truth.
- Every endpoint knows which transport/interface/network generation produced it.
- P2P endpoint dies with the P2P group.
- LAN endpoint is refreshed when its network changes.
- Signaling liveness is transport-agnostic.
- File transfer cannot own/kill signaling lifecycle.
- File success requires explicit completion/integrity confirmation.
- AUTO may prefer/fallback; MANUAL respects explicit transport choice.
- No transport requires another transport's negotiation to be usable.
- Background availability must not depend solely on an open React screen.
- APK/APKS packaging and filename correctness are application/file-layer concerns, not transport-layer concerns.

---

## 21. Final context for the next developer/agent

The project is no longer debugging only a single `ECONNREFUSED` bug. The work evolved into correcting transport/session ownership, endpoint freshness, bidirectional routing, transfer integrity, APK packaging, MediaStore naming, and background availability while preserving G1's transport-independent philosophy.

When continuing development, **do not solve a symptom by reintroducing a global IP, binding LAN to P2P, or tying file transfer to signaling teardown.** Those approaches recreate bugs already observed in field testing.

Prefer explicit state machines, transport-scoped endpoint state, two-device evidence, and regression tests around every reproduced failure.
