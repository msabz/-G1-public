import { connectionCoordinator } from './ConnectionCoordinator';
import { peerRegistry, TRANSPORTS } from './PeerRegistry';
import {
  IDENTITY_SOURCE,
  IDENTITY_TRUST,
  buildAdditivePeerIdentity,
  discoveryIdentityFromPeer,
  isStableIdentityValue,
} from './IdentityModel';

function firstText(...values) {
  return values.find(value => typeof value === 'string' && value.trim()) || '';
}

function currentRouteValues(contact = {}, discoveredPeer = {}) {
  return [
    discoveredPeer.deviceAddress,
    contact.deviceAddress,
    contact.transports?.[TRANSPORTS.P2P]?.deviceAddress,
    discoveredPeer.groupOwnerAddress,
    contact.transports?.[TRANSPORTS.P2P]?.groupOwnerAddress,
  ].filter(Boolean);
}

export function resolveStableP2pIdentity(contact = {}, discoveredPeer = {}) {
  const routeValues = currentRouteValues(contact, discoveredPeer);

  // A DNS-SD TXT observation is the strongest discovery-time candidate, but
  // it remains only DISCOVERY_ASSERTED until a session proof authenticates it.
  const discoveredIdentity = discoveryIdentityFromPeer(discoveredPeer, routeValues);
  if (discoveredIdentity) return discoveredIdentity;

  // Persisted IDs are allowed to route a known conversation/device. They are
  // never reconstructed from a P2P MAC/IP and do not become SESSION_PROVEN by
  // virtue of being saved locally.
  const persistedDeviceId = firstText(contact.deviceId, contact.peerId);
  if (isStableIdentityValue(persistedDeviceId, routeValues)) {
    return buildAdditivePeerIdentity({
      deviceId: persistedDeviceId,
      userId: contact.userId,
      displayName: contact.displayName || contact.customName || contact.name,
      deviceName: contact.deviceName,
      keyFingerprint: contact.keyFingerprint || contact.identityKeyFingerprint,
      trust: Object.values(IDENTITY_TRUST).includes(contact.identityTrust)
        ? contact.identityTrust
        : IDENTITY_TRUST.UNVERIFIED,
      source: IDENTITY_SOURCE.PERSISTED,
    });
  }

  const explicitDeviceId = discoveredPeer.deviceId;
  if (isStableIdentityValue(explicitDeviceId, routeValues)) {
    return buildAdditivePeerIdentity({
      deviceId: explicitDeviceId,
      userId: discoveredPeer.userId,
      displayName:
        discoveredPeer.displayName || discoveredPeer.name || discoveredPeer.deviceName,
      deviceName: discoveredPeer.deviceName,
      keyFingerprint:
        discoveredPeer.keyFingerprint || discoveredPeer.identityKeyFingerprint,
      trust: IDENTITY_TRUST.UNVERIFIED,
    });
  }

  return null;
}

export function resolveStableP2pDeviceId(contact = {}, discoveredPeer = {}) {
  return resolveStableP2pIdentity(contact, discoveredPeer)?.deviceId || null;
}

export function buildCoordinatorP2pPeer({
  contact = {},
  discoveredPeer = {},
  registry = peerRegistry,
} = {}) {
  const identity = resolveStableP2pIdentity(contact, discoveredPeer);
  const deviceId = identity?.deviceId || null;
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
    identity?.displayName,
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

  registry.upsertPeerIdentity?.(identity);

  const peer = registry.getPeer(deviceId);
  if (!peer?.transports?.[TRANSPORTS.P2P]?.deviceAddress) {
    throw new Error('تعذّر تسجيل مسار Wi-Fi Direct الحالي');
  }

  return {
    peer,
    identity,
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
  const { peer, identity, displayName } = buildCoordinatorP2pPeer({
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
    identity,
    displayName,
    route: status.p2p?.activeRoute || null,
    controlOwner: 'COORDINATOR',
    transport: TRANSPORTS.P2P,
  };
}
