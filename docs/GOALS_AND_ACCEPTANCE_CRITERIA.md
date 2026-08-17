# G1 Goals and Acceptance Criteria

These are product/engineering targets. A target is not an implemented fact until tests/evidence confirm it.

## P0 — Reliability foundation
### Transport-independent connectivity
Goal: no transport is a mandatory prerequisite for another.
Acceptance:
- peer can connect using any independently available supported transport;
- losing one transport does not prevent trying another;
- preferred-route upgrade is make-before-break;
- route change does not change peer/conversation identity;
- duplicate connection races converge deterministically.

### Signaling liveness and recovery
Acceptance:
- heartbeat exists on every active signaling path;
- dead sockets are detected without waiting indefinitely for user traffic;
- bounded recovery can replace a transiently dead route;
- recovery cannot create unbounded duplicate sockets/timers;
- both success and exhaustion are observable in logs/tests.

### File transfer must not destabilize chat/calls
Acceptance:
- data-plane lifecycle is isolated from signaling lifecycle;
- transfer failure/cancel does not silently disconnect the logical peer session;
- simultaneous chat during transfer works;
- throughput and failure reasons are measurable.

## P0 — Background communications
Goal: ordinary app closure/task dismissal should not make G1 appear offline when Android permits continued operation.
Acceptance:
- inbound messages are persisted once and notified when UI is detached;
- incoming calls have visible actionable Android notification UI, not ringtone alone;
- foreground/background ownership cannot duplicate messages/call handling;
- process/service lifecycle is tested on target Android versions/OEMs;
- Force Stop remains explicitly outside delivery guarantees.

## P0 — APK sharing/install UX
Acceptance:
- received APK filename always ends in `.apk`;
- duplicates use `Name (n).apk`;
- installer receives a valid readable URI and MIME type;
- unknown-source permission transition returns coherently to install flow;
- user sees the normal package installer progress/result UI;
- APK bytes/signature are never modified by filename handling.

## P1 — Transfer performance
Goal: meet or exceed the useful transfer behavior previously observed in MusabChat without compromising architecture.
Acceptance:
- benchmark same file/device pair/transport under controlled conditions;
- record sustained MiB/s, startup latency and CPU/memory pressure;
- identify bottleneck by measurement (buffering, JS bridge, filesystem, socket, network negotiation, hashing), not assumption;
- optimize chunk size/backpressure/streaming path while keeping signaling responsive;
- performance regression test or benchmark procedure is documented.

## P1 — Automatic hidden networking
Acceptance:
- normal user does not manually choose LAN vs Wi-Fi Direct for routine operation;
- discovery and route selection run within Android platform limits;
- application immediately uses an available viable path rather than waiting for a preferred unavailable one;
- better route can be adopted later without conversation reset;
- diagnostic mode can expose selected route and reason.

## P1 — Messaging feature completeness
Targets include delete conversation, delete message, share/forward, copy, text selection/cut/paste where semantically applicable, reply/quote, media/file actions and coherent persistence semantics.
Acceptance requires explicit local-vs-peer deletion semantics; never imply remote deletion unless protocol acknowledgement implements it.

## P1 — Calls and history
Acceptance:
- explicit incoming/outgoing/missed/declined/busy/failed records;
- in-app call history survives restart;
- system call-log integration only if Android-supported role/API/permissions and product policy are satisfied;
- call state survives UI detach without duplicate runtimes.

## P2 — Future UI
Goal: visually advanced/futuristic but operationally simple.
Acceptance:
- network automation reduces visible controls rather than adding technical complexity;
- primary actions remain immediately understandable;
- motion/effects do not harm accessibility or performance;
- connection uncertainty is communicated clearly without exposing implementation jargon;
- design remains usable on mid-range Android hardware.

## Quality gates for every milestone
- CI green.
- No secrets/security regression.
- Automated tests for deterministic logic.
- Real-device evidence for Android/platform behavior.
- Performance claims backed by measurements.
- Permanent documentation updated only when the conclusion is durable.
