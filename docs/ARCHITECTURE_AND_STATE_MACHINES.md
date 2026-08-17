# G1 Architecture and State Machines

This document defines the intended control logic. It is a design contract, not a claim that every item is already implemented.

## Core model
Model a peer separately from a route.

```text
Peer
  stableIdentity
  capabilities
  conversationState
  callState
  routes[]

Route
  transportType
  address/interface
  availability
  health
  latency/throughput estimate
  lastValidatedAt
  session/socket handle
```

Never key durable conversation identity only by IP address.

## Discovery state machine
```text
IDLE
  -> SCANNING
SCANNING
  -> CANDIDATES_FOUND
  -> IDLE (policy/backoff)
CANDIDATES_FOUND
  -> VALIDATING
VALIDATING
  -> AVAILABLE
  -> DEGRADED/UNAVAILABLE
AVAILABLE
  -> VALIDATING when network changes
  -> UNAVAILABLE when evidence proves loss
```

Discovery runs independently per transport. Results merge into the peer registry.

## Connection/session state machine
```text
DISCONNECTED
  -> CONNECTING(candidate)
CONNECTING
  -> ACTIVE(route)
  -> TRY_NEXT(candidate)
  -> DISCONNECTED
ACTIVE
  -> RECOVERING on transient failure
  -> MIGRATING when a preferable route is validated
  -> DISCONNECTED on terminal loss
RECOVERING
  -> ACTIVE(recovered/new route)
  -> TRY_NEXT
  -> DISCONNECTED
MIGRATING
  -> ACTIVE(new route) only after validation
  -> ACTIVE(old route) if migration fails and old route remains healthy
```

Rules:
- Do not tear down a healthy active route merely because a higher-priority candidate was discovered.
- Validate replacement first.
- Duplicate inbound/outbound races must converge to one logical peer session by deterministic tie-breaking.
- Heartbeat detects liveness; it must not become peer identity.
- Recovery windows are bounded. Infinite reconnect loops are prohibited.

## Transport selection
Selection should evolve from fixed fallback order into scoring. Candidate score may include:
- currently validated/connected;
- expected throughput;
- latency;
- stability history;
- energy cost;
- metered/non-metered status where relevant;
- ability to support the requested operation;
- migration cost.

Policy examples:
- A working LAN path can bootstrap immediately.
- Wi-Fi Direct may be preferred for bulk transfer when validated and measurably better.
- A chat message should not wait for Wi-Fi Direct formation if a valid LAN signaling route already exists.
- A file transfer may upgrade to a faster data route without making signaling dependent on that route.

## Control plane vs data plane
Control plane carries identity, handshake, chat signaling, call signaling, route announcements, heartbeat and recovery metadata.

Data plane carries file/image/voice bulk bytes and call media where applicable.

A data-plane transfer should use a transfer ID, explicit lifecycle, bounded resources, progress, cancellation and integrity checks. Its socket lifecycle must not own the signaling lifecycle.

## Background runtime
Desired behavior:
```text
UI attached
  -> UI owns presentation; runtime avoids duplicate persistence/notifications
UI detached but process/service alive
  -> background runtime persists inbound data and surfaces notifications/calls
Process removed by ordinary task dismissal
  -> Android component strategy should restore/maintain permitted receive capability
Force Stop
  -> no delivery guarantee; Android intentionally suppresses app components
```

Incoming calls require a call-specific notification surface with answer/decline actions and appropriate Android APIs. A ringtone without an actionable incoming-call surface is incomplete behavior.

## File/APK lifecycle
```text
SELECT
 -> METADATA
 -> ROUTE_SELECT
 -> OFFER/START
 -> STREAM
 -> VERIFY
 -> COMMIT_TO_STORAGE
 -> PERSIST_MESSAGE
 -> USER_OPEN
```

APK invariant: final display name must end in `.apk`. Collision numbering goes before the extension:
`App.apk`, `App (1).apk`, `App (2).apk`.
Never produce `App.apk (1)`.

APK installation must use Android's supported package-installer flow and URI permissions. The app must not fake or bypass the platform's unknown-source consent. If installer UI disappears unexpectedly, investigate intent flags, URI lifetime, activity/task behavior and OEM package installer behavior with device logs.

## Calls
Call state should be explicit, e.g.:
```text
IDLE -> OUTGOING_DIALING -> RINGING -> ACTIVE -> ENDED
IDLE -> INCOMING_RINGING -> ACTIVE -> ENDED
INCOMING_RINGING -> DECLINED/MISSED
OUTGOING_DIALING/RINGING -> CANCELLED/BUSY/FAILED
```

Call history is a separate persistence concern from active call state. Android system call-log integration must be implemented only through supported APIs/roles/permissions; otherwise maintain an in-app call history rather than pretending system integration exists.

## Automation target
The final UX should hide network mechanics:
1. continuously discover viable peer routes within OS limits;
2. merge routes by stable peer identity;
3. select a usable route immediately;
4. upgrade opportunistically after validation;
5. downgrade/recover automatically;
6. expose manual transport controls only for diagnostics or explicit advanced-user choice.

Automation must remain observable through structured logs so failures can be diagnosed without exposing complexity to normal users.
