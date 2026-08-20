# G1 Public Continuation Pointer

Status: **PUBLIC-SAFE MIRROR / NOT CANONICAL VOLATILE MEMORY**

This file intentionally does not publish a hard-coded `current HEAD`, CI run, artifact, device-session allowance or exact private resume checkpoint because those values change and previously drifted from the live PR.

For project-authorized ChatGPT/agents with access, canonical G1 project control and volatile continuation live in:

- `msabz/shizuku-controller/G1_POLICY_REGISTRY.md`
- `msabz/shizuku-controller/CURRENT_CONTINUATION.md`

Always query live GitHub PR/branch/HEAD/CI metadata before editing. If a public document, PR body, dated handoff or model memory disagrees with live/canonical project memory, perform reconciliation rather than choosing the older snapshot.

## Current public engineering phase

The active public product work remains PR #18:
`Phase 6b-b: migrate outbound P2P ownership to coordinator`.

Wi-Fi Direct remains the active transport mission until canonical project memory explicitly records its successful completion. Bluetooth must not be used as a workaround or started as the next project mission early.

## Stable architecture invariants

- `Identity != Route`.
- `Discovery != Transport != Signaling Session`.
- `Control Plane != Data Plane`.
- LAN/Wi-Fi Direct/future Bluetooth are independent candidates.
- make-before-break where applicable.
- one owner per concern.
- `ConnectionCoordinator` owns logical connection orchestration.
- `signaling.js` remains the sole signaling socket/session/heartbeat owner unless a later evidence-backed migration deliberately changes that contract.
- generic Wi-Fi Direct availability is not stable G1 identity.
- preserve proven P2P network-binding behavior unless evidence explicitly supersedes it.
- Shizuku/rish/G1LAB are lab infrastructure, never production dependencies.

## Validation discipline

Public/product development must preserve:
- research/source-first causal diagnosis;
- relevant Project Source/AOSP/CTS/open-source/current-web comparison where applicable;
- mechanical diff review;
- exact-SHA CI;
- CI is not device proof;
- bounded automation-first physical proof only after the private project confidence/device gates are satisfied;
- no product PR merge without explicit user authorization.

## Historical documents

Dated public handoffs, development memory, `RESUME_AFTER_ACTIONS_RESET.md` and older `CURRENT_CONTINUATION` contents are historical references. Their embedded SHA/build/run values are snapshots, not current-state authority.

For the exact active HEAD, CI, latest physical evidence and next action, use the private canonical continuation plus live GitHub.