# G1 DirectChat — Validated Baseline & Next-Phase Product Goals

**Repository:** `msabz/G1`  
**Branch at time of writing:** `feat/zero-config-lan-discovery`  
**Companion memory:** `docs/G1_NETWORKING_DEVELOPMENT_MEMORY.md`  
**Purpose:** Record the post-field-test baseline and the product/engineering goals agreed after the latest successful two-device validation.

> This file is intentionally forward-looking. The main networking memory documents history, root causes, previous fixes, and architectural decisions. This file defines what is now considered working and what the next development phase must achieve without breaking the validated baseline.

---

## 1. Current field-validated baseline

After the latest fix batch was built, installed on the test phones, and exercised manually, the user reported that the core application behavior was working correctly.

Treat the current successful build as a **Known Good Baseline** for regression purposes.

The current baseline is understood to include the major fixes developed in the preceding session:

- persistent signaling listener on TCP `8089`;
- zero-configuration LAN discovery;
- transport-scoped peer endpoints instead of one global authoritative peer IP;
- stale P2P/LAN endpoint mitigation;
- signaling heartbeat/liveness work;
- transient signaling recovery;
- symmetric route exchange between initiator and receiver;
- bidirectional file sending fixes;
- file-transfer route preference using the live signaling peer endpoint before stale cached addresses;
- independent bulk transfer on TCP `8090`;
- streamed SHA-256 verification and explicit completion ACK;
- improved support for unknown/large file sizes;
- APK/APKS packaging improvements;
- APK/APKS filename collision handling that preserves the extension at the end;
- Android installation support for APK/APKS;
- initial background availability service work.

Do not refactor these areas casually. Future work must include regression testing against this baseline.

---

## 2. Product philosophy remains unchanged

The following constraints are product-level rules, not implementation suggestions.

### 2.1 Independent transports

LAN, Wi-Fi Direct, and Bluetooth must each remain capable of functioning independently.

A transport must **not** require another transport to succeed before it can negotiate or operate.

Invalid dependency examples:

```text
Bluetooth must succeed before Wi-Fi Direct can start    -> NOT ALLOWED
LAN must succeed before P2P can negotiate                -> NOT ALLOWED
P2P must bootstrap through Bluetooth                     -> NOT REQUIRED
```

### 2.2 Preference and automatic promotion are allowed

Transport independence does **not** mean all transports have equal priority at all times.

An upper orchestration layer may automatically prefer a better transport when available.

Example:

```text
LAN available and healthy
    -> prefer LAN

LAN unavailable
    -> consider Wi-Fi Direct

P2P unavailable/degraded
    -> consider Bluetooth
```

This is orchestration, not dependency.

### 2.3 AUTO must become the normal user experience

The normal user should not be asked to understand:

- IP addresses;
- interfaces;
- P2P Group Owner addresses;
- endpoint generations;
- discovery mechanisms;
- transport routing decisions.

The target experience is:

```text
open G1
-> peers appear automatically
-> choose a person/device
-> G1 selects the best available route
-> G1 maintains/falls back/promotes automatically
```

Developer/Advanced Mode may expose manual transport forcing and diagnostics.

### 2.4 Current transport and preferred transport are different concepts

Do not migrate a healthy active call or large transfer simply because a nominally better transport appears.

Maintain at least the conceptual distinction:

```text
currentTransport
preferredTransport
```

A preferred route may be recorded without immediately disrupting a stable session.

---

## 3. Priority Goal A — App remains reachable after UI is fully closed

### Exact user requirement

This does **not** mean Android `Settings -> Apps -> G1 -> Force Stop`.

Force Stop is explicitly outside the requirement.

The required scenario is:

1. user opens G1 normally;
2. user leaves/closes the UI;
3. user removes G1 from Android Recent Apps;
4. G1 Activity/React UI is no longer visible;
5. no explicit Force Stop was performed;
6. another peer sends a message or initiates a call;
7. G1 must remain reachable and handle the event.

