import { AppState, NativeEventEmitter, NativeModules } from 'react-native';
import { sendSignalingMessage } from '../webrtc/signaling';
import { stopRingtone } from '../media/AudioClip';
import { saveCallRecord } from './Persistence';

const { CallNotificationModule } = NativeModules;

let uiAttached = true;
let appState = AppState.currentState || 'active';
let activeCall = null;
let uiController = null;
let pendingNativeAction = null;
let initialized = false;
let callActionSubscription = null;
let appStateSubscription = null;

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

function isTerminal(state) {
  return ['ended', 'missed', 'declined', 'rejected', 'busy', 'noanswer', 'cancelled', 'failed'].includes(state);
}

function callMatches(callId) {
  if (!activeCall) return false;
  if (!callId || !activeCall.callId) return true; // legacy peer compatibility
  return callId === activeCall.callId;
}

function persist(call) {
  if (!call?.peerId || !call?.callId) return Promise.resolve(null);
  return saveCallRecord({
    callId: call.callId,
    peerId: call.peerId,
    peerName: call.peerName,
    direction: call.direction,
    mediaType: call.video ? 'video' : 'voice',
    startedAt: call.startedAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    duration: call.duration || 0,
    finalState: call.finalState || 'ringing',
    endReason: call.endReason || null,
  });
}

function cancelNativeNotification(callId) {
  if (!callId) return;
  nativeCall('cancelIncomingCall', callId);
}

function maybeRestoreUi() {
  if (!uiAttached || !uiController || !activeCall || activeCall.direction !== 'incoming') return;
  if (isTerminal(activeCall.finalState)) return;
  try { uiController.restore?.(snapshot()); } catch (e) {}

  if (pendingNativeAction && callMatches(pendingNativeAction.callId)) {
    const action = pendingNativeAction;
    pendingNativeAction = null;
    if (action.action === 'accept') {
      try { uiController.accept?.(snapshot(), { fromNotification: true }); } catch (e) {}
    } else if (action.action === 'reject') {
      try { uiController.reject?.(snapshot(), { fromNotification: true }); } catch (e) {}
    }
  }
}

