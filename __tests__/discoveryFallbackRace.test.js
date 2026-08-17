jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import { PeerRegistry, PEER_STATUS } from '../src/network/PeerRegistry';
import { ConnectionCoordinator, COORDINATOR_STATE } from '../src/network/ConnectionCoordinator';
import { TransportFallbackEngine, TRANSPORT_MODE } from '../src/network/TransportFallbackEngine';

function makeMockSocket() {
  const handlers = {};
  return {
    on: jest.fn((event, callback) => { handlers[event] = callback; }),
    once: jest.fn((event, callback) => { handlers[event] = callback; }),
    removeListener: jest.fn(),
    emit: (event, value) => { if (handlers[event]) handlers[event](value); },
    destroy: jest.fn(),
    write: jest.fn(),
  };
}

describe('Discovery & Fallback Race Conditions', () => {
  let registry;

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new PeerRegistry({ myDeviceId: 'device-alpha' });
  });

  test('handles rapid mDNS resolve bursts for the same peer without duplicating registry', () => {
    for (let i = 0; i < 20; i++) {
      registry.upsertLanPeer({
        deviceId: 'device-beta',
        deviceName: 'Beta Phone',
        host: '192.168.1.100',
        port: 8089,
        attributes: { protoVer: '1' },
      });
    }

    const peers = registry.getAllPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0].deviceId).toBe('device-beta');
  });

  test('resolves bidirectional simultaneous connection race deterministically', () => {
    // Device Alpha ('device-alpha') vs Device Beta ('device-beta')
    // Lexicographical: 'device-alpha' < 'device-beta'
    // 'device-alpha' yields (yield = true), 'device-beta' retains (yield = false)
    const coordAlpha = new ConnectionCoordinator({ myDeviceId: 'device-alpha' });
    const coordBeta = new ConnectionCoordinator({ myDeviceId: 'device-beta' });

    expect(coordAlpha.shouldYieldToInbound('device-beta')).toBe(true);
    expect(coordBeta.shouldYieldToInbound('device-alpha')).toBe(false);

    // Alpha cancels outbound and accepts Beta's inbound socket
    const socketFromBeta = makeMockSocket();
    const acceptedAtAlpha = coordAlpha.handleIncomingSession(socketFromBeta, {
      deviceId: 'device-beta',
      deviceName: 'Beta Phone',
    });

    expect(acceptedAtAlpha).toBe(true);
    expect(coordAlpha.state).toBe(COORDINATOR_STATE.CONNECTED);

    coordAlpha.disconnect();
    coordBeta.disconnect();
  });

  test('fallback engine gracefully recovers when LAN dialing fails before P2P succeeds', async () => {
    const engine = new TransportFallbackEngine({ mode: TRANSPORT_MODE.AUTO });
    const coord = new ConnectionCoordinator({ myDeviceId: 'device-alpha' });

    jest.spyOn(coord, 'connectLanPeer').mockRejectedValue(new Error('ECONNREFUSED'));

    const peer = {
      deviceId: 'device-gamma',
      transports: {
        LAN: { host: '192.168.1.200', port: 8089 },
        P2P: { deviceAddress: '02:00:00:00:00:0G' },
      },
    };

    const connectP2p = jest.fn().mockResolvedValue({ p2pConnected: true });
    const result = await engine.connect(peer, { connectP2p });

    expect(result.transport).toBe('P2P');
    expect(connectP2p).toHaveBeenCalledTimes(1);

    coord.disconnect();
  });

  test('cancels in-flight connection attempt cleanly when user disconnects', () => {
    const coord = new ConnectionCoordinator({ myDeviceId: 'device-alpha' });
    coord.state = COORDINATOR_STATE.CONNECTING;
    coord.currentPeer = { deviceId: 'peer-pending' };

    coord.cancelConnecting();
    expect(coord.state).toBe(COORDINATOR_STATE.IDLE);
    coord.disconnect();
  });
});
