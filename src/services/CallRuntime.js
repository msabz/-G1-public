import { AppState, NativeEventEmitter, NativeModules } from 'react-native';
import { sendSignalingMessage } from '../webrtc/signaling';
import { startRingtone, stopRingtone } from '../media/AudioClip';
import { listCallRecords, saveCallRecord } from './Persistence';
import {
  CALL_DIRECTIONS,
  CALL_EVENTS,
  CALL_MEDIA_TYPES,
  CALL_STATES,
  createCallState,
  isTerminalCallState,
  restoreCallState,
  transitionCall,
} from './CallStateMachine';

const { CallNotificationModule } = NativeModules;

export { CALL_DIRECTIONS, CALL_EVENTS, CALL_MEDIA_TYPES, CALL_STATES };

const DEFAULT_RING_TIMEOUT_MS = 45_000;
const MAX_RECOVERABLE_SESSION_AGE_MS = 6 * 60 * 60 * 1000;

let uiAttached = true;
let appState = AppState.currentState || 'active';
let activeCall = null;
let uiController = null;
let pendingNativeAction = null;
let pendingUiAction = null;
let lastHandledNativeActionKey = null;
let initialized = false;
let callActionSubscription = null;
let appStateSubscription = null;
let ringTimeout = null;
let ringTimeoutMs = DEFAULT_RING_TIMEOUT_MS;
let persistenceQueue = Promise.resolve();
let initializationPromise = Promise.resolve();
const stateSubscribers = new Set();

function nativeCall(method, ...args) {
  try {
    const fn = CallNotificationModule?.[method];
    if (typeof fn !== 'function') return Promise.resolve(null);
    return Promise.resolve(fn(...args)).catch(() => null);
  } catch (e) {
    return Promise.resolve(null);
  }
}

function snapshot(call = activeCall) {
  return call ? { ...call } : null;
}

function toRecord(call) {
  return {
    callId: call.callId,
    peerId: call.peerId,
    peerName: call.peerName,
    direction: call.direction,
    mediaType: call.mediaType,
    startedAt: call.startedAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    duration: call.duration || 0,
    // The existing storage schema uses finalState for both live checkpoints
    // and terminal results. `state` remains the runtime source of truth.
    finalState: call.finalState || call.state,
    endReason: call.endReason || null,
  };
}

function toNativeSession(call) {
  return {
    callId: call.callId,
    peerId: call.peerId,
    peerName: call.peerName,
    direction: call.direction,
    mediaType: call.mediaType,
    state: call.state,
    startedAt: call.startedAt,
    ringingAt: call.ringingAt,
    answeredAt: call.answeredAt,
    activeAt: call.activeAt,
    lastTransitionAt: call.lastTransitionAt,
    correlationMode: call.correlationMode,
  };
}

function enqueuePersistence(call, { session = true } = {}) {
  if (!call?.peerId || !call?.callId) return persistenceQueue;
  const immutableCall = snapshot(call);
  persistenceQueue = persistenceQueue
    .catch(() => null)
    .then(async () => {
      if (session) {
        if (isTerminalCallState(immutableCall.state)) {
          await nativeCall('clearCallSession', immutableCall.callId);
        } else {
          await nativeCall('saveCallSession', toNativeSession(immutableCall));
        }
      }
      return saveCallRecord(toRecord(immutableCall));
    })
    .catch(() => null);
  return persistenceQueue;
}

function emitState(previous, reason) {
  const current = snapshot();
  for (const listener of [...stateSubscribers]) {
    try { listener(current, previous ? { ...previous } : null, reason); } catch (e) {}
  }
  try { uiController?.onStateChange?.(current, previous ? { ...previous } : null, reason); } catch (e) {}
}

function installCall(call, reason, options = {}) {
  const previous = snapshot();
  activeCall = call;
  if (options.persist !== false) enqueuePersistence(activeCall);
  emitState(previous, reason);
  return snapshot();
}

function cancelRingTimer() {
  if (ringTimeout) clearTimeout(ringTimeout);
  ringTimeout = null;
}

function cancelNativeNotification(callId) {
  if (!callId) return Promise.resolve(null);
  return nativeCall('cancelIncomingCall', callId);
}

