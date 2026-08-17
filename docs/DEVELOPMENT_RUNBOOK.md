# G1 Development Runbook

## Working model
Canonical remote: `msabz/-G1-public`.
Canonical validation: GitHub Actions. Do not require local Android builds on the user's phone.

## Before editing
```bash
git status
git fetch --all --prune
git log --oneline -10
```
Confirm CI baseline before attributing a new failure to your change.

## Standard validation
JavaScript/unit layer:
```bash
npm ci
npm test -- --runInBand
```
Android validation should be performed by the repository's GitHub Actions workflow. Do not invent a different Gradle command without reading the workflow and Gradle configuration first.

Inspect Actions from Termux without building locally:
```bash
gh run list -R msabz/-G1-public --limit 5
gh run view -R msabz/-G1-public --log-failed
```

## Change protocol
1. Reproduce or identify the exact requirement.
2. Read the current implementation and relevant tests.
3. State the invariant being protected.
4. Make the smallest coherent architectural change, not a symptom patch.
5. Add/update deterministic tests.
6. Push and wait for CI.
7. If CI fails, diagnose the first causal failure, not downstream noise.
8. For Android/network behavior, run a controlled device matrix.
9. Record confirmed results in the handoff/memory docs.

## Two-device network test matrix
Record both devices' model/Android version, but never secrets or personal identifiers.

Test separately:
- LAN only, same Wi-Fi.
- Wi-Fi Direct only where practical.
- Start on LAN, then make Wi-Fi Direct available.
- Start on Wi-Fi Direct, then restore LAN.
- Chat during route change.
- Call setup during route change.
- File transfer while signaling remains active.
- Peer app foreground/background/task-dismissed states.
- Do not conflate Force Stop with ordinary app closure.

Capture synchronized logs from both peers whenever diagnosing who closed a socket.

## Signaling diagnostics
Search for structured events such as:
```text
INBOUND_ACCEPTED
OUTBOUND_CONNECTED
SESSION_ACTIVE
PING
PING_RECEIVED
PONG_SENT
HEARTBEAT_TIMEOUT
SESSION_DISCONNECTED
RECOVERY_WINDOW_OPEN
RECOVERY_REDIAL_START
RECOVERY_SUCCESS
RECOVERY_EXHAUSTED
DUPLICATE_INBOUND_REJECTED
CONNECT_REUSED
CONNECT_REUSE_REJECTED
ROUTE_ANNOUNCED
```
Interpretation rule: `Broken pipe` proves the local write failed because the connection was no longer writable. It does not by itself prove why the remote side disappeared.

## File-transfer diagnostics
Record:
- transfer ID;
- source/destination peer route;
- selected transport;
- byte count;
- timestamps and throughput;
- cancellation/failure reason;
- signaling health before/during/after transfer;
- destination storage URI/name.

Never infer that a slow transfer is caused by signaling merely because both occurred at the same time. Measure data-plane throughput and socket behavior.

## APK regression checklist
- original APK bytes preserved;
- final filename ends with `.apk`;
- collision suffix is before extension;
- MIME type is appropriate;
- content/file URI remains readable by package installer;
- unknown-app-source permission flow works;
- installer activity remains visible and comprehensible;
- successful installation does not depend on renaming manually.

## Background/call checklist
Test these as distinct states:
1. foreground;
2. background;
3. task dismissed/swiped away;
4. process reclaimed by OS;
5. device idle/Doze where applicable;
6. Force Stop (documented unsupported until user relaunches).

For calls verify ringtone plus visible actionable notification, answer, decline, lock-screen behavior, missed-call state, persistence, and no duplicate UI/runtime handling.

## Git/public-security rules
Never commit:
- keystores;
- signing passwords;
- access tokens;
- private keys;
- `.env` secrets;
- personal device data.

Before publication/history rewriting, treat a secret that ever entered public Git history as compromised and rotate it; deleting only the current file is insufficient.

## Documentation rule
Do not append every debugging thought to permanent memory. Record only:
- confirmed architecture decisions;
- reproducible bugs;
- evidence-backed root causes;
- test procedures;
- unresolved hypotheses clearly labeled;
- product goals/acceptance criteria.
