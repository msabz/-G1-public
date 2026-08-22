import {
  addSignalingDisconnectObserver,
  addSignalingMessageObserver,
} from '../webrtc/signaling';
import {
  onIncomingDone,
  onIncomingStart,
} from '../media/FileShare';
import { saveMessage, savePeer } from './Persistence';
import { showMessageNotification } from './Background';
import { createIncomingTextMessage, ensureMessageIdentity } from '../messaging/messageModel';
import {
  clearCallRuntime,
  getActiveCall,
  handleIncomingCallRequest,
  handleRemoteCallSignal,
  setCallUiAttached,
} from './CallRuntime';

const MAX_PENDING_WITHOUT_IDENTITY = 50;

let uiAttached = true;
let currentPeer = null;
let pendingWithoutIdentity = [];
const incomingTransfers = new Map();
let initialized = false;
let subscriptions = [];

function peerLabel() {
  return currentPeer?.deviceName || currentPeer?.name || 'G1 DirectChat';
}

function enqueueUntilIdentity(entry) {
  pendingWithoutIdentity.push(entry);
  if (pendingWithoutIdentity.length > MAX_PENDING_WITHOUT_IDENTITY) {
    pendingWithoutIdentity = pendingWithoutIdentity.slice(-MAX_PENDING_WITHOUT_IDENTITY);
  }
}

async function persistIncomingMessage(message, notificationBody) {
  const peerId = currentPeer?.deviceId;
  if (!peerId) {
    enqueueUntilIdentity({ message, notificationBody });
    return false;
  }

  await saveMessage(peerId, message);
  await savePeer(peerId, peerLabel(), notificationBody || message.text || 'رسالة جديدة');
  if (notificationBody) {
    await showMessageNotification(peerLabel(), notificationBody);
  }
  return true;
}

async function flushPendingAfterIdentity() {
  if (uiAttached || !currentPeer?.deviceId || !pendingWithoutIdentity.length) return;
  const pending = pendingWithoutIdentity;
  pendingWithoutIdentity = [];
  for (const entry of pending) {
    await persistIncomingMessage(entry.message, entry.notificationBody);
  }
}

function rememberIdentity(msg) {
  if (!msg?.deviceId) return;
  currentPeer = {
    deviceId: msg.deviceId,
    deviceName: msg.deviceName || currentPeer?.deviceName || 'G1 Device',
  };
  flushPendingAfterIdentity().catch(() => {});
}

function handleBackgroundSignal(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'identity' || msg.type === 'handshake-hello' || msg.type === 'handshake-welcome') {
    rememberIdentity(msg);
    return;
  }

  if (msg.type === 'call-request') {
    handleIncomingCallRequest(msg, currentPeer || {});
    return;
  }

  if (
    msg.type === 'call-ringing' ||
    msg.type === 'call-accept' ||
    msg.type === 'call-connected' ||
    msg.type === 'call-active' ||
    msg.type === 'call-reject' ||
    msg.type === 'call-busy' ||
    msg.type === 'call-missed' ||
    msg.type === 'call-cancel' ||
    msg.type === 'call-failed' ||
    msg.type === 'call-end'
  ) {
    handleRemoteCallSignal(msg);
  }

  if (uiAttached) return;

  if (msg.type === 'chat') {
    const message = createIncomingTextMessage(msg);
    if (message) persistIncomingMessage(message, message.text).catch(() => {});
  }
}

function handleIncomingStart({ id, fileName, mimeType, kind, size }) {
  if (!id) return;
  incomingTransfers.set(id, {
    id,
    fileName,
    mimeType,
    kind,
    size,
    startedAt: Date.now(),
  });
}

function handleIncomingDone({ id, path, size, fileName, mimeType, kind }) {
  if (!id) return;
  const start = incomingTransfers.get(id) || {};
  incomingTransfers.delete(id);
  if (uiAttached) return;

  const resolvedKind = kind || start.kind || 'file';
  const resolvedName = fileName || start.fileName || 'file';
  const resolvedMime = mimeType || start.mimeType || 'application/octet-stream';
  const localUri = path
    ? (path.startsWith('content://') || path.startsWith('file://') ? path : `file://${path}`)
    : null;
  const type = resolvedKind === 'voice' ? 'voice' : resolvedKind === 'image' ? 'image' : 'file';
  const message = ensureMessageIdentity({
    sender: 'remote',
    type,
    fileName: resolvedName,
    mimeType: resolvedMime,
    path,
    localUri,
    size: size || start.size || 0,
    status: 'delivered',
    time: Date.now(),
  });
  const notificationBody =
    resolvedKind === 'voice' ? 'رسالة صوتية' :
    resolvedKind === 'image' ? 'صورة' :
    `ملف: ${resolvedName}`;
  persistIncomingMessage(message, notificationBody).catch(() => {});
}

function handleSignalingDisconnected() {
  // Keep identity briefly in memory for a transient recovery; a replacement
  // identity message will overwrite it. Transfer metadata is session-specific.
  incomingTransfers.clear();
}

export function setUiAttached(attached) {
  uiAttached = !!attached;
  setCallUiAttached(uiAttached);
  if (!uiAttached) {
    flushPendingAfterIdentity().catch(() => {});
  }
}

export function isUiAttached() {
  return uiAttached;
}

export function getBackgroundPeer() {
  return currentPeer ? { ...currentPeer } : null;
}

export function getPendingIncomingCall() {
  const call = getActiveCall();
  return call?.direction === 'incoming' && ![
    'ended', 'missed', 'declined', 'rejected', 'cancelled', 'busy', 'failed',
  ].includes(call.finalState)
    ? call
    : null;
}

export function clearPendingIncomingCall() {
  const call = getActiveCall();
  if (call?.direction === 'incoming') clearCallRuntime(call.callId);
}

export function initializeBackgroundRuntime() {
  if (initialized) return;
  initialized = true;
  subscriptions = [
    addSignalingMessageObserver(handleBackgroundSignal),
    addSignalingDisconnectObserver(handleSignalingDisconnected),
    onIncomingStart(handleIncomingStart),
    onIncomingDone(handleIncomingDone),
  ];
}

export function shutdownBackgroundRuntimeForTests() {
  subscriptions.forEach(subscription => {
    try { subscription?.remove?.(); } catch (e) {}
  });
  subscriptions = [];
  initialized = false;
  uiAttached = true;
  setCallUiAttached(true);
  currentPeer = null;
  pendingWithoutIdentity = [];
  incomingTransfers.clear();
}

initializeBackgroundRuntime();