function callMatches(callId, { allowLegacyMissing = false } = {}) {
  if (!activeCall) return false;
  if (callId) return callId === activeCall.callId;
  return allowLegacyMissing && activeCall.correlationMode === 'legacy-single-call';
}

function notifyIncomingCall(call = activeCall) {
  if (!call || call.direction !== CALL_DIRECTIONS.INCOMING || call.state !== CALL_STATES.RINGING) {
    return Promise.resolve(null);
  }
  return nativeCall('showIncomingCall', call.callId, call.peerName, call.video);
}

function terminalEventFor(finalState) {
  switch (finalState) {
    case 'declined':
    case 'rejected':
      return CALL_EVENTS.DECLINE;
    case 'busy':
      return CALL_EVENTS.BUSY;
    case 'missed':
    case 'noanswer':
      return CALL_EVENTS.MISS;
    case 'failed':
      return CALL_EVENTS.FAIL;
    case 'cancelled':
    case 'ended':
    default:
      return CALL_EVENTS.END;
  }
}

function scheduleRingTimeout(call = activeCall) {
  cancelRingTimer();
  if (!call || call.state !== CALL_STATES.RINGING) return;
  const elapsed = Math.max(0, Date.now() - (call.ringingAt || call.startedAt));
  const remaining = Math.max(0, ringTimeoutMs - elapsed);
  ringTimeout = setTimeout(() => {
    ringTimeout = null;
    if (!callMatches(call.callId) || activeCall.state !== CALL_STATES.RINGING) return;
    if (activeCall.direction === CALL_DIRECTIONS.INCOMING) {
      sendSignalingMessage({ type: 'call-missed', callId: activeCall.callId });
      finalizeCall(activeCall.callId, CALL_STATES.MISSED, 'ring-timeout');
    } else {
      sendSignalingMessage({ type: 'call-cancel', callId: activeCall.callId });
      finalizeCall(activeCall.callId, CALL_STATES.MISSED, 'no-answer');
    }
  }, remaining);
}

function transitionActiveCall(event, details, reason) {
  if (!activeCall) return false;
  const previous = snapshot();
  let next;
  try {
    next = transitionCall(activeCall, event, details);
  } catch (e) {
    return false;
  }
  if (next === activeCall) return true;
  activeCall = next;
  enqueuePersistence(activeCall);
  emitState(previous, reason || event);

  if (activeCall.state === CALL_STATES.RINGING) scheduleRingTimeout(activeCall);
  if (activeCall.state === CALL_STATES.CONNECTING || isTerminalCallState(activeCall.state)) {
    cancelRingTimer();
    stopRingtone().catch(() => {});
    const cancellation = cancelNativeNotification(activeCall.callId);
    if (activeCall.state === CALL_STATES.MISSED && activeCall.direction === CALL_DIRECTIONS.INCOMING) {
      const missedCall = snapshot();
      cancellation.then(() => (
        nativeCall('showMissedCall', missedCall.callId, missedCall.peerName, missedCall.video)
      ));
    }
  }
  return true;
}

function deliverPendingUiAction() {
  if (!uiAttached || !uiController || !pendingUiAction || !activeCall) return;
  if (pendingUiAction.callId !== activeCall.callId) return;
  const action = pendingUiAction;
  try {
    if (action.action === 'accept') {
      uiController.accept?.(snapshot(), {
        fromNotification: action.source === 'notification',
        signalingHandled: true,
      });
    } else if (action.action === 'reject') {
      uiController.reject?.(snapshot(), {
        fromNotification: action.source === 'notification',
        signalingHandled: true,
      });
    }
    pendingUiAction = null;
  } catch (e) {
    // Keep the action for the next controller attachment. State/signaling have
    // already been committed, so retrying this UI/media hook is idempotent.
  }
}

function maybeRestoreUi() {
  if (!uiAttached || !uiController || !activeCall || isTerminalCallState(activeCall.state)) return;
  try { uiController.restore?.(snapshot(), { recovered: !!activeCall.recovered }); } catch (e) {}
  deliverPendingUiAction();
}

