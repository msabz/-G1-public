import { States, Tiers } from '../utils/stateMachine';
import { TRANSPORTS } from './PeerRegistry';
import { CONTROL_PLANE_OWNERS } from './sessionDisconnectPlan';

function isConnectedLanCoordinatorFor(coordinatorStatus, peerId) {
  return !!peerId &&
    coordinatorStatus?.state === 'CONNECTED' &&
    coordinatorStatus?.transport === TRANSPORTS.LAN &&
    coordinatorStatus?.peer?.deviceId === peerId;
}

function isHealthyAdmittedInbound(signalingHealth) {
  return signalingHealth?.connected === true &&
    signalingHealth?.direction === 'inbound' &&
    signalingHealth?.passiveAdmissionAccepted === true &&
    !!signalingHealth?.peerAddress;
}

function messageFingerprint(message) {
  if (!message || typeof message !== 'object') return 'invalid';
  if (message.id != null) return `id:${message.id}`;
  if (message.messageId != null) return `messageId:${message.messageId}`;
  if (message.transferId != null) return `transferId:${message.transferId}`;
  return [
    message.sender || '',
    message.type || '',
    Number(message.time) || 0,
    message.text || '',
    message.fileName || '',
    message.path || '',
    message.callKind || '',
    message.callResult || '',
  ].join('|');
}

export function mergePeerMessageHistory(history = [], liveMessages = []) {
  const merged = [];
  const indexByKey = new Map();

  const upsert = (message, preferIncoming) => {
    if (!message || typeof message !== 'object') return;
    const key = messageFingerprint(message);
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, merged.length);
      merged.push(message);
      return;
    }
    if (preferIncoming) {
      merged[existingIndex] = { ...merged[existingIndex], ...message };
    }
  };

  (Array.isArray(history) ? history : []).forEach(message => upsert(message, false));
  (Array.isArray(liveMessages) ? liveMessages : []).forEach(message => upsert(message, true));
  return merged;
}

export function shouldAllowPassiveLanAdmission({
  uiMounted = true,
  appState,
  pendingKnownLanPeerId = null,
  messageDeviceId = null,
} = {}) {
  if (!messageDeviceId) return false;
  if (uiMounted === false) return true;
  if (appState === States.IDLE || appState === States.DISCONNECTED) return true;
  if (appState === States.WIFI_CONNECTING) {
    return !!pendingKnownLanPeerId && pendingKnownLanPeerId === messageDeviceId;
  }
  return false;
}

export function getPassiveLanPromotionPlan({
  message,
  appState,
  uiMounted = true,
  pendingKnownLanPeerId = null,
  coordinatorStatus,
  signalingHealth,
} = {}) {
  if (message?.type !== 'identity' || !message.deviceId) return null;
  if (uiMounted === false) return null;
  if (!shouldAllowPassiveLanAdmission({
    uiMounted,
    appState,
    pendingKnownLanPeerId,
    messageDeviceId: message.deviceId,
  })) {
    return null;
  }
  if (!isConnectedLanCoordinatorFor(coordinatorStatus, message.deviceId)) return null;
  if (!isHealthyAdmittedInbound(signalingHealth)) return null;

  return {
    peerId: message.deviceId,
    host: signalingHealth.peerAddress,
    transport: TRANSPORTS.LAN,
    controlOwner: CONTROL_PLANE_OWNERS.COORDINATOR,
    tier: Tiers.LAN,
    convergedPendingKnownLan:
      appState === States.WIFI_CONNECTING &&
      pendingKnownLanPeerId === message.deviceId,
  };
}

export function isKnownLanRaceWinner({
  targetDeviceId,
  coordinatorStatus,
  signalingHealth,
} = {}) {
  return !!targetDeviceId &&
    isConnectedLanCoordinatorFor(coordinatorStatus, targetDeviceId) &&
    isHealthyAdmittedInbound(signalingHealth);
}
