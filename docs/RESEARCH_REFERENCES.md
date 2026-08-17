# G1 Research References

Prefer primary platform specifications and maintained source projects. External products are references for mechanisms and failure modes, not templates that override G1's transport-independent philosophy.

## Android platform — primary references
- Android Wi-Fi Direct: https://developer.android.com/develop/connectivity/wifi/wifip2p
- Android Network Service Discovery (NSD): https://developer.android.com/develop/connectivity/wifi/use-nsd
- Android connectivity/network APIs: https://developer.android.com/develop/connectivity/network-ops/reading-network-state
- Android background execution limits: https://developer.android.com/about/versions/oreo/background
- Android foreground services: https://developer.android.com/develop/background-work/services/fgs
- Android Doze/App Standby: https://developer.android.com/training/monitoring-device-state/doze-standby
- Android notifications: https://developer.android.com/develop/ui/views/notifications
- Android time-sensitive notifications/full-screen intents: https://developer.android.com/develop/ui/views/notifications/time-sensitive
- Android package installation / PackageInstaller: https://developer.android.com/reference/android/content/pm/PackageInstaller
- FileProvider secure URI sharing: https://developer.android.com/reference/androidx/core/content/FileProvider
- MediaStore: https://developer.android.com/reference/android/provider/MediaStore
- Android Telecom: https://developer.android.com/reference/android/telecom/package-summary
- Android call log provider: https://developer.android.com/reference/android/provider/CallLog

When Android behavior differs by release, read the current behavior-change pages for the app's targetSdk/Android version before changing architecture.

## Protocol and networking references
- RFC 9293 — TCP: https://www.rfc-editor.org/rfc/rfc9293
- RFC 1122 — Internet host requirements: https://www.rfc-editor.org/rfc/rfc1122
- RFC 6762 — Multicast DNS: https://www.rfc-editor.org/rfc/rfc6762
- RFC 6763 — DNS-Based Service Discovery: https://www.rfc-editor.org/rfc/rfc6763

Use TCP errors conservatively: local errors identify local socket state/effects; remote root cause generally requires remote evidence.

## Open-source systems worth studying
### LocalSend
Repository: https://github.com/localsend/localsend
Useful for: cross-platform local discovery, peer identity, HTTP-based local transfer, user-facing reliability patterns. Study concepts; do not copy architecture blindly.

### KDE Connect
Repository: https://invent.kde.org/network/kdeconnect-kde
Android component: https://invent.kde.org/network/kdeconnect-android
Useful for: persistent device identity, LAN discovery, pairing/security, plugin/capability architecture, reconnect behavior.

### Syncthing
Repository: https://github.com/syncthing/syncthing
Protocol docs: https://docs.syncthing.net/specs/index.html
Useful for: device identity independent of address, discovery, connection management, transfer integrity and resilient synchronization concepts.

### Briar
Repository: https://code.briarproject.org/briar/briar
Useful for: transport-independent/offline-first thinking and peer-to-peer messaging under intermittent connectivity. Its threat model and transport choices differ from G1; use only relevant principles.

### Jami
Repository: https://git.jami.net/savoirfairelinux/jami-daemon
Useful for: decentralized messaging/calling, peer identity, connectivity and call architecture. It is much larger than G1 and should not dictate implementation complexity.

## Nearby/Quick Share references
Samsung Quick Share and Google's Quick Share are closed/partly proprietary products; public behavior and Android platform documentation can inspire UX and transport-upgrade concepts, but undocumented internals must not be asserted as facts.

Relevant open implementation history:
- Google Nearby Connections documentation: https://developers.google.com/nearby/connections/overview
- Android Wi-Fi Direct documentation above.

Key transferable idea: discovery/negotiation and bulk-transfer transport need not be the same channel. G1, however, must preserve its stronger invariant: no specific bootstrap transport is mandatory. If a high-bandwidth path is already independently discoverable, it may start there directly.

## React Native / testing
- React Native testing overview: https://reactnative.dev/docs/testing-overview
- Jest configuration: https://jestjs.io/docs/configuration
- Jest React Native tutorial: https://jestjs.io/docs/tutorial-react-native

Unit tests should mock native boundaries intentionally. Do not globally transform/mock large native dependency trees merely to silence one test if a narrower module boundary is correct.

## GitHub/CI/security
- GitHub Actions: https://docs.github.com/actions
- Workflow security: https://docs.github.com/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- Removing sensitive data from repository history: https://docs.github.com/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository

## Research method
When a new problem appears:
1. reproduce and collect local evidence;
2. inspect G1 code/tests;
3. check Android/standards primary documentation;
4. search mature open-source implementations for analogous mechanisms;
5. distinguish documented behavior from inferred proprietary behavior;
6. implement according to G1 invariants, not according to another app's dependency chain;
7. validate on real devices and update project memory only after evidence.