async function acknowledgeNativeAction(action) {
  if (!action?.action || !action?.callId) return;
  await nativeCall('acknowledgeCallAction', action.callId, action.action, Number(action.actionAt) || 0);
}

async function handleNativeAction(action) {
  if (!action?.action || !action?.callId) return false;
  if (!callMatches(action.callId)) {
    // An event may beat native session restoration during a React reload.
    pendingNativeAction = action;
    return false;
  }

  if (isTerminalCallState(activeCall.state)) {
    await acknowledgeNativeAction(action);
    pendingNativeAction = null;
    return true;
  }

  if (action.action !== 'accept' && action.action !== 'reject') return false;

  const actionKey = `${action.callId}:${action.action}:${Number(action.actionAt) || 0}`;
  if (lastHandledNativeActionKey === actionKey) {
    await acknowledgeNativeAction(action);
    return true;
  }
  lastHandledNativeActionKey = actionKey;

  if (action.action === 'accept') {
    answerIncomingCall(action.callId, { source: 'notification' });
  } else {
    declineIncomingCall(action.callId, { source: 'notification' });
  }

  await acknowledgeNativeAction(action);
  pendingNativeAction = null;
  return true;
}

function drainPendingNativeAction() {
  if (!pendingNativeAction) return Promise.resolve(false);
  return handleNativeAction(pendingNativeAction);
}

function normalizeRecoveredSnapshot(raw) {
  if (!raw?.callId) return null;
  const stateAliases = {
    connected: CALL_STATES.ACTIVE,
    rejected: CALL_STATES.DECLINED,
    noanswer: CALL_STATES.MISSED,
    cancelled: CALL_STATES.ENDED,
  };
  const state = stateAliases[raw.state || raw.finalState] || raw.state || raw.finalState;
  return {
    ...raw,
    peerId: raw.peerId || 'unknown-peer',
    mediaType: raw.mediaType || (raw.video ? CALL_MEDIA_TYPES.VIDEO : CALL_MEDIA_TYPES.VOICE),
    state,
  };
}

async function readRecoverySnapshot() {
  const nativeSession = normalizeRecoveredSnapshot(await nativeCall('getPendingCallSession'));
  if (nativeSession) return nativeSession;

  const legacyIncoming = await nativeCall('getPendingIncomingCall');
  if (legacyIncoming?.callId) {
    return normalizeRecoveredSnapshot({
      ...legacyIncoming,
      peerId: legacyIncoming.peerId || 'unknown-peer',
      peerName: legacyIncoming.callerName,
      direction: CALL_DIRECTIONS.INCOMING,
      mediaType: legacyIncoming.video ? CALL_MEDIA_TYPES.VIDEO : CALL_MEDIA_TYPES.VOICE,
      state: CALL_STATES.RINGING,
      startedAt: legacyIncoming.receivedAt,
      ringingAt: legacyIncoming.receivedAt,
      correlationMode: 'call-id',
    });
  }

  const records = await listCallRecords(20);
  return normalizeRecoveredSnapshot((records || []).find(record => (
    !isTerminalCallState(normalizeRecoveredSnapshot(record)?.state)
  )));
}

async function restorePersistedCall() {
  const raw = await readRecoverySnapshot();
  if (!raw) return null;

  // A real-time call request may arrive while the asynchronous native/storage
  // lookup is in flight. Never replace that newer live call with a snapshot.
  if (activeCall && !isTerminalCallState(activeCall.state)) return snapshot();

  let restored;
  try { restored = restoreCallState(raw); } catch (e) { return null; }
  if (isTerminalCallState(restored.state)) {
    await nativeCall('clearCallSession', restored.callId);
    return null;
  }

  const age = Math.max(0, Date.now() - restored.startedAt);
  if (age > MAX_RECOVERABLE_SESSION_AGE_MS) {
    activeCall = restored;
    finalizeCall(restored.callId, CALL_STATES.FAILED, 'stale-recovered-session');
    return null;
  }

  // A recreated JS runtime must never reopen microphone/camera by itself. An
  // active media session is restored as CONNECTING and exposed to the UI/media
  // adapter, which can explicitly renegotiate before marking it ACTIVE again.
  if (restored.state === CALL_STATES.ACTIVE) {
    restored = restoreCallState({
      ...restored,
      state: CALL_STATES.CONNECTING,
      recoveredFromState: CALL_STATES.ACTIVE,
    });
  }

  installCall(restored, 'runtime-restored');
  if (restored.state === CALL_STATES.RINGING) {
    scheduleRingTimeout(restored);
    if (restored.direction === CALL_DIRECTIONS.INCOMING) notifyIncomingCall(restored);
  }
  maybeRestoreUi();
  return snapshot();
}

