jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import { TransportFallbackEngine } from '../src/network/TransportFallbackEngine';
import { connectionCoordinator } from '../src/network/ConnectionCoordinator';

describe('TransportFallbackEngine ownership characterization', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('default LAN path delegates the exact peer and timeout to the global coordinator', async () => {
    const session = { id: 'lan-session' };
    const connectLan = jest
      .spyOn(connectionCoordinator, 'connectLanPeer')
      .mockResolvedValue(session);
    const engine = new TransportFallbackEngine({ lanTimeoutMs: 4321 });
    const peer = {
      deviceId: 'peer-stable-id',
      transports: {
        LAN: { host: '192.168.0.36', port: 8089 },
        P2P: { deviceAddress: '02:00:00:00:00:36' },
      },
    };
    const connectP2p = jest.fn();

    await expect(engine.connect(peer, { connectP2p })).resolves.toEqual({
      transport: 'LAN',
      session,
    });

    expect(connectLan).toHaveBeenCalledTimes(1);
    expect(connectLan).toHaveBeenCalledWith(peer, 4321);
    expect(connectP2p).not.toHaveBeenCalled();
  });

  test('explicit LAN refusal preserves the same peer object when falling through to P2P', async () => {
    const refusal = new Error('ECONNREFUSED');
    jest.spyOn(connectionCoordinator, 'connectLanPeer').mockRejectedValue(refusal);
    const engine = new TransportFallbackEngine({ lanTimeoutMs: 4321 });
    const peer = {
      deviceId: 'peer-stable-id',
      transports: {
        LAN: { host: '192.168.0.36', port: 8089 },
        P2P: { deviceAddress: '02:00:00:00:00:36' },
      },
    };
    const p2pResult = { connected: true };
    const connectP2p = jest.fn().mockResolvedValue(p2pResult);

    await expect(engine.connect(peer, { connectP2p })).resolves.toEqual({
      transport: 'P2P',
      result: p2pResult,
    });

    expect(connectionCoordinator.connectLanPeer).toHaveBeenCalledWith(peer, 4321);
    expect(connectP2p).toHaveBeenCalledTimes(1);
    expect(connectP2p).toHaveBeenCalledWith(peer);
  });
});
