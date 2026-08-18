import { isSameSignalingEndpoint } from '../webrtc/signaling';
import { connectionCoordinator } from './ConnectionCoordinator';
import { peerRegistry, TRANSPORTS } from './PeerRegistry';

export function createLanPassiveAdmissionHandler(options = {}) {
  const registry = options.registry || peerRegistry;
  const coordinator = options.coordinator || connectionCoordinator;

  return ({ message, peerAddress } = {}) => {
    if (message?.type !== 'identity' || !message.deviceId) {
      return { accepted: false, reason: 'identity-required' };
    }

    const peer = registry.getPeer?.(message.deviceId) || null;
    if (!peer) {
      return { accepted: false, reason: 'unknown-peer' };
    }

    const endpoint = peer.transports?.[TRANSPORTS.LAN] || null;
    if (
      !endpoint ||
      typeof registry.isTransportEndpointCurrent !== 'function' ||
      !registry.isTransportEndpointCurrent(endpoint, TRANSPORTS.LAN)
    ) {
      return { accepted: false, reason: 'stale-lan-route' };
    }

    if (!isSameSignalingEndpoint(endpoint.host, peerAddress)) {
      return { accepted: false, reason: 'endpoint-mismatch' };
    }

    try {
      coordinator.adoptSignalingOwnerSession(
        peer,
        TRANSPORTS.LAN,
        { requireInbound: true }
      );
    } catch (error) {
      return {
        accepted: false,
        reason: 'coordinator-rejected',
        error: error?.message || String(error),
      };
    }

    return {
      accepted: true,
      peerId: peer.deviceId,
      transport: TRANSPORTS.LAN,
    };
  };
}

export const lanPassiveAdmissionHandler = createLanPassiveAdmissionHandler();

export default lanPassiveAdmissionHandler;
