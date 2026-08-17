# G1 Project Knowledge Index

Status: canonical entry point for humans and AI agents continuing G1 development.

## 1. Source-of-truth order
When information conflicts, use this order:
1. Current code and automated tests on `main`.
2. Reproducible device logs and captured evidence.
3. This knowledge index and architecture invariants.
4. Dated handoff/development-memory documents.
5. Hypotheses and external analogies.

Never convert an unverified hypothesis into a fact. Never put credentials, signing passwords, private keys, tokens, device identifiers, or personal data in project memory.

## 2. Product definition
G1 DirectChat is an Android-first local/direct communications application. Its core design objective is resilient peer-to-peer messaging, calls and high-speed file transfer across whatever usable local transport exists, without forcing one transport to be a prerequisite for another.

The user should interact with peers and conversations, not network plumbing. Discovery, route evaluation, transport selection, upgrade, downgrade and recovery should increasingly become automatic and hidden.

## 3. Non-negotiable architecture invariants
- Transport independence: LAN, Wi-Fi Direct and future transports are peers in capability, not a mandatory dependency chain.
- Any viable layer may bootstrap a session. Bluetooth or another low layer must never become a mandatory negotiation prerequisite.
- Prefer the best currently viable route, but availability of a preferred route must not destroy a working lower-priority route before replacement is proven healthy.
- Control/signaling and bulk file transfer are logically separate. A file transfer failure must not silently kill signaling.
- Transport migration is make-before-break whenever the platform permits it.
- Peer identity is stable; IP addresses, sockets and interfaces are ephemeral route attributes and must not become identity.
- Recovery is explicit state-machine behavior, not scattered reconnect side effects.
- Background delivery/call behavior is a product requirement, while Android Force Stop is explicitly outside the promise because the OS suppresses app execution.
- Security and user consent outrank convenience. Never silently weaken Android installation, permission, signing or sandbox boundaries.

## 4. Canonical documents
Read these before substantial changes:
- `docs/DEVELOPMENT_HANDOFF_2026-08-17.md` — broad implementation handoff and known state.
- `docs/DEVELOPMENT_HANDOFF_NETWORKING_2026-08-17.md` — networking-specific handoff.
- `docs/G1_NETWORKING_DEVELOPMENT_MEMORY.md` — detailed networking history, evidence and decisions.
- `docs/G1_NEXT_PHASE_PRODUCT_GOALS.md` — product roadmap.
- `docs/G1_MESSAGING_CALLS_FEATURE_PARITY_GOALS.md` — messaging/calling parity targets.
- `docs/G1_FUTURE_UI_UX_VISION.md` — future-facing UI direction.
- `SECURITY_PUBLICATION_AUDIT.md` — public-repository security constraints.
- `RESUME_AFTER_ACTIONS_RESET.md` — historical CI/recovery context; use only where still applicable.

Supporting operational documents added with this index:
- `docs/ARCHITECTURE_AND_STATE_MACHINES.md`
- `docs/DEVELOPMENT_RUNBOOK.md`
- `docs/RESEARCH_REFERENCES.md`
- `docs/GOALS_AND_ACCEPTANCE_CRITERIA.md`

## 5. Logical system tree
```text
G1
├── Presentation / UX
│   ├── conversations and messages
│   ├── calls and incoming-call surface
│   ├── file/application sharing
│   └── connection state shown only when useful
├── Application runtime
│   ├── foreground UI runtime
│   ├── BackgroundRuntime
│   ├── CallRuntime
│   ├── persistence
│   └── notifications
├── Peer/session layer
│   ├── stable peer identity
│   ├── peer registry
│   ├── active logical session
│   └── route/capability knowledge
├── Signaling/control plane
│   ├── handshake / identity
│   ├── chat and call control
│   ├── heartbeat
│   ├── disconnect observation
│   └── transient recovery
├── Transport orchestration
│   ├── discovery
│   ├── candidate scoring
│   ├── LAN
│   ├── Wi-Fi Direct
│   ├── upgrade/downgrade
│   └── fallback/recovery
├── Data plane
│   ├── file transfer
│   ├── image/voice payloads
│   ├── APK naming/storage
│   └── throughput/backpressure
└── Android integration
    ├── foreground/background services
    ├── notifications / full-screen call UX where permitted
    ├── MediaStore / URI permissions
    ├── package installation intents
    └── Telecom/call-log integration where platform policy permits
```

## 6. Development decision rule
For every networking change answer, in order:
1. What stable peer/session state is being changed?
2. Is this control plane or data plane?
3. Which transport(s) are candidates, and are they independent?
4. What happens if the preferred transport appears mid-session?
5. What happens if it disappears during signaling, call, or file transfer?
6. Is replacement proven healthy before the old route is released?
7. What state is persisted across foreground/background transitions?
8. What deterministic test reproduces success, timeout, duplicate connection and recovery?
9. What two-device Android test proves the behavior on real hardware?

## 7. Evidence discipline
Classify findings as:
- CONFIRMED: demonstrated by code, automated test, or captured device logs.
- LIKELY: strongly supported but missing one side of evidence.
- HYPOTHESIS: plausible explanation awaiting reproduction.
- GOAL: intended future behavior, not implemented fact.

A Samsung-only log cannot establish the internal reason a Motorola peer closed a socket. A `Broken pipe` establishes a failed write to a dead/broken socket; the remote cause requires remote evidence.

## 8. Current CI baseline
The public clean-history repository uses GitHub-hosted Actions as the canonical build/test environment. Local Android building on the user's phone is not part of the development workflow. JavaScript tests and Android validation must remain green before device testing is treated as a candidate release.

## 9. Definition of done
A change is not done merely because it compiles. It is done when:
- relevant automated tests pass;
- CI is green;
- no secret/security regression is introduced;
- state-machine behavior is deterministic;
- failure and recovery paths are tested;
- for transport/background/call/file changes, a real two-device test plan exists and the result is recorded;
- durable architectural changes are reflected in project memory.
