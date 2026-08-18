import { TRANSPORTS } from '../src/network/PeerRegistry';
import { resolveKnownLanTarget } from '../src/network/knownLanTarget';

describe('known LAN target resolution', () => {
  test('preserves discovered stable device identity with its reachable LAN route', () => {
    const target = resolveKnownLanTarget({
      deviceId: 'peer-device',
      deviceName: 'Peer',
      transports: {
        [TRANSPORTS.LAN]: {
          host: '192.168.0.36',
          port: 8089,
          isReachable: true,
        },
      },
    });

    expect(target).toEqual({
      deviceId: 'peer-device',
      deviceName: 'Peer',
      transports: {
        [TRANSPORTS.LAN]: {
          host: '192.168.0.36',
          port: 8089,
          isReachable: true,
        },
      },
    });
  });

  test('uses persisted peerId as stable device identity with a matching registry LAN route', () => {
    const target = resolveKnownLanTarget(
      { peerId: 'saved-peer', name: 'Saved Peer' },
      {
        deviceId: 'saved-peer',
        deviceName: 'Registry Peer',
        transports: {
          [TRANSPORTS.LAN]: {
            host: '192.168.0.44',
            port: 9090,
            isReachable: true,
          },
        },
      }
    );

    expect(target.deviceId).toBe('saved-peer');
    expect(target.deviceName).toBe('Saved Peer');
    expect(target.transports[TRANSPORTS.LAN].host).toBe('192.168.0.44');
    expect(target.transports[TRANSPORTS.LAN].port).toBe(9090);
  });

  test('falls through a stale contact route to a newer reachable registry route', () => {
    const target = resolveKnownLanTarget(
      {
        deviceId: 'peer-device',
        transports: {
          [TRANSPORTS.LAN]: {
            host: '192.168.0.10',
            isReachable: false,
            stale: true,
          },
        },
      },
      {
        deviceId: 'peer-device',
        transports: {
          [TRANSPORTS.LAN]: {
            host: '192.168.0.36',
            isReachable: true,
            stale: false,
          },
        },
      }
    );

    expect(target.transports[TRANSPORTS.LAN].host).toBe('192.168.0.36');
  });

  test('rejects a registry route that belongs to a different stable peer identity', () => {
    expect(resolveKnownLanTarget(
      { peerId: 'peer-a' },
      {
        deviceId: 'peer-b',
        transports: {
          [TRANSPORTS.LAN]: {
            host: '192.168.0.55',
            isReachable: true,
          },
        },
      }
    )).toBeNull();
  });

  test('keeps manual IP-only diagnostics provisional instead of inventing peer identity', () => {
    expect(resolveKnownLanTarget({ host: '192.168.0.99', port: 8089 })).toBeNull();
  });

  test('returns null when no reachable current LAN route exists', () => {
    expect(resolveKnownLanTarget({
      deviceId: 'peer-device',
      transports: {
        [TRANSPORTS.LAN]: {
          host: '192.168.0.36',
          isReachable: false,
          stale: true,
        },
      },
    })).toBeNull();
  });
});
