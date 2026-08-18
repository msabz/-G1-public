import { TRANSPORTS } from './PeerRegistry';

export function requiresWifiDirectCleanup(transport) {
  return transport === TRANSPORTS.P2P;
}

export default requiresWifiDirectCleanup;
