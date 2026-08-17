# G1 DirectChat — Messaging Feature Parity & Call History Goals

**Companion documents:**
- `docs/G1_NETWORKING_DEVELOPMENT_MEMORY.md`
- `docs/G1_NEXT_PHASE_PRODUCT_GOALS.md`
- `docs/G1_FUTURE_UI_UX_VISION.md`

**Purpose:** Define the product-level messaging, conversation-management, content-action, and calling-history features required for G1 to feel complete as a modern messaging application while preserving G1's direct/serverless networking philosophy.

---

## 1. Product objective

G1 must not stop at reliable transport, chat delivery, file transfer, and WebRTC calls. The application layer must provide the everyday interaction set users expect from mature messaging products.

The goal is not to copy another application's visual design. The goal is functional completeness with G1's own very modern, minimal, low-complexity UI.

Networking complexity remains hidden. Message/conversation actions must behave consistently regardless of whether the current transport is LAN, Wi-Fi Direct, Bluetooth, or a future transport.

---

## 2. Conversation management

Required conversation-level actions include:

- delete a conversation locally;
- clear conversation history while retaining the peer/contact;
- archive/unarchive conversation;
- pin/unpin conversation;
- mute/unmute conversation notifications;
- mark read/unread where useful;
- search inside a conversation;
- search across conversations;
- share/export selected content where Android permissions and privacy rules allow;
- conversation information/details screen;
- media/files/links view for content exchanged with that peer.

Destructive operations must use clear confirmation when data loss is significant. Do not add confirmation dialogs to harmless/reversible actions unnecessarily.

Conversation deletion and message deletion semantics must distinguish local deletion from any future peer-synchronized deletion protocol.

---

## 3. Message-level actions

Long-press/context actions should support the expected operations according to message/content type:

- copy text;
- select text where technically appropriate;
- cut text in editable/composer contexts;
- paste into the composer;
- share through Android Sharesheet;
- forward to another G1 conversation/peer;
- reply to a specific message;
- delete message locally;
- multi-select messages;
- delete multiple selected messages;
- copy selected message text;
- share/forward multiple compatible selected items;
- save/download received media/files where applicable;
- open received files with an appropriate Android application;
- view message/file details such as timestamp, size, type, and delivery state where useful.

The context menu must be content-aware. Do not show meaningless actions (for example, `Copy` for an arbitrary binary file unless there is copyable text metadata).

---

## 4. Message editing and deletion semantics

### Local deletion

G1 must support deleting a message from the local history without requiring the remote peer to be online.

### Delete for everyone — future protocol feature

If G1 implements remote deletion, it must be a real protocol-level operation, not a UI illusion.

A robust design requires at minimum:

```text
messageId
authorPeerId
conversation/session identity
delete/tombstone event
protocol version
```

The receiving side should persist a tombstone/update so a deleted message does not reappear after state reconstruction.

Rules such as deletion time windows are product-policy decisions and must not be hard-coded accidentally into transport code.

### Edit message — desired modern feature

Editing sent text messages should be considered part of the target feature set. It should use a message ID plus revision/update event and display an `edited` indication.

Edits/deletions belong to the application protocol and must be transport-neutral.

---

## 5. Reply, forward, share, clipboard, and selection

### Reply

A reply must reference a stable message ID, not only copy the old text. The UI should show a compact quoted/referenced preview and navigate/highlight the referenced message when possible.

### Forward

Forwarding should create a new outgoing message/attachment operation through the normal send pipeline. Do not bypass file integrity or route selection merely because content already exists locally.

### Android share

Support Android Sharesheet for text, images, files, APK/APKS where appropriate, and other content types supported safely by Android URI permissions.

Use `content://`/FileProvider-style safe sharing where required. Do not expose private filesystem paths.

### Clipboard

Support normal Android copy/paste behavior in the composer and message actions. Text selection should feel native and predictable.

---

## 6. Composer expectations

The message composer should eventually support:

- multiline text;
- native copy/cut/paste/select-all behavior;
- attachment entry point;
- images;
- generic files/documents;
- applications/APK/APKS through the existing app-sharing flow;
- reply preview with cancel action;
- edit-message mode with explicit cancel/save state;
- clear send state;
- disabled/queued behavior when a route is temporarily unavailable according to future queueing policy.

Do not expose IP addresses, interfaces, or transport mechanics in the composer.

---

## 7. Delivery/read state foundation

A mature chat history should have stable message identity and explicit state rather than inferring everything from UI timing.

Target conceptual states may include:

```text
queued
sending
sent
delivered
read
failed
```

Exact semantics must reflect what G1 can genuinely prove in a direct peer-to-peer system.

For example, do not display `delivered` merely because bytes were written to a local socket if there is no peer acknowledgement proving receipt.

Read receipts should be optional/configurable if introduced and must be implemented as application-level acknowledgements, not transport assumptions.

---

## 8. Media/file message UX

File and media messages should support:

- filename;
- correct extension;
- file size;
- MIME/type awareness;
- transfer progress;
- cancel where protocol supports it;
- explicit failed/retry state;
- completed state only after the transfer's integrity/completion semantics succeed;
- open/share/save actions;
- image/video preview/thumbnail where appropriate;
- APK/APKS application identity/icon where available;
- installation action/state for application packages.

The high-throughput native file-transfer goal remains in force. Rich UI must not reintroduce per-chunk JS overhead that slows the `8090` data path.

---

## 9. Call history — confirmed missing product feature

### Current problem

G1 voice/video calls can function, but calls do not currently appear as a proper persistent call history comparable to mature messaging/calling applications.

This is a product gap independent from whether WebRTC signaling/media succeeded.

### Required G1 call history

Persist call records for at least:

- incoming answered call;
- incoming missed call;
- incoming rejected/declined call;
- outgoing answered call;
- outgoing unanswered/no-answer call;
- outgoing failed call;
- cancelled outgoing call;
- voice call;
- video call;
- start timestamp;
- answer/connect timestamp where applicable;
- end timestamp;
- duration;
- peer identity/name/avatar snapshot or resolvable peer identity;
- stable callId;
- final reason/state.

A call record must survive application restart and UI recreation.

### In-app call log

G1 should have a modern call-history surface, either a dedicated Calls area or a coherent history integrated into conversation details, depending on final UX design.

Users should be able to:

- see incoming/outgoing direction;
- distinguish voice/video;
- identify missed/rejected/failed calls;
- see time/date and duration;
- call back;
- open the peer conversation/profile;
- delete individual call-log entries;
- clear call history with appropriate confirmation.

### Conversation timeline

Where appropriate, call events should also appear in the conversation timeline as lightweight system entries, e.g. outgoing voice call, missed video call, duration. These entries must be backed by persistent call records/state, not transient UI strings.

---

## 10. Android system call-log integration — separate decision

Do not confuse **G1's own call history** with Android's system Phone call log.

G1 must first maintain a complete, reliable in-app call history.

If future product direction wants G1 calls to appear in Android's system-level call experience/history, investigate the supported Android Telecom/ConnectionService/CallsManager integration for the target Android versions and Play/device policies.

Do not directly write arbitrary rows into Android call-log providers as a shortcut unless that behavior is explicitly supported, permission-compliant, and product-approved.

System integration must not become a prerequisite for G1's own call history.

---

## 11. Incoming-call notification remains a P1 requirement

The existing next-phase requirement still applies:

- call arrives while G1 is backgrounded or removed from Recents (not Force Stop);
- native high-importance/call-style notification appears;
- caller identity is visible;
- Answer action works;
- Reject action works;
- ringtone, notification, signaling, and UI share the same `callId`;
- answering/rejecting updates the persistent call record correctly;
- a missed call creates a missed-call record and notification state.

This must connect directly to the call-history model rather than being implemented as an unrelated notification-only feature.

---

## 12. Suggested persistent application data model

Exact storage technology is an implementation decision, but application state should move toward stable entities similar to:

