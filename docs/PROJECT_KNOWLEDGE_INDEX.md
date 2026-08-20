# G1 Public Project Knowledge Index

Status: **PUBLIC PRODUCT/ARCHITECTURE INDEX — NOT THE CANONICAL PRIVATE RESUME STATE**

This index describes stable public product architecture and points to historical/public engineering documents. It must not be used as the sole bootstrap source for a G1 project-authorized ChatGPT conversation.

For project-authorized agents with access, policy precedence and current volatile state live in `msabz/shizuku-controller`, beginning with `G1_POLICY_REGISTRY.md` and `CURRENT_CONTINUATION.md`. Live GitHub PR/branch/HEAD/CI metadata must be queried before edits.

## 1. Evidence order for public product facts

Use:
1. exact current code/tests on the branch/SHA being discussed;
2. exact-SHA CI evidence;
3. reproducible device evidence when available;
4. canonical private continuation for project-authorized work;
5. dated public/private handoffs and checkpoints;
6. external analogies/hypotheses.

Never convert an unverified hypothesis into fact. Never put credentials, signing material, tokens, private keys, raw device identifiers or personal data in public project memory.

## 2. Product definition

G1 DirectChat is an Android-first local/direct communications application. Its design objective is resilient peer-to-peer messaging, calls and high-speed file transfer across usable local transports without making one transport an obligatory prerequisite for another.

Normal users should interact with peers/conversations, not network plumbing. Discovery, route evaluation, selection, fallback, recovery and migration should progressively become hidden/automatic.

## 3. Stable architecture invariants

- Transport independence: LAN, Wi-Fi Direct and future Bluetooth are peer candidates, not a dependency chain.
- Any viable transport may bootstrap a session.
- `Identity != Route`; IP/MAC/deviceAddress/socket/interface data are ephemeral route metadata.
- `Discovery != Transport != Signaling Session`.
- `Control Plane != Data Plane`.
- Prefer make-before-break where possible; do not destroy a healthy route before validating replacement.
- One authoritative owner per concern.
- `ConnectionCoordinator` owns logical connection orchestration in the current architecture direction.
- `signaling.js` is the sole signaling/session/heartbeat owner unless a future evidence-backed migration deliberately changes that ownership.
- File-transfer failures must not silently own/destroy signaling.
- Recovery is bounded and explicit.
- Background delivery/call behavior is a product requirement where Android permits it; Force Stop is a distinct OS boundary.
- Security and user consent outrank convenience.

## 4. Public document map

Useful static/historical product documents include:
- `docs/CURRENT_CONTINUATION.md` — public pointer only; not canonical volatile memory.
- `docs/ARCHITECTURE_AND_STATE_MACHINES.md`
- `docs/DEVELOPMENT_RUNBOOK.md`
- `docs/GOALS_AND_ACCEPTANCE_CRITERIA.md`
- `docs/G1_NETWORKING_DEVELOPMENT_MEMORY.md`
- `docs/G1_NEXT_PHASE_PRODUCT_GOALS.md`
- `docs/G1_MESSAGING_CALLS_FEATURE_PARITY_GOALS.md`
- `docs/G1_FUTURE_UI_UX_VISION.md`
- `docs/RESEARCH_REFERENCES.md`
- `SECURITY_PUBLICATION_AUDIT.md`

Dated files such as `docs/DEVELOPMENT_HANDOFF_2026-08-17.md`, networking handoffs/checkpoints and `RESUME_AFTER_ACTIONS_RESET.md` are `HISTORICAL_REFERENCE`. Words such as `canonical`, `current`, `master` or `resume` inside those older snapshots do not make them current authority.

## 5. Logical system tree

```text
G1
├── Presentation / UX
├── Application runtime
│   ├── foreground UI
│   ├── background/call runtime
│   ├── persistence
│   └── notifications
├── Peer/session layer
│   ├── stable peer identity
│   ├── peer registry
│   └── route/capability knowledge
├── Signaling / control plane
│   ├── identity/handshake
│   ├── chat/call control
│   ├── heartbeat
│   └── bounded recovery
├── Transport orchestration
│   ├── discovery
│   ├── candidate evaluation
│   ├── LAN
│   ├── Wi-Fi Direct
│   └── future Bluetooth / migration
├── Data plane
│   └── files/images/voice/media payloads
└── Android integration
    ├── lifecycle/services
    ├── notifications/call UX
    ├── storage/MediaStore/URI
    └── package installation
```

## 6. Engineering decision discipline

For a networking change determine:
1. which stable peer/session state changes;
2. control plane vs data plane;
3. transport candidate independence;
4. ownership before/after the change;
5. migration/fallback behavior;
6. replacement validation before retiring a healthy route;
7. persisted/background behavior;
8. deterministic software tests;
9. real-device proof only where device/OEM behavior genuinely requires it.

## 7. Evidence vocabulary

- `CONFIRMED` — demonstrated by exact code/test/device evidence.
- `LIKELY` — strongly supported but missing decisive evidence.
- `HYPOTHESIS` — plausible and awaiting proof.
- `GOAL` — intended future behavior.
- `NOT VERIFIED` — explicitly unproven.

CI success is not physical-device success.

## 8. CI and current state

GitHub Actions is the canonical hosted build/test environment for the public product repository where applicable. Never assume a remembered/embedded old CI result applies to a new HEAD.

This index deliberately contains no `current HEAD`, run number or artifact. Query the live active branch/PR and its exact-SHA workflow results.

## 9. Definition of done

A product change is not done merely because it compiles. Applicable completion requires:
- relevant tests;
- exact-SHA CI;
- security/privacy preserved;
- deterministic ownership/state behavior;
- failure/recovery coverage;
- device evidence where the mission requires real Android/OEM proof;
- canonical durable project memory updated by project-authorized work.