import { isSameSignalingEndpoint } from '../webrtc/signaling';
import { connectionCoordinator } from './ConnectionCoordinator';
import { peerRegistry, TRANSPORTS } from './PeerRegistry';
import { shouldAllowPassiveLanAdmission } from './passiveLanAppPolicy';

let passiveLanAdmissionContextProvider = null;

export function setLanPassiveAdmissionContextProvider(provider) {
  passiveLanAdmissionContextProvider = typeof provider === 'function' ? provider : null;
}

export function createLanPassiveAdmissionHandler(options = {}) {
  const registry = options.registry || peerRegistry;
  const coordinator = options.coordinator || connectionCoordinator;

  return ({ message, peerAddress, validateOnly = false } = {}) => {
    if (message?.type !== 'identity' || !message.deviceId) {
      return { accepted: false, reason: 'identity-required' };
    }

    if (passiveLanAdmissionContextProvider) {
      let context = null;
      try {
        context = passiveLanAdmissionContextProvider() || {};
      } catch (error) {
        return {
          accepted: false,
          reason: 'context-error',
          error: error?.message || String(error),
        };
      }

      if (!shouldAllowPassiveLanAdmission({
        ...context,
        messageDeviceId: message.deviceId,
      })) {
        return { accepted: false, reason: 'app-busy' };
      }
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

    const decision = {
      accepted: true,
      peerId: peer.deviceId,
      transport: TRANSPORTS.LAN,
      // Deterministic simultaneous-connect rule already owned by coordinator:
      // lower stable deviceId yields its outbound attempt to the inbound socket;
      // higher stable deviceId retains outbound. Expose it during provisional
      // duplicate validation without mutating coordinator/session state yet.
      preferInbound: typeof coordinator.shouldYieldToInbound === 'function'
        ? coordinator.shouldYieldToInbound(message.deviceId)
        : false,
    };

    if (validateOnly) {
      return decision;
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

    return decision;
  };
}

export const lanPassiveAdmissionHandler = createLanPassiveAdmissionHandler();

export default lanPassiveAdmissionHandler;
