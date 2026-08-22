export const CALL_DIRECTIONS = Object.freeze({
  INCOMING: 'incoming',
  OUTGOING: 'outgoing',
});

export const CALL_MEDIA_TYPES = Object.freeze({
  VOICE: 'voice',
  VIDEO: 'video',
});

// `incoming` and `outgoing` are short-lived initial states. Direction remains
// a separate immutable field so history never has to infer it from the state.
export const CALL_STATES = Object.freeze({
  INCOMING: 'incoming',
  OUTGOING: 'outgoing',
  RINGING: 'ringing',
  CONNECTING: 'connecting',
  ACTIVE: 'active',
  DECLINED: 'declined',
  BUSY: 'busy',
  MISSED: 'missed',
  FAILED: 'failed',
  ENDED: 'ended',
});

export const CALL_EVENTS = Object.freeze({
  RING: 'ring',
  ANSWER: 'answer',
  MEDIA_ACTIVE: 'media-active',
  DECLINE: 'decline',
  BUSY: 'busy',
  MISS: 'miss',
  FAIL: 'fail',
  END: 'end',
});

const TERMINAL_STATES = new Set([
  CALL_STATES.DECLINED,
  CALL_STATES.BUSY,
  CALL_STATES.MISSED,
  CALL_STATES.FAILED,
  CALL_STATES.ENDED,
]);

const EVENT_TARGET = Object.freeze({
  [CALL_EVENTS.RING]: CALL_STATES.RINGING,
  [CALL_EVENTS.ANSWER]: CALL_STATES.CONNECTING,
  [CALL_EVENTS.MEDIA_ACTIVE]: CALL_STATES.ACTIVE,
  [CALL_EVENTS.DECLINE]: CALL_STATES.DECLINED,
  [CALL_EVENTS.BUSY]: CALL_STATES.BUSY,
  [CALL_EVENTS.MISS]: CALL_STATES.MISSED,
  [CALL_EVENTS.FAIL]: CALL_STATES.FAILED,
  [CALL_EVENTS.END]: CALL_STATES.ENDED,
});

const ALLOWED_EVENTS = Object.freeze({
  [CALL_STATES.INCOMING]: new Set([
    CALL_EVENTS.RING,
    CALL_EVENTS.ANSWER,
    CALL_EVENTS.DECLINE,
    CALL_EVENTS.BUSY,
    CALL_EVENTS.MISS,
    CALL_EVENTS.FAIL,
    CALL_EVENTS.END,
  ]),
  [CALL_STATES.OUTGOING]: new Set([
    CALL_EVENTS.RING,
    CALL_EVENTS.ANSWER,
    CALL_EVENTS.BUSY,
    CALL_EVENTS.MISS,
    CALL_EVENTS.FAIL,
    CALL_EVENTS.END,
  ]),
  [CALL_STATES.RINGING]: new Set([
    CALL_EVENTS.RING,
    CALL_EVENTS.ANSWER,
    CALL_EVENTS.DECLINE,
    CALL_EVENTS.BUSY,
    CALL_EVENTS.MISS,
    CALL_EVENTS.FAIL,
    CALL_EVENTS.END,
  ]),
  [CALL_STATES.CONNECTING]: new Set([
    CALL_EVENTS.ANSWER,
    CALL_EVENTS.MEDIA_ACTIVE,
    CALL_EVENTS.DECLINE,
    CALL_EVENTS.BUSY,
    CALL_EVENTS.MISS,
    CALL_EVENTS.FAIL,
    CALL_EVENTS.END,
  ]),
  [CALL_STATES.ACTIVE]: new Set([
    CALL_EVENTS.MEDIA_ACTIVE,
    CALL_EVENTS.FAIL,
    CALL_EVENTS.END,
  ]),
});

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function finiteTimestamp(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0
    ? Number(value)
    : fallback;
}

export function isTerminalCallState(state) {
  return TERMINAL_STATES.has(state);
}