```text
Conversation
  conversationId
  peerId
  createdAt
  updatedAt
  pinned
  archived
  muted
  unreadCount

Message
  messageId
  conversationId
  senderPeerId
  type
  body/metadata
  createdAt
  editedAt
  deliveryState
  replyToMessageId
  localDeleted/tombstone state

Attachment
  attachmentId
  messageId
  displayName
  mimeType
  size
  localUri
  transferId
  integrity/status

CallRecord
  callId
  conversationId/peerId
  direction
  mediaType
  startedAt
  answeredAt
  endedAt
  duration
  finalState/reason
```

Transport endpoints/IP addresses do not belong as the identity of these entities.

---

## 13. Feature completeness target

The intended mature messaging feature set should include, at minimum:

### Core chat
- persistent conversation history;
- stable message IDs;
- text messaging;
- reply;
- forward;
- copy/paste/cut/select;
- share;
- delete message;
- delete/clear conversation;
- multi-select;
- search;
- message delivery/error state;
- timestamps;
- optional read-state/receipts when correctly implemented;
- message editing as a target feature;
- delete-for-everyone only when a real synchronized protocol exists.

### Content
- images;
- video/media where supported;
- generic files;
- APK/APKS;
- progress/retry/open/share/save;
- previews/metadata;
- high-throughput transfer without UI overhead degrading performance.

### Conversations
- pin;
- archive;
- mute;
- unread state;
- media/files/links view;
- peer/conversation details.

### Calling
- voice/video calls;
- background incoming-call notification;
- Answer/Reject actions;
- persistent call history;
- missed/rejected/failed state;
- duration;
- callback;
- call entries in conversation timeline where appropriate;
- optional Android Telecom/system integration as a separately evaluated feature.

---

## 14. UI/UX relationship

All of these features must conform to `G1_FUTURE_UI_UX_VISION.md`.

The UI goal is **extremely modern/futuristic without complexity**. Therefore feature completeness must not produce a cluttered interface.

Use progressive disclosure:

- primary actions remain obvious;
- secondary actions appear on long press/context menus/bottom sheets;
- advanced controls stay out of the default path;
- destructive actions are clearly distinguished;
- animations are fast and informative, not decorative obstacles;
- accessibility and native Android interaction conventions remain respected.

A large feature set must feel simpler than it is internally.

---

## 15. Regression and acceptance scenarios

Future releases should include tests covering at least:

1. send/receive text both directions;
2. long-press message -> copy;
3. paste copied text into composer;
4. cut/select-all behavior in editable composer;
5. reply to message and resolve referenced message;
6. forward message;
7. Android share of text/image/file;
8. delete one local message;
9. multi-select and delete;
10. clear/delete conversation;
11. search conversation;
12. archive/pin/mute behavior persists across restart;
13. incoming/outgoing voice call creates correct call record;
14. incoming/outgoing video call creates correct call record;
15. missed call creates missed-call record;
16. rejected call creates rejected-call record;
17. failed call is not mislabeled as missed/answered;
18. duration is correct for answered calls;
19. call history persists after app restart;
20. call-back from history works through normal transport orchestration;
21. background incoming call notification Answer/Reject updates the same call record;
22. file/media actions do not regress high-throughput transfer;
23. APK/APKS install and filename behavior remain correct;
24. LAN/P2P/Bluetooth transport independence remains intact.

---

## 16. Priority

Treat basic messaging ergonomics and persistent call history as product-completeness work, not cosmetic polish.

Recommended classification:

- **P1:** persistent call history and correct final call states;
- **P1:** background call notification Answer/Reject integrated with call history;
- **P1:** delete conversation/message, copy/paste/share/forward/reply, persistent message identity;
- **P1:** robust conversation/message persistence needed to support these actions;
- **P2:** archive/pin/mute/search/media browser;
- **P2:** message edit and synchronized delete-for-everyone protocol;
- **P2:** optional Android Telecom/system call-history integration after feasibility/policy review.

---

## 17. Handoff rule

Before implementing these features, read the networking memory and next-phase goals. Application-layer features must not weaken transport independence, file-transfer integrity, background availability, or the Known Good networking baseline.

The implementation should make G1 feel like a complete modern messenger while keeping the network architecture transport-neutral and the user experience unusually simple.
