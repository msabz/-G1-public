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

  test('propagates explicit cancellation into P2P preparation before a late connect starts', async () => {
    let releasePreparation;
    let p2pContext = null;
    const preparation = new Promise(resolve => { releasePreparation = resolve; });
    const connectP2p = jest.fn(async (_peer, attemptContext) => {
      p2pContext = attemptContext;
      await preparation;
      attemptContext.throwIfCancelled();
      return { success: true };
    });
    const connectBluetooth = jest.fn().mockResolvedValue({ success: true });
    const cancelP2p = jest.fn();
    const peer = {
      deviceId: 'dev-cancel-p2p-preparation',
      transports: {
        P2P: { deviceAddress: '02:00:00:00:00:97' },
        BLUETOOTH: { address: 'AA:BB:CC:DD:EE:97' },
      },
    };

    const pending = engine.connect(peer, { connectP2p, cancelP2p, connectBluetooth });
    await Promise.resolve();
    await Promise.resolve();
    expect(connectP2p).toHaveBeenCalledTimes(1);

    expect(engine.cancel(peer.deviceId, 'user stopped selection')).toBe(true);
    expect(p2pContext.isCancelled()).toBe(true);
    releasePreparation();

    await expect(pending).rejects.toThrow('user stopped selection');
    expect(cancelP2p).toHaveBeenCalledTimes(1);
    expect(connectBluetooth).not.toHaveBeenCalled();
  });

  test('observes a rejected async cleanup during explicit cancellation', async () => {
    let releasePreparation;
    const preparation = new Promise(resolve => { releasePreparation = resolve; });
    const connectP2p = jest.fn(async (_peer, attemptContext) => {
      await preparation;
      attemptContext.throwIfCancelled();
      return { success: true };
    });
    const cleanupError = new Error('native cancellation cleanup failed');
    const cancelP2p = jest.fn().mockRejectedValue(cleanupError);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const peer = {
      deviceId: 'dev-cancel-rejected-cleanup',
      transports: {
        P2P: { deviceAddress: '02:00:00:00:00:93' },
      },
    };

    const pending = engine.connect(peer, { connectP2p, cancelP2p });
    await Promise.resolve();
    await Promise.resolve();
    expect(connectP2p).toHaveBeenCalledTimes(1);

    expect(engine.cancel(peer.deviceId, 'user cancelled')).toBe(true);
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(
      '[FallbackEngine] explicit cancellation cleanup failed:',
      cleanupError.message,
    );

    releasePreparation();
    await expect(pending).rejects.toThrow('user cancelled');
    expect(cancelP2p).toHaveBeenCalledTimes(1);
  });

  test('invalidates timed-out P2P preparation before advancing to Bluetooth', async () => {
    engine = new TransportFallbackEngine({ p2pTimeoutMs: 15, bluetoothTimeoutMs: 1000 });
    let releasePreparation;
    let releaseBluetooth;
    const preparation = new Promise(resolve => { releasePreparation = resolve; });
    const bluetooth = new Promise(resolve => { releaseBluetooth = resolve; });
    let lateP2pSideEffect = false;
    const connectP2p = jest.fn(async (_peer, attemptContext) => {
      await preparation;
      attemptContext.throwIfCancelled();
      lateP2pSideEffect = true;
      return { success: true };
    });
    const connectBluetooth = jest.fn(() => bluetooth);
    const peer = {
      deviceId: 'dev-timeout-preparation',
      transports: {
        P2P: { deviceAddress: '02:00:00:00:00:96' },
        BLUETOOTH: { address: 'AA:BB:CC:DD:EE:96' },
      },
    };

    const pending = engine.connect(peer, { connectP2p, connectBluetooth });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(connectBluetooth).toHaveBeenCalledTimes(1);

    releasePreparation();
    await Promise.resolve();
    await Promise.resolve();
    expect(lateP2pSideEffect).toBe(false);

    releaseBluetooth({ success: true });
    await expect(pending).resolves.toMatchObject({ transport: 'BLUETOOTH' });
  });

  test('invalidates a failed step context before the next transport starts', async () => {
    let p2pContext = null;
    let bluetoothContext = null;
    const connectP2p = jest.fn((_peer, attemptContext) => {
      p2pContext = attemptContext;
      return Promise.reject(new Error('P2P route failed'));
    });
    const connectBluetooth = jest.fn((_peer, attemptContext) => {
      bluetoothContext = attemptContext;
      expect(p2pContext.isCancelled()).toBe(true);
      expect(attemptContext.isCancelled()).toBe(false);
      return Promise.resolve({ success: true });
    });
    const peer = {
      deviceId: 'dev-step-invalidation',
      transports: {
        P2P: { deviceAddress: '02:00:00:00:00:95' },
        BLUETOOTH: { address: 'AA:BB:CC:DD:EE:95' },
      },
    };

    await expect(engine.connect(peer, { connectP2p, connectBluetooth }))
      .resolves.toMatchObject({ transport: 'BLUETOOTH' });

    expect(p2pContext.isCancelled()).toBe(true);
    // The winning context is invalid once the selection record has completed;
    // no caller may reuse it to mutate transport state after connect() settles.
    expect(bluetoothContext.isCancelled()).toBe(true);
  });

  test('ignores a timed-out step late success while the current fallback step is pending', async () => {
    engine = new TransportFallbackEngine({ p2pTimeoutMs: 15, bluetoothTimeoutMs: 1000 });
    let resolveP2p;
    let resolveBluetooth;
    let p2pContext = null;
    let bluetoothContext = null;
    const lateP2p = new Promise(resolve => { resolveP2p = resolve; });
    const bluetooth = new Promise(resolve => { resolveBluetooth = resolve; });
    const connectP2p = jest.fn((_peer, attemptContext) => {
      p2pContext = attemptContext;
      return lateP2p;
    });
    const connectBluetooth = jest.fn((_peer, attemptContext) => {
      bluetoothContext = attemptContext;
      return bluetooth;
    });
    const onFallbackStep = jest.fn();
    const peer = {
      deviceId: 'dev-late-p2p-success',
      transports: {
        P2P: { deviceAddress: '02:00:00:00:00:94' },
        BLUETOOTH: { address: 'AA:BB:CC:DD:EE:94' },
      },
    };

    const pending = engine.connect(peer, {
      connectP2p,
      connectBluetooth,
      onFallbackStep,
    });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(connectBluetooth).toHaveBeenCalledTimes(1);
    expect(p2pContext.isCancelled()).toBe(true);
    expect(bluetoothContext.isCancelled()).toBe(false);
    expect(engine.getStatus().pendingAttempt).toEqual(expect.objectContaining({
      transport: 'BLUETOOTH',
    }));

    resolveP2p({ success: true, route: 'late-p2p' });
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.getStatus().pendingAttempt).toEqual(expect.objectContaining({
      transport: 'BLUETOOTH',
    }));
    expect(onFallbackStep.mock.calls.map(([transport]) => transport))
      .toEqual(['P2P', 'BLUETOOTH']);

    resolveBluetooth({ success: true, route: 'bluetooth' });
    await expect(pending).resolves.toEqual({
      transport: 'BLUETOOTH',
      result: { success: true, route: 'bluetooth' },
    });
  });

  test('timeout helper rejects with transport-specific diagnostics', async () => {
    jest.useFakeTimers();
    const pending = runWithTransportTimeout(() => new Promise(() => {}), 25, 'LAN');
    jest.advanceTimersByTime(26);
    await expect(pending).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  test('observes a rejected async timeout cancellation without replacing the timeout error', async () => {
    jest.useFakeTimers();
    const cancellationError = new Error('native cleanup rejected');
    const cancel = jest.fn(() => Promise.reject(cancellationError));
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = runWithTransportTimeout(
      () => new Promise(() => {}),
      25,
      'Bluetooth',
      cancel,
    );

    jest.advanceTimersByTime(26);
    await expect(pending).rejects.toMatchObject({
      name: 'TransportTimeoutError',
      transport: 'Bluetooth',
    });
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      '[FallbackEngine] Bluetooth timeout cancellation failed:',
      'native cleanup rejected',
    );
  });
});
