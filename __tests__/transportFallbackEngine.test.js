jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import {
  TransportFallbackEngine,
  TransportTimeoutError,
  TRANSPORT_MODE,
  runWithTransportTimeout,
} from '../src/network/TransportFallbackEngine';
import { connectionCoordinator } from '../src/network/ConnectionCoordinator';

describe('TransportFallbackEngine', () => {
  let engine;

  beforeEach(() => {
    jest.clearAllMocks();
    engine = new TransportFallbackEngine();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('connects via LAN first when available', async () => {
    const mockSession = { sendMessage: jest.fn() };
    jest.spyOn(connectionCoordinator, 'connectLanPeer').mockResolvedValue(mockSession);

    const peer = {
      deviceId: 'dev-1',
      transports: {
        LAN: { host: '192.168.1.10', port: 8089 },
        P2P: { deviceAddress: '02:00:00:00:00:01' },
      },
    };

    const connectP2p = jest.fn();
    const result = await engine.connect(peer, { connectP2p });

    expect(result.transport).toBe('LAN');
    expect(connectionCoordinator.connectLanPeer).toHaveBeenCalledTimes(1);
    expect(connectP2p).not.toHaveBeenCalled();
  });

  test('accepts per-selection transport deadlines', async () => {
    const session = { id: 'custom-timeout-session' };
    jest.spyOn(connectionCoordinator, 'connectLanPeer').mockResolvedValue(session);
    const peer = {
      deviceId: 'dev-custom-timeout',
      transports: { LAN: { host: '192.168.1.44', port: 8089 } },
    };

    await expect(engine.connect(peer, {}, { lanTimeoutMs: 12_345 }))
      .resolves.toMatchObject({ transport: 'LAN', session });
    expect(connectionCoordinator.connectLanPeer).toHaveBeenCalledWith(peer, 12_345);
  });

  test('falls back to P2P when LAN connection fails', async () => {
    jest.spyOn(connectionCoordinator, 'connectLanPeer').mockRejectedValue(new Error('LAN timeout'));

    const peer = {
      deviceId: 'dev-2',
      transports: {
        LAN: { host: '192.168.1.11', port: 8089 },
        P2P: { deviceAddress: '02:00:00:00:00:02' },
      },
    };

    const connectP2p = jest.fn().mockResolvedValue({ success: true });
    const result = await engine.connect(peer, { connectP2p });

    expect(result.transport).toBe('P2P');
    expect(connectionCoordinator.connectLanPeer).toHaveBeenCalledTimes(1);
    expect(connectP2p).toHaveBeenCalledTimes(1);
  });

  test('falls back to Bluetooth when both LAN and P2P fail', async () => {
    jest.spyOn(connectionCoordinator, 'connectLanPeer').mockRejectedValue(new Error('LAN timeout'));
    const connectP2p = jest.fn().mockRejectedValue(new Error('P2P failed'));
    const connectBluetooth = jest.fn().mockResolvedValue({ success: true });

    const peer = {
      deviceId: 'dev-3',
      transports: {
        LAN: { host: '192.168.1.12', port: 8089 },
        P2P: { deviceAddress: '02:00:00:00:00:03' },
        BLUETOOTH: { address: 'AA:BB:CC:DD:EE:FF' },
      },
    };

    const result = await engine.connect(peer, { connectP2p, connectBluetooth });
    expect(result.transport).toBe('BLUETOOTH');
    expect(connectBluetooth).toHaveBeenCalledTimes(1);
  });

  test('respects LAN_ONLY mode override', async () => {
    engine.setMode(TRANSPORT_MODE.LAN_ONLY);
    jest.spyOn(connectionCoordinator, 'connectLanPeer').mockRejectedValue(new Error('LAN rejected'));

    const peer = {
      deviceId: 'dev-4',
      transports: {
        LAN: { host: '192.168.1.13' },
        P2P: { deviceAddress: '02:00:00:00:00:04' },
      },
    };

    const connectP2p = jest.fn().mockResolvedValue(true);
    await expect(engine.connect(peer, { connectP2p })).rejects.toThrow(/LAN/);
    expect(connectP2p).not.toHaveBeenCalled();
  });

  test('times out a hung LAN attempt, cancels it, and continues AUTO with P2P', async () => {
    jest.useFakeTimers();
    engine = new TransportFallbackEngine({ lanTimeoutMs: 50, p2pTimeoutMs: 1000 });
    jest.spyOn(connectionCoordinator, 'connectLanPeer').mockImplementation(() => new Promise(() => {}));
    const cancelLan = jest.spyOn(connectionCoordinator, 'cancelConnecting').mockImplementation(() => {});
    const connectP2p = jest.fn().mockResolvedValue({ success: true });
    const peer = {
      deviceId: 'dev-timeout-lan',
      transports: {
        LAN: { host: '192.168.1.99' },
        P2P: { deviceAddress: '02:00:00:00:00:99' },
      },
    };

    const pending = engine.connect(peer, { connectP2p });
    await Promise.resolve();
    jest.advanceTimersByTime(51);
    await Promise.resolve();
    await Promise.resolve();

    await expect(pending).resolves.toMatchObject({ transport: 'P2P' });
    expect(cancelLan).toHaveBeenCalledTimes(1);
    expect(connectP2p).toHaveBeenCalledTimes(1);
  });

  test('times out a hung P2P attempt, invokes its cancel hook, and continues with Bluetooth', async () => {
    // Use a tiny real deadline here. Fake timers are intentionally avoided
    // because the P2P attempt is scheduled after the LAN rejection microtask,
    // which made the old test dependent on Jest timer/microtask ordering.
    engine = new TransportFallbackEngine({ lanTimeoutMs: 50, p2pTimeoutMs: 20, bluetoothTimeoutMs: 1000 });
    jest.spyOn(connectionCoordinator, 'connectLanPeer').mockRejectedValue(new Error('LAN unavailable'));
    const connectP2p = jest.fn(() => new Promise(() => {}));
    const cancelP2p = jest.fn();
    const connectBluetooth = jest.fn().mockResolvedValue({ success: true });
    const peer = {
      deviceId: 'dev-timeout-p2p',
      transports: {
        LAN: { host: '192.168.1.98' },
        P2P: { deviceAddress: '02:00:00:00:00:98' },
        BLUETOOTH: { address: 'AA:BB:CC:DD:EE:98' },
      },
    };

    await expect(engine.connect(peer, { connectP2p, cancelP2p, connectBluetooth }))
      .resolves.toMatchObject({ transport: 'BLUETOOTH' });
    expect(cancelP2p).toHaveBeenCalledTimes(1);
    expect(connectBluetooth).toHaveBeenCalledTimes(1);
  });

  test('timeout helper rejects with transport-specific diagnostics', async () => {
    jest.useFakeTimers();
    const pending = runWithTransportTimeout(() => new Promise(() => {}), 25, 'LAN');
    jest.advanceTimersByTime(26);
    await expect(pending).rejects.toBeInstanceOf(TransportTimeoutError);
  });
});