export function createCallState(input, now = Date.now) {
  const callId = requiredString(input?.callId, 'callId');
  const peerId = requiredString(input?.peerId, 'peerId');
  const direction = input?.direction === CALL_DIRECTIONS.OUTGOING
    ? CALL_DIRECTIONS.OUTGOING
    : CALL_DIRECTIONS.INCOMING;
  const mediaType = input?.mediaType === CALL_MEDIA_TYPES.VIDEO
    ? CALL_MEDIA_TYPES.VIDEO
    : CALL_MEDIA_TYPES.VOICE;
  const createdAt = finiteTimestamp(input?.startedAt, now());

  return Object.freeze({
    callId,
    peerId,
    peerName: input?.peerName || 'G1 Device',
    direction,
    mediaType,
    video: mediaType === CALL_MEDIA_TYPES.VIDEO,
    state: direction === CALL_DIRECTIONS.OUTGOING
      ? CALL_STATES.OUTGOING
      : CALL_STATES.INCOMING,
    startedAt: createdAt,
    ringingAt: finiteTimestamp(input?.ringingAt, null),
    answeredAt: finiteTimestamp(input?.answeredAt, null),
    activeAt: finiteTimestamp(input?.activeAt, null),
    endedAt: null,
    duration: 0,
    finalState: null,
    endReason: null,
    correlationMode: input?.correlationMode === 'legacy-single-call'
      ? 'legacy-single-call'
      : 'call-id',
    recovered: !!input?.recovered,
    revision: Number.isInteger(input?.revision) ? input.revision : 0,
    lastTransitionAt: createdAt,
  });
}

export function transitionCall(call, event, details = {}, now = Date.now) {
  if (!call || typeof call !== 'object') throw new Error('call is required');
  if (isTerminalCallState(call.state)) return call;

  const target = EVENT_TARGET[event];
  const allowed = ALLOWED_EVENTS[call.state];
  if (!target || !allowed?.has(event)) {
    throw new Error(`Invalid call transition: ${call.state} + ${event}`);
  }

  // Duplicate native intents and repeated network frames are expected at the
  // Android/transport boundary. They must not reset timestamps or duration.
  if (target === call.state) return call;

  const at = finiteTimestamp(details.at, now());
  const next = {
    ...call,
    state: target,
    revision: (call.revision || 0) + 1,
    lastTransitionAt: at,
  };

  if (target === CALL_STATES.RINGING && !next.ringingAt) {
    next.ringingAt = at;
  }
  if (target === CALL_STATES.CONNECTING && !next.answeredAt) {
    next.answeredAt = at;
  }
  if (target === CALL_STATES.ACTIVE) {
    if (!next.answeredAt) next.answeredAt = at;
    if (!next.activeAt) next.activeAt = at;
  }

  if (isTerminalCallState(target)) {
    next.endedAt = at;
    next.finalState = target;
    next.endReason = details.reason || null;
    next.duration = next.answeredAt
      ? Math.max(0, Math.round((at - next.answeredAt) / 1000))
      : 0;
  }

  return Object.freeze(next);
}

export function restoreCallState(snapshot, now = Date.now) {
  const state = Object.values(CALL_STATES).includes(snapshot?.state)
    ? snapshot.state
    : null;
  const direction = snapshot?.direction === CALL_DIRECTIONS.OUTGOING
    ? CALL_DIRECTIONS.OUTGOING
    : CALL_DIRECTIONS.INCOMING;
  const base = createCallState({
    ...snapshot,
    direction,
    mediaType: snapshot?.mediaType || (snapshot?.video ? 'video' : 'voice'),
    recovered: true,
  }, now);

  if (!state || state === base.state) return base;
  if (isTerminalCallState(state)) {
    return Object.freeze({
      ...base,
      state,
      finalState: state,
      endedAt: finiteTimestamp(snapshot?.endedAt, now()),
      duration: Math.max(0, Number(snapshot?.duration) || 0),
      endReason: snapshot?.endReason || null,
    });
  }

  return Object.freeze({
    ...base,
    state,
    ringingAt: finiteTimestamp(snapshot?.ringingAt, null),
    answeredAt: finiteTimestamp(snapshot?.answeredAt, null),
    activeAt: finiteTimestamp(snapshot?.activeAt, null),
    endedAt: null,
    finalState: null,
    duration: 0,
    lastTransitionAt: finiteTimestamp(snapshot?.lastTransitionAt, base.startedAt),
  });
}
