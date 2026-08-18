import { TRANSPORTS } from './PeerRegistry';

function firstReachableLan(...candidates) {
  return candidates.find(candidate => (
    candidate?.host &&
    candidate.isReachable !== false &&
    candidate.stale !== true
  )) || null;
}

/**
 * Resolve a stable known-peer LAN target without ever treating an IP address as
 * peer identity. Manual IP-only diagnostics intentionally return null here and
 * remain provisional until signaling identity is established.
 */
export function resolveKnownLanTarget(contact, registryPeer = null) {
  const source = contact || {};
  const sourceDeviceId = source.deviceId || source.peerId || null;
  const registryDeviceId = registryPeer?.deviceId || null;

  if (sourceDeviceId && registryDeviceId && sourceDeviceId !== registryDeviceId) {
    return null;
  }

  const deviceId = sourceDeviceId || registryDeviceId;
  if (!deviceId) return null;

  const directLan = source.host
    ? {
        host: source.host,
        port: source.port || 8089,
        isReachable: source.isReachable,
        stale: source.stale,
      }
    : null;

  const lan = firstReachableLan(
    source.transports?.[TRANSPORTS.LAN],
    directLan,
    registryDeviceId === deviceId ? registryPeer?.transports?.[TRANSPORTS.LAN] : null
  );
  if (!lan) return null;

  return {
    deviceId,
    deviceName:
      source.deviceName ||
      source.name ||
      source.customName ||
      registryPeer?.deviceName ||
      'G1 Device',
    transports: {
      [TRANSPORTS.LAN]: {
        ...lan,
        port: lan.port || 8089,
      },
    },
  };
}

export default resolveKnownLanTarget;