export function createCallId(peerId = 'peer') {
  return `call_${String(peerId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20)}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function beginOutgoingCall({ peerId, peerName, video, callId }) {
  const id = callId || createCallId(peerId || 'peer');
  activeCall = {
    callId: id,
    peerId: peerId || 'unknown-peer',
    peerName: peerName || 'G1 Device',
    direction: 'outgoing',
    video: !!video,
    startedAt: Date.now(),
    answeredAt: null,
    endedAt: null,
    duration: 0,
    finalState: 'ringing',
    endReason: null,
  };
  persist(activeCall);
  return id;
}

export function handleIncomingCallRequest(msg, peer = {}) {
  const callId = msg?.callId || createCallId(peer.deviceId || peer.peerId || 'legacy');

  if (activeCall && !isTerminal(activeCall.finalState) && !callMatches(callId)) {
    return { accepted: false, reason: 'busy', activeCall: snapshot() };
  }

  activeCall = {
    callId,
    peerId: peer.deviceId || peer.peerId || msg?.peerId || 'unknown-peer',
    peerName: peer.deviceName || peer.name || msg?.peerName || 'G1 Device',
    direction: 'incoming',
    video: !!msg?.video,
    ip: msg?.ip || null,
    startedAt: Date.now(),
    answeredAt: null,
    endedAt: null,
    duration: 0,
    finalState: 'ringing',
    endReason: null,
  };
  persist(activeCall);

  if (!uiAttached || appState !== 'active') {
    nativeCall('showIncomingCall', callId, activeCall.peerName, activeCall.video);
  }
  maybeRestoreUi();
  return { accepted: true, call: snapshot() };
}

export function markCallAnswered(callId) {
  if (!callMatches(callId)) return false;
  if (!activeCall.answeredAt) activeCall.answeredAt = Date.now();
  activeCall.finalState = 'connected';
  cancelNativeNotification(activeCall.callId);
  persist(activeCall);
  return true;
}

export function finalizeCall(callId, finalState = 'ended', endReason = null) {
  if (!callMatches(callId)) return false;
  const now = Date.now();
  activeCall.endedAt = now;
  activeCall.finalState = finalState;
  activeCall.endReason = endReason;
  activeCall.duration = activeCall.answeredAt
    ? Math.max(0, Math.round((now - activeCall.answeredAt) / 1000))
    : 0;
  cancelNativeNotification(activeCall.callId);
  persist(activeCall);
  return true;
}

export function handleRemoteCallSignal(msg) {
  if (!msg?.type) return;
  if (msg.type === 'call-request') return;
  if (msg.callId && activeCall?.callId && msg.callId !== activeCall.callId) return;

  switch (msg.type) {
    case 'call-accept':
      markCallAnswered(msg.callId);
      break;
    case 'call-reject':
      finalizeCall(msg.callId, 'rejected', 'remote-reject');
      break;
    case 'call-busy':
      finalizeCall(msg.callId, 'busy', 'remote-busy');
      break;
    case 'call-missed':
      finalizeCall(msg.callId, activeCall?.direction === 'outgoing' ? 'noanswer' : 'missed', 'timeout');
      break;
    case 'call-cancel':
      finalizeCall(msg.callId, activeCall?.direction === 'incoming' ? 'missed' : 'cancelled', 'caller-cancelled');
      break;
    case 'call-end':
      finalizeCall(msg.callId, 'ended', 'remote-ended');
      break;
    default:
      break;
  }
}

function rejectWithoutUi(call) {
  if (!call) return;
  stopRingtone().catch(() => {});
  sendSignalingMessage({ type: 'call-reject', callId: call.callId });
  finalizeCall(call.callId, 'declined', 'notification-reject');
}

function handleNativeAction(action) {
  if (!action?.action || !action?.callId) return;
  if (!callMatches(action.callId)) {
    // The action can arrive while JS is being recreated. Keep it until the
    // matching call state is restored rather than applying it to a new call.
    pendingNativeAction = action;
    return;
  }

  if (action.action === 'reject') {
    if (uiController && uiAttached) {
      try { uiController.reject?.(snapshot(), { fromNotification: true }); } catch (e) {
        rejectWithoutUi(snapshot());
      }
    } else {
      rejectWithoutUi(snapshot());
    }
    pendingNativeAction = null;
    return;
  }

  if (action.action === 'accept') {
    if (uiController && uiAttached) {
      try { uiController.accept?.(snapshot(), { fromNotification: true }); } catch (e) {
        pendingNativeAction = action;
      }
    } else {
      pendingNativeAction = action;
    }
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

export function setCallUiAttached(attached) {
  uiAttached = !!attached;
  maybeRestoreUi();
}

export function getActiveCall() {
  return snapshot();
}

export function clearCallRuntime(callId) {
  if (callId && activeCall?.callId && callId !== activeCall.callId) return;
  cancelNativeNotification(activeCall?.callId);
  activeCall = null;
  pendingNativeAction = null;
}

export function initializeCallRuntime() {
  if (initialized) return;
  initialized = true;

  appStateSubscription = AppState.addEventListener('change', state => {
    appState = state;
    if (state === 'active') maybeRestoreUi();
  });

  if (CallNotificationModule) {
    try {
      const emitter = new NativeEventEmitter(CallNotificationModule);
      callActionSubscription = emitter.addListener('G1_CALL_ACTION', handleNativeAction);
    } catch (e) {}

    nativeCall('consumePendingCallAction').then(action => {
      if (action) handleNativeAction(action);
    });
  }
}

export function shutdownCallRuntimeForTests() {
  try { callActionSubscription?.remove?.(); } catch (e) {}
  try { appStateSubscription?.remove?.(); } catch (e) {}
  callActionSubscription = null;
  appStateSubscription = null;
  initialized = false;
  uiAttached = true;
  appState = 'active';
  activeCall = null;
  uiController = null;
  pendingNativeAction = null;
}

initializeCallRuntime();
