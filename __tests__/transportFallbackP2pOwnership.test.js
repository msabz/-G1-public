jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import {
  TransportFallbackEngine,
  TRANSPORT_MODE,
} from '../src/network/TransportFallbackEngine';

describe('TransportFallbackEngine coordinator-owned P2P default', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('uses coordinator.connectP2pPeer when no compatibility handler is supplied', async () => {
    const coordinator = {
      connectLanPeer: jest.fn(),
      connectP2pPeer: jest.fn().mockResolvedValue({ isConnected: true }),
      cancelConnecting: jest.fn(),
    };
    const engine = new TransportFallbackEngine({
      mode: TRANSPORT_MODE.P2P_ONLY,
      p2pTimeoutMs: 5000,
      coordinator,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: {
        P2P: { deviceAddress: 'AA:BB:CC:DD:EE:FF' },
      },
    };

    const result = await engine.connect(peer);

    expect(result).toEqual({
      transport: 'P2P',
      result: { isConnected: true },
    });
    expect(coordinator.connectP2pPeer).toHaveBeenCalledWith(peer, 5000);
  });

  test('coordinator cancellation is the default timeout hook for P2P', async () => {
    const coordinator = {
      connectLanPeer: jest.fn(),
      connectP2pPeer: jest.fn(() => new Promise(() => {})),
      cancelConnecting: jest.fn(),
    };
    const engine = new TransportFallbackEngine({
      mode: TRANSPORT_MODE.P2P_ONLY,
      p2pTimeoutMs: 15,
      coordinator,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: {
        P2P: { deviceAddress: 'AA:BB:CC:DD:EE:01' },
      },
    };

    await expect(engine.connect(peer)).rejects.toThrow(/Wi-Fi Direct/);
    expect(coordinator.cancelConnecting).toHaveBeenCalledTimes(1);
  });

  test('explicit compatibility handler still takes precedence during migration', async () => {
    const coordinator = {
      connectLanPeer: jest.fn(),
      connectP2pPeer: jest.fn().mockResolvedValue({ coordinator: true }),
      cancelConnecting: jest.fn(),
    };
    const engine = new TransportFallbackEngine({
      mode: TRANSPORT_MODE.P2P_ONLY,
      coordinator,
    });
    const connectP2p = jest.fn().mockResolvedValue({ legacy: true });
    const peer = {
      deviceId: 'peer-device',
      transports: {
        P2P: { deviceAddress: 'AA:BB:CC:DD:EE:02' },
      },
    };

    await expect(engine.connect(peer, { connectP2p })).resolves.toEqual({
      transport: 'P2P',
      result: { legacy: true },
    });
    expect(connectP2p).toHaveBeenCalledWith(peer, expect.objectContaining({
      attemptToken: expect.objectContaining({ peerId: peer.deviceId }),
      isCancelled: expect.any(Function),
    }));
    expect(coordinator.connectP2pPeer).not.toHaveBeenCalled();
  });
});
