import { connectionCoordinator } from './ConnectionCoordinator';
import { peerRegistry, TRANSPORTS } from './PeerRegistry';

function firstText(...values) {
  return values.find(value => typeof value === 'string' && value.trim()) || '';
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function resolveStableP2pDeviceId(contact = {}, discoveredPeer = {}) {
  // DNS-SD/Musab discovery is allowed to provide a stable G1 peerId. A raw
  // Wi-Fi Direct deviceAddress is route metadata only and must never be promoted
  // into logical identity.
  if (discoveredPeer.isMusab === true && discoveredPeer.peerId) {
    return discoveredPeer.peerId;
  }

  const candidate = firstText(
    contact.deviceId,
    contact.peerId,
    discoveredPeer.deviceId
  );
  if (!candidate) return null;

  const normalizedCandidate = normalizeText(candidate);
  const routeAddresses = [
    discoveredPeer.deviceAddress,
    contact.deviceAddress,
    contact.transports?.[TRANSPORTS.P2P]?.deviceAddress,
  ]
    .map(normalizeText)
    .filter(Boolean);

  if (routeAddresses.includes(normalizedCandidate)) {
    return null;
  }

  return candidate;
}

export function buildCoordinatorP2pPeer({
  contact = {},
  discoveredPeer = {},
  registry = peerRegistry,
} = {}) {
  const deviceId = resolveStableP2pDeviceId(contact, discoveredPeer);
  const deviceAddress = firstText(
    discoveredPeer.deviceAddress,
    contact.deviceAddress,
    contact.transports?.[TRANSPORTS.P2P]?.deviceAddress
  );

  if (!deviceId) {
    throw new Error('تعذّر إثبات هوية G1 الثابتة لجهاز Wi-Fi Direct');
  }
  if (!deviceAddress) {
    throw new Error('عنوان Wi-Fi Direct الحالي غير متاح');
  }

  const deviceName = firstText(
    contact.customName,
    contact.name,
    discoveredPeer.name,
    discoveredPeer.deviceName,
    contact.deviceName,
    'G1 Device'
  );

  registry.upsertP2pPeer({
    deviceId,
    deviceName,
    deviceAddress,
    isGroupOwner: null,
    groupOwnerAddress: null,
    interfaceName: null,
    connectionEpoch: null,
    isOnline: true,
  });

  const peer = registry.getPeer(deviceId);
  if (!peer?.transports?.[TRANSPORTS.P2P]?.deviceAddress) {
    throw new Error('تعذّر تسجيل مسار Wi-Fi Direct الحالي');
  }

  return {
    peer,
    displayName: firstText(contact.customName, contact.name, deviceName, 'الجهاز الآخر'),
  };
}

export function isCoordinatorOwnedP2pSession(status, deviceId) {
  return !!deviceId &&
    status?.state === 'CONNECTED' &&
    status?.transport === TRANSPORTS.P2P &&
    status?.peer?.deviceId === deviceId;
}

export async function connectP2pFromApp({
  contact = {},
  discoveredPeer = {},
  incoming = false,
  timeoutMs = 30000,
  coordinator = connectionCoordinator,
  registry = peerRegistry,
} = {}) {
  const { peer, displayName } = buildCoordinatorP2pPeer({
    contact,
    discoveredPeer,
    registry,
  });

  await coordinator.connectP2pPeer(peer, timeoutMs, { incoming });

  const status = coordinator.getCoordinatorStatus();
  if (!isCoordinatorOwnedP2pSession(status, peer.deviceId)) {
    throw new Error('انتهت جلسة Wi-Fi Direct قبل اكتمال تهيئة المحادثة');
  }

  return {
    peer,
    displayName,
    route: status.p2p?.activeRoute || null,
    controlOwner: 'COORDINATOR',
    transport: TRANSPORTS.P2P,
  };
}
