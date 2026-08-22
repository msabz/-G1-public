# CallRuntime integration seam

`src/services/CallRuntime.js` is the single lifecycle owner. `App.js` remains
unchanged in this branch to keep parallel work isolated. Integration should
replace its current call branches rather than run both controllers together.

## Producer contract

Every call control frame must carry the same non-empty `callId`:

```text
call-request, call-ringing, call-accept, call-connected/call-active,
call-reject, call-busy, call-missed, call-cancel, call-failed, call-end
```

Use these runtime entry points:

- outgoing start: `beginOutgoingCall(...)`, then send `call-request` with the
  returned `callId`;
- all received call frames: `handleIncomingCallRequest(message, peer)` for
  `call-request`, otherwise `handleRemoteCallSignal(message)`;
- user answers: `answerIncomingCall(callId)`;
- user declines: `declineIncomingCall(callId)`;
- media usable: `markCallActive(callId)` only after audio/video is established;
- local hang-up: `endCall(callId)`;
- unrecoverable media failure: `failCall(callId, reason)`.

The runtime sends ringing/accept/reject/busy/timeout/end control frames itself.
Delete the corresponding sends from the old App call branches during
integration to prevent duplicate signaling.

## UI/media adapter

Register one adapter while the React UI exists:

```js
const subscription = registerCallUiController({
  restore(call, metadata) {},
  accept(call, { fromNotification, signalingHandled }) {
    // Show call UI and start/renegotiate media. Do not send call-accept.
  },
  reject(call, { fromNotification, signalingHandled }) {
    // Close ringing UI/media only. Do not send call-reject.
  },
  onStateChange(current, previous, reason) {},
});
```

Remove the adapter on unmount. `signalingHandled: true` means CallRuntime has
already correlated and sent the control frame. Restored `active` sessions are
exposed as `connecting`; microphone/camera must never auto-open after JS
recreation. The media adapter must renegotiate explicitly, then call
`markCallActive(callId)`.

## State and history

Direction is immutable `incoming|outgoing`. State is one of:

```text
incoming|outgoing -> ringing -> connecting -> active
                                  |             |
                                  +-> declined|busy|missed|failed|ended
```

Subscribe with `subscribeToCallState`. Persistent records are available through
`CallHistory`/`Persistence`; `CallHistoryList` is ready to replace the current
empty Calls-tab placeholder. Its callbacks are `onCallBack(record)` and
`onOpenPeer(record)`.
