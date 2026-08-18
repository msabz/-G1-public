import { TRANSPORTS } from '../src/network/PeerRegistry';
import { requiresWifiDirectCleanup } from '../src/network/sessionCleanupPolicy';

describe('session cleanup transport policy', () => {
  test('only a Wi-Fi Direct session requires Wi-Fi Direct transport cleanup', () => {
    expect(requiresWifiDirectCleanup(TRANSPORTS.P2P)).toBe(true);
    expect(requiresWifiDirectCleanup(TRANSPORTS.LAN)).toBe(false);
    expect(requiresWifiDirectCleanup(TRANSPORTS.BLUETOOTH)).toBe(false);
    expect(requiresWifiDirectCleanup(null)).toBe(false);
    expect(requiresWifiDirectCleanup(undefined)).toBe(false);
  });
});