Target product rule:

> **Closing the G1 UI must not mean going offline.**

### Required behavior

When the UI is gone from Recents, G1 should still be able to:

- listen for incoming signaling;
- remain discoverable/available according to active transport policies;
- receive incoming chat signaling;
- receive incoming RTC/call offers;
- store incoming application events safely when React UI is not running;
- show Android notifications;
- reopen/synchronize UI state when the user taps a notification or reopens G1.

### Architectural target

The long-term ownership model should move toward:

```text
React Native UI / Activity
        |
        | client of service
        v
Native Connection / Availability Service
        |
        +-- signaling listener 8089
        +-- transport availability/discovery lifecycle
        +-- active signaling session state
        +-- heartbeat/liveness
        +-- incoming event parsing/dispatch
        +-- persistent incoming event queue
        +-- notifications/call integration
```

React Native should not be required to remain alive continuously just to keep the device reachable.

### Android lifecycle expectation

Target where technically reasonable:

```text
Activity closed / removed from Recents      -> reachable
screen off                                  -> reachable
normal background                           -> reachable
Android process recreation                  -> service/listeners restore automatically
explicit Android Force Stop                 -> NOT guaranteed / outside target
```

Do not claim Force Stop can be bypassed.

---

## 4. Priority Goal B — Native incoming-call notification UX

### Current field behavior

When G1 is in the background:

- incoming messages already produce a notification;
- incoming calls can ring;
- however, the user does **not** receive a proper incoming-call notification comparable to modern messaging apps;
- there is no reliable notification UI with direct **Answer** / **Reject** actions.

This proves that incoming RTC signaling/ringing can occur, but Android call-notification integration is incomplete.

### Required target behavior

When an incoming call arrives while G1 is backgrounded or UI is closed:

```text
rtc-offer / incoming call
        -> native call manager
        -> high-importance call notification
        -> visible caller identity
        -> Answer action
        -> Reject action
        -> ringtone coordinated with callId
```

When appropriate under Android policies, support heads-up / call-style notification behavior and lock-screen/full-screen call presentation.

### Native ownership

Do not make this depend on an already-running React screen.

Recommended conceptual native component:

```text
IncomingCallManager
    +-- call notification
    +-- ringtone
    +-- ACTION_ACCEPT_CALL
    +-- ACTION_REJECT_CALL
    +-- ACTION_OPEN_CALL
    +-- callId/session coordination
```

Answer/reject actions should be handled by native service/receiver logic robustly enough to work while UI is backgrounded.

### State consistency requirement

Ringtone, notification, signaling call state, and displayed UI must all be tied to the same call/session identifier.

Do not allow independent code paths where the phone rings but notification state does not know about the call.

---

## 5. Priority Goal C — Restore MusabChat-class file-transfer speed

### Current field observation

The new G1 transfer path works, but file transfer is visibly slower than MusabChat/H100.

Transfer speed was considered a distinctive strength of MusabChat and should remain a competitive strength in G1.

### Performance target

G1 should aim to match or exceed MusabChat throughput on equivalent hardware/network conditions while retaining correctness improvements.

Do **not** solve speed by removing integrity guarantees blindly.

Retain where feasible:

- streaming transfer;
- SHA-256 verification;
- final completion ACK;
- separation of `8090` bulk data from `8089` signaling;
- route correctness and stale-endpoint protection.

### Suspected current overhead to profile

Potential hot-path overhead includes:

- small `64 KiB` transfer buffers;
- frequent `flush()` operations;
- progress events every ~256 KiB;
- excessive React Native bridge traffic during fast transfers;
- socket buffer defaults;
- per-chunk or too-frequent control work;
- unnecessary endpoint/discovery work while an established data socket is already healthy.

These are profiling targets, not yet proven bottlenecks.

### Desired fast-path architecture

