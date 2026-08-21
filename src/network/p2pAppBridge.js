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

  // A DNS-SD TXT observation is only a discovery-time identity claim. It may
  // supply a usable expected device identity, but it never proves ownership.
  const discoveredIdentity = discoveryIdentityFromPeer(discoveredPeer, routeValues);
  if (discoveredIdentity) return discoveredIdentity;

  // If DNS-SD explicitly made an identity claim and that claim was rejected
  // because it is missing/route-derived, fail closed for this observation.
  // A saved contact is ExpectedIdentity, not permission to replace a bad
  // current claim and report it as though the route's identity were resolved.
  const discoveryClaim = firstText(discoveredPeer.peerId, discoveredPeer.deviceId);
  const hasDnsSdIdentityClaim = !!discoveryClaim && (
    discoveredPeer.identitySource === IDENTITY_SOURCE.DNS_SD_TXT ||
    (discoveredPeer.isMusab === true && !discoveredPeer.identitySource)
  );
  if (hasDnsSdIdentityClaim) return null;

  // A persisted logical device ID remains useful as an *expected* target for a
  // known contact when discovery did not assert a conflicting identity. It is
  // not current-session proof and must be checked by IdentityAuthenticator after
  // a provisional route/signaling channel is established.
  const persistedDeviceId = firstText(contact.deviceId, contact.peerId);
  if (isStableIdentityValue(persistedDeviceId, routeValues)) {
    return buildAdditivePeerIdentity({
      deviceId: persistedDeviceId,
      userId: contact.userId,
      g1Number: contact.g1Number,
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
      g1Number: discoveredPeer.g1Number,
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
    throw new Error('تعذّر تحديد هوية G1 الثابتة المتوقعة لجهاز Wi-Fi Direct');
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

  // Store only the strength actually present at this point. For DNS-SD or a
  // saved contact this is expectation/claim state, never SESSION_PROVEN.
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
    status?.peer?.deviceId === deviceId &&
    status?.provenIdentity?.deviceId === deviceId &&
    status?.provenIdentity?.trust === IDENTITY_TRUST.SESSION_PROVEN;
}

export async function connectP2pFromApp({
  contact = {},
  discoveredPeer = {},
  incoming = false,
  timeoutMs = 30000,
  coordinator = connectionCoordinator,
  registry = peerRegistry,
} = {}) {
  const { peer, identity: expectedIdentity, displayName } = buildCoordinatorP2pPeer({
    contact,
    discoveredPeer,
    registry,
  });

  await coordinator.connectP2pPeer(peer, timeoutMs, {
    incoming,
    expectedIdentity,
  });

  const status = coordinator.getCoordinatorStatus();
  if (!isCoordinatorOwnedP2pSession(status, peer.deviceId)) {
    throw new Error('انتهت جلسة Wi-Fi Direct قبل اكتمال إثبات هوية G1');
  }

  const provenIdentity = status.provenIdentity;
  registry.upsertPeerIdentity?.(provenIdentity);
  const provenPeer = registry.getPeer(peer.deviceId) || status.peer || peer;

  return {
    peer: provenPeer,
    identity: provenIdentity,
    expectedIdentity,
    displayName,
    route: status.p2p?.activeRoute || null,
    controlOwner: 'COORDINATOR',
    transport: TRANSPORTS.P2P,
  };
}