export function createCallId(peerId = 'peer') {
  const safePeer = String(peerId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || 'peer';
  return `call_${safePeer}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function beginOutgoingCall({ peerId, peerName, video, mediaType, callId } = {}) {
  if (activeCall && !isTerminalCallState(activeCall.state)) {
    const error = new Error('A call is already active');
    error.code = 'CALL_ALREADY_ACTIVE';
    throw error;
  }
  const call = createCallState({
    callId: callId || createCallId(peerId || 'peer'),
    peerId: peerId || 'unknown-peer',
    peerName: peerName || 'G1 Device',
    direction: CALL_DIRECTIONS.OUTGOING,
    mediaType: mediaType || (video ? CALL_MEDIA_TYPES.VIDEO : CALL_MEDIA_TYPES.VOICE),
    correlationMode: 'call-id',
  });
  installCall(call, 'outgoing-created');
  // Start the no-answer budget locally. Waiting for a remote `call-ringing`
  // frame would leave the call stuck forever when that frame is lost.
  transitionActiveCall(CALL_EVENTS.RING, {}, 'outgoing-ringing');
  return call.callId;
}

export function handleIncomingCallRequest(msg, peer = {}) {
  const suppliedCallId = typeof msg?.callId === 'string' && msg.callId.trim()
    ? msg.callId.trim()
    : null;
  const callId = suppliedCallId || createCallId(peer.deviceId || peer.peerId || 'legacy');

  if (activeCall && !isTerminalCallState(activeCall.state)) {
    if (suppliedCallId && callMatches(suppliedCallId)) {
      return { accepted: true, duplicate: true, call: snapshot() };
    }
    sendSignalingMessage({ type: 'call-busy', callId });
    const busyAttempt = transitionCall(createCallState({
      callId,
      peerId: peer.deviceId || peer.peerId || msg?.peerId || 'unknown-peer',
      peerName: peer.deviceName || peer.name || msg?.peerName || 'G1 Device',
      direction: CALL_DIRECTIONS.INCOMING,
      mediaType: msg?.video ? CALL_MEDIA_TYPES.VIDEO : CALL_MEDIA_TYPES.VOICE,
      correlationMode: suppliedCallId ? 'call-id' : 'legacy-single-call',
    }), CALL_EVENTS.BUSY, { reason: 'another-call-active' });
    enqueuePersistence(busyAttempt, { session: false });
    return { accepted: false, reason: 'busy', activeCall: snapshot() };
  }

  let call = createCallState({
    callId,
    peerId: peer.deviceId || peer.peerId || msg?.peerId || 'unknown-peer',
    peerName: peer.deviceName || peer.name || msg?.peerName || 'G1 Device',
    direction: CALL_DIRECTIONS.INCOMING,
    mediaType: msg?.video ? CALL_MEDIA_TYPES.VIDEO : CALL_MEDIA_TYPES.VOICE,
    correlationMode: suppliedCallId ? 'call-id' : 'legacy-single-call',
  });
  call = Object.freeze({ ...call, ip: msg?.ip || null });
  call = transitionCall(call, CALL_EVENTS.RING);
  installCall(call, 'incoming-ringing');
  scheduleRingTimeout(call);
  startRingtone().catch(() => {});
  sendSignalingMessage({ type: 'call-ringing', callId });

  if (!uiAttached || appState !== 'active') notifyIncomingCall(call);
  maybeRestoreUi();
  drainPendingNativeAction();
  return { accepted: true, call: snapshot() };
}

export function markCallRinging(callId) {
  if (!callMatches(callId, { allowLegacyMissing: true })) return false;
  return transitionActiveCall(CALL_EVENTS.RING, {}, 'remote-ringing');
}

export function markCallConnecting(callId) {
  if (!callMatches(callId, { allowLegacyMissing: true })) return false;
  return transitionActiveCall(CALL_EVENTS.ANSWER, {}, 'call-connecting');
}

// Backward-compatible name. Answering now means signaling accepted/CONNECTING;
// media code must call markCallActive only after audio/video is usable.
export function markCallAnswered(callId) {
  return markCallConnecting(callId);
}

export function markCallActive(callId) {
  if (!callMatches(callId, { allowLegacyMissing: true })) return false;
  return transitionActiveCall(CALL_EVENTS.MEDIA_ACTIVE, {}, 'media-active');
}

export function answerIncomingCall(callId, { source = 'ui' } = {}) {
  if (!callMatches(callId) || activeCall.direction !== CALL_DIRECTIONS.INCOMING) return false;
  // Answer may arrive twice (for example from the notification and the restored
  // UI). The first answer owns both signaling and media delivery; later answers
  // are successful no-ops so they cannot start media twice.
  if (activeCall.state === CALL_STATES.CONNECTING) return true;
  if (![CALL_STATES.INCOMING, CALL_STATES.RINGING].includes(activeCall.state)) {
    return false;
  }
  if (!transitionActiveCall(CALL_EVENTS.ANSWER, {}, `${source}-answer`)) return false;
  sendSignalingMessage({ type: 'call-accept', callId: activeCall.callId });
  pendingUiAction = { action: 'accept', callId: activeCall.callId, source };
  deliverPendingUiAction();
  return true;
}

export function declineIncomingCall(callId, { source = 'ui' } = {}) {
  if (!callMatches(callId) || activeCall.direction !== CALL_DIRECTIONS.INCOMING) return false;
  if (![CALL_STATES.INCOMING, CALL_STATES.RINGING].includes(activeCall.state)) return false;
  sendSignalingMessage({ type: 'call-reject', callId: activeCall.callId });
  const changed = transitionActiveCall(CALL_EVENTS.DECLINE, { reason: `${source}-decline` }, `${source}-decline`);
  if (changed) {
    pendingUiAction = { action: 'reject', callId: activeCall.callId, source };
    deliverPendingUiAction();
  }
  return changed;
}

export function endCall(callId, { reason = 'local-ended', signal = true } = {}) {
  if (!callMatches(callId)) return false;
  if (signal && !isTerminalCallState(activeCall.state)) {
    sendSignalingMessage({
      type: activeCall.state === CALL_STATES.ACTIVE || activeCall.state === CALL_STATES.CONNECTING
        ? 'call-end'
        : 'call-cancel',
      callId: activeCall.callId,
    });
  }
  return finalizeCall(callId, CALL_STATES.ENDED, reason);
}

export function failCall(callId, reason = 'call-failed') {
  return finalizeCall(callId, CALL_STATES.FAILED, reason);
}

export function finalizeCall(callId, finalState = CALL_STATES.ENDED, endReason = null) {
  if (!callMatches(callId, { allowLegacyMissing: true })) return false;
  return transitionActiveCall(
    terminalEventFor(finalState),
    { reason: endReason },
    `final:${finalState}`,
  );
}

export function handleRemoteCallSignal(msg) {
  if (!msg?.type || msg.type === 'call-request') return false;
  if (!callMatches(msg.callId, { allowLegacyMissing: true })) return false;

  switch (msg.type) {
    case 'call-ringing':
      return markCallRinging(msg.callId);
    case 'call-accept':
      return markCallConnecting(msg.callId);
    case 'call-connected':
    case 'call-active':
      return markCallActive(msg.callId);
    case 'call-reject':
      return finalizeCall(msg.callId, CALL_STATES.DECLINED, 'remote-decline');
    case 'call-busy':
      return finalizeCall(msg.callId, CALL_STATES.BUSY, 'remote-busy');
    case 'call-missed':
      return finalizeCall(msg.callId, CALL_STATES.MISSED, 'ring-timeout');
    case 'call-cancel':
      return finalizeCall(
        msg.callId,
        activeCall.direction === CALL_DIRECTIONS.INCOMING ? CALL_STATES.MISSED : CALL_STATES.ENDED,
        'caller-cancelled',
      );
    case 'call-failed':
      return finalizeCall(msg.callId, CALL_STATES.FAILED, msg.reason || 'remote-failed');
    case 'call-end':
      return finalizeCall(msg.callId, CALL_STATES.ENDED, 'remote-ended');
    default:
      return false;
  }
}

export function registerCallUiController(controller) {
  uiController = controller || null;
  maybeRestoreUi();
  return {
    remove() {
      if (uiController === controller) uiController = null;
    },
  };
}

export function subscribeToCallState(listener, { emitCurrent = true } = {}) {
  if (typeof listener !== 'function') return { remove() {} };
  stateSubscribers.add(listener);
  if (emitCurrent) {
    try { listener(snapshot(), null, 'subscribe'); } catch (e) {}
  }
  return { remove: () => stateSubscribers.delete(listener) };
}

export function setCallUiAttached(attached) {
  uiAttached = !!attached;
  if (!uiAttached && activeCall?.direction === CALL_DIRECTIONS.INCOMING && activeCall.state === CALL_STATES.RINGING) {
    notifyIncomingCall(activeCall);
  }
  maybeRestoreUi();
}

export function getActiveCall() {
  return snapshot();
}

export function clearCallRuntime(callId) {
  if (callId && activeCall?.callId && callId !== activeCall.callId) return false;
  cancelRingTimer();
  cancelNativeNotification(activeCall?.callId);
  if (activeCall?.callId) nativeCall('clearCallSession', activeCall.callId);
  const previous = snapshot();
  activeCall = null;
  pendingNativeAction = null;
  pendingUiAction = null;
  lastHandledNativeActionKey = null;
  emitState(previous, 'cleared');
  return true;
}

export function waitForCallRuntimeIdle() {
  return Promise.all([
    initializationPromise.catch(() => null),
    persistenceQueue.catch(() => null),
  ]);
}

export function initializeCallRuntime() {
  if (initialized) return initializationPromise;
  initialized = true;

  appStateSubscription = AppState.addEventListener('change', state => {
    appState = state;
    if (state === 'active') {
      maybeRestoreUi();
    } else if (activeCall?.direction === CALL_DIRECTIONS.INCOMING && activeCall.state === CALL_STATES.RINGING) {
      notifyIncomingCall(activeCall);
    }
  });

  if (CallNotificationModule) {
    try {
      const emitter = new NativeEventEmitter(CallNotificationModule);
      callActionSubscription = emitter.addListener('G1_CALL_ACTION', action => {
        handleNativeAction(action);
      });
    } catch (e) {}
  }

  initializationPromise = restorePersistedCall()
    .catch(() => null)
    .then(() => nativeCall('consumePendingCallAction'))
    .then(action => {
      if (action) pendingNativeAction = action;
      return drainPendingNativeAction();
    })
    .then(() => {
      maybeRestoreUi();
      return snapshot();
    });
  return initializationPromise;
}

export function shutdownCallRuntimeForTests() {
  try { callActionSubscription?.remove?.(); } catch (e) {}
  try { appStateSubscription?.remove?.(); } catch (e) {}
  callActionSubscription = null;
  appStateSubscription = null;
  cancelRingTimer();
  initialized = false;
  uiAttached = true;
  appState = 'active';
  activeCall = null;
  uiController = null;
  pendingNativeAction = null;
  pendingUiAction = null;
  lastHandledNativeActionKey = null;
  persistenceQueue = Promise.resolve();
  initializationPromise = Promise.resolve();
  ringTimeoutMs = DEFAULT_RING_TIMEOUT_MS;
  stateSubscribers.clear();
}

export function configureCallRuntimeForTests({ timeoutMs } = {}) {
  if (Number.isFinite(timeoutMs) && timeoutMs >= 0) ringTimeoutMs = timeoutMs;
}

initializeCallRuntime();