```text
Control plane
  rich state, negotiation, route decisions, integrity status

Data plane
  native
  streaming
  large efficient buffers
  minimal syscalls/flushes
  throttled progress reporting
  no JS work per chunk
  one final verification/ACK sequence
```

Potential optimizations to benchmark systematically:

- compare `64 KiB`, `256 KiB`, `512 KiB`, and possibly larger buffers;
- avoid explicit `flush()` during each progress report unless required;
- throttle UI progress by time (e.g. 250–500 ms) or multi-megabyte increments instead of 256 KiB;
- tune socket send/receive buffer sizes where Android allows;
- keep hash computation streaming in the same pass;
- keep final ACK once per completed transfer;
- avoid JS bridge interactions in the bulk-copy loop.

### Measurement rule

Do not optimize by feeling alone. Add measurable telemetry:

```text
transferId
transport
bytes
elapsedMs
averageMbps
peak/progress Mbps if useful
buffer size
hash time if separable
ack latency
```

Compare G1 and MusabChat on the same two devices and same transport before declaring performance parity.

---

## 6. Priority Goal D — APK/APKS installation UX must look normal and trustworthy

### Current behavior

APK/APKS transfer and installation can succeed.

On first install attempt Android correctly asks the user to allow installation from unknown sources for G1.

After permission is granted and the user triggers installation, the current flow may visually disappear or provide no clear installation UI for some time. Later G1 reports that installation succeeded, and the app is indeed installed.

Technically successful, but poor UX: users may think nothing is happening.

### Required UX

The user must always see an explicit installation state.

For example:

```text
Preparing application...
Installing application...
Waiting for Android confirmation...
Installed successfully
```

Do not leave the user with a blank transition or unexplained delay.

### Single APK preference

For a normal single `.apk`, prefer the standard Android package installer UI where possible so the user sees the familiar system flow, application identity/icon, install confirmation, and progress/result behavior.

### Split APKS

For `.apks` / multi-split installation, Android `PackageInstaller.Session` may need to remain under G1 control.

In that case G1 must provide clear in-app progress/state and handle PackageInstaller result states explicitly, including conceptually:

```text
PENDING_USER_ACTION
SUCCESS
FAILURE_*
```

If Android requests user interaction, launch the required intent immediately rather than leaving installation apparently invisible.

### Existing correctness rules remain

Do not regress:

- `sourceDir + splitSourceDirs` packaging;
- complete `.apks` bundles;
- one PackageInstaller session for all required splits;
- `content://` handling;
- actual final saved filename;
- `.apk` / `.apks` extension at the end of duplicate filenames.

---

## 7. Priority Goal E — Fully automatic hidden transport orchestration

The app should eventually treat discovery, transport selection, route freshness, fallback, and promotion as background infrastructure.

### User-facing model

The user sees:

```text
Peer: moto g35 5G — Online
```

not:

```text
LAN 192.168.0.36
P2P 192.168.49.1
wlan0
p2p-wlan0-0
```

### Internal model

The network layer may see multiple independent routes:

```text
PeerIdentity
  LAN endpoint(s)
  P2P endpoint(s)
  Bluetooth endpoint(s)
```

The orchestrator evaluates them and chooses policy-wise.

### Desired policy characteristics

- prefer high-throughput/stable local networking when healthy;
- allow automatic fallback when the current transport truly fails;
- re-resolve stale endpoints before retrying;
- never reuse a transport endpoint whose network/group generation is no longer valid;
- permit promotion to a better transport when safe;
- avoid disruptive handover during stable calls/transfers unless necessary;
- respect manual transport forcing in Developer/Advanced mode.

### Critical rule

AUTO logic must remain above transports. It must not turn transport protocols into a dependency chain.

---

## 8. Background messaging/event persistence target

As native background ownership improves, incoming events must not disappear because React Native is not currently attached.

Target flow:

```text
network event
   -> native service
   -> validate/parse
   -> persistent event/message storage
   -> Android notification
   -> UI reads/synchronizes state when opened
```

Avoid:

```text
network event
   -> emit JS event
   -> JS runtime not alive
   -> event lost
```

This applies especially to:

- chat messages;
- call offers/rejects/end events;
- completed incoming file metadata;
- possibly deferred session/reconnect state.

---

## 9. Known Good Baseline protection

Because the latest installed build was reported working in general, every change in the next phase should be tested against the current baseline.

Minimum regression checks after changes:

1. LAN discovery and connection both directions.
2. text both directions.
3. voice call.
4. video call.
5. image both directions.
6. generic file both directions.
7. APK and APKS transfer/install.
8. duplicate APK filename remains `Name (1).apk`.
9. chat still works immediately after file transfer.
10. Wi-Fi Direct still works independently.
11. stale P2P endpoints do not pollute LAN routing.
12. signaling remains independent from file-transfer socket lifecycle.

New phase-specific checks:

13. remove G1 from Recent Apps and send message.
14. remove G1 from Recent Apps and initiate call.
15. background incoming call shows Answer/Reject notification.
16. answer from notification.
17. reject from notification.
18. verify install UI/progress is visible.
19. benchmark large-file throughput against MusabChat.
20. verify integrity ACK remains correct at optimized transfer speed.

---

## 10. Priority order for implementation

Recommended order, unless a new field regression changes priorities:

### P0 — Preserve current stable networking

No broad rewrite that destabilizes the validated LAN/P2P/file baseline.

### P1 — Background reachability after UI removal

Move enough ownership into native/service lifecycle that removing G1 from Recents does not make it offline.

### P1 — Incoming call notification actions

Implement native call-style notification behavior with Answer/Reject and consistent callId state.

### P1 — File-transfer performance

Profile first, then optimize the native `8090` hot path to MusabChat-class throughput without discarding integrity.

### P1 — APK/APKS install visibility

Provide normal Android installer UI for single APK where appropriate and explicit installation progress/state for PackageInstaller session flows.

### P2 — Complete AUTO transport orchestration

Hide discovery/route selection from normal users while keeping Developer mode overrides.

### P2 — Durable event persistence / process recreation

Ensure incoming data survives UI/runtime absence and process/service reconstruction appropriately.

---

## 11. Definition of success for the next milestone

The next major milestone should not be considered complete until a user can perform this sequence:

```text
1. Open G1 on two phones.
2. Let AUTO discover and connect without IP entry.
3. Close one phone's G1 UI and remove it from Recents.
4. Send it a message -> notification arrives.
5. Call it -> visible incoming-call notification appears with Answer/Reject.
6. Answer or reject directly from notification correctly.
7. Reopen G1 -> state/messages are consistent.
8. Transfer a large file -> throughput is at least comparable to MusabChat under the same conditions.
9. Transfer/install a normal APK -> standard/clear install UI is visible.
10. Transfer/install a split APKS -> explicit installation progress/result is visible.
11. Repeat file/APK actions in both directions.
12. LAN/P2P independence remains intact and no transport becomes a mandatory bootstrap for another.
```

---

## 12. Non-goals / platform boundaries

The current requested goal does **not** include bypassing Android explicit Force Stop.

Do not spend engineering effort trying to circumvent:

```text
Settings -> Apps -> G1 -> Force Stop
```

The target is normal app closure/removal from Recents and ordinary Android background/process lifecycle behavior.

Likewise, do not introduce a central cloud server merely to imitate WhatsApp push behavior unless product direction explicitly changes later. G1 currently prioritizes direct/serverless communication semantics.

---

## 13. Handoff instruction

Any developer or coding agent continuing from this point should read, in order:

1. `docs/G1_NETWORKING_DEVELOPMENT_MEMORY.md`
2. `docs/G1_NEXT_PHASE_PRODUCT_GOALS.md`
3. exact current branch/commit CI status
4. relevant runtime diagnostics/logs from both devices before attributing a new network failure

The existing networking memory is the historical/root-cause reference. This document is the current product target.
