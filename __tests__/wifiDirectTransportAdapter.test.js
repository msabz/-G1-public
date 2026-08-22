jest.mock('react-native', () => ({
  NativeModules: {},
  NativeEventEmitter: jest.fn(),
}));

import { PeerRegistry, TRANSPORTS } from '../src/network/PeerRegistry';
import {
  WifiDirectTransportAdapter,
  WIFI_DIRECT_ADAPTER_STATE,
} from '../src/network/WifiDirectTransportAdapter';

function makeEmitter() {
  const listeners = new Map();
  return {
    addListener: jest.fn((event, callback) => {
      const current = listeners.get(event) || new Set();
      current.add(callback);
      listeners.set(event, current);
      return {
        remove: () => current.delete(callback),
      };
    }),
    emit(event, payload) {
      [...(listeners.get(event) || [])].forEach(callback => callback(payload));
    },
  };
}

function makeNative(overrides = {}) {
  return {
    connectToPeer: jest.fn().mockResolvedValue({ started: true, connectionEpoch: 9 }),
    getConnectionInfo: jest.fn().mockResolvedValue({
      groupFormed: true,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 7,
    }),
    bindToWifiDirectNetwork: jest.fn().mockResolvedValue(true),
    stopServiceDiscovery: jest.fn().mockResolvedValue(true),
    cleanupConnection: jest.fn().mockResolvedValue({ clean: true }),
    unbindNetwork: jest.fn().mockResolvedValue(true),
    startAdvertising: jest.fn().mockResolvedValue(true),
    startPassiveListening: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('WifiDirectTransportAdapter', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('does not turn a raw P2P MAC/address into stable G1 identity', () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    const emitter = makeEmitter();
    const adapter = new WifiDirectTransportAdapter({
      nativeModule: makeNative(),
      emitter,
      registry,
    });
    adapter.startObserving();

    emitter.emit('PEERS_UPDATED', {
      peers: [{
        deviceAddress: 'AA:BB:CC:DD:EE:FF',
        deviceName: 'Unknown phone',
        status: 3,
      }],
    });

    expect(registry.getAllPeers()).toHaveLength(0);
  });

  test('merges DNS-SD stable identity with current Wi-Fi Direct route', () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    const emitter = makeEmitter();
    const adapter = new WifiDirectTransportAdapter({
      nativeModule: makeNative(),
      emitter,
      registry,
    });
    adapter.startObserving();

    emitter.emit('MUSAB_PEER_FOUND', {
      peerId: 'peer-device',
      deviceAddress: 'AA:BB:CC:DD:EE:FF',
      deviceName: 'Peer phone',
      status: 3,
    });
    emitter.emit('PEERS_UPDATED', {
      peers: [{
        deviceAddress: 'AA:BB:CC:DD:EE:FF',
        deviceName: 'Peer phone current',
        status: 3,
      }],
    });

    const peer = registry.getPeer('peer-device');
    expect(peer).not.toBeNull();
    expect(peer.transports[TRANSPORTS.P2P]).toEqual(expect.objectContaining({
      deviceAddress: 'AA:BB:CC:DD:EE:FF',
      isReachable: true,
      stale: false,
    }));
    expect(peer.deviceName).toBe('Peer phone current');
  });

  test('owns group negotiation and bind, returning a prepared client route', async () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    const emitter = makeEmitter();
    const nativeModule = makeNative();
    const adapter = new WifiDirectTransportAdapter({
      nativeModule,
      emitter,
      registry,
      connectTimeoutMs: 5000,
    });
    const peer = {
      deviceId: 'peer-device',
      deviceName: 'Peer phone',
      transports: {
        P2P: { deviceAddress: 'AA:BB:CC:DD:EE:FF' },
      },
    };

    const attempt = adapter.connectPeer(peer, { timeoutMs: 5000 });
    await flushMicrotasks();
    expect(nativeModule.connectToPeer).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF');
    expect(adapter.getStatus().state).toBe(WIFI_DIRECT_ADAPTER_STATE.CONNECTING);

    emitter.emit('PEER_CONNECTED', {
      groupFormed: true,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 9,
      interfaceName: 'p2p-wlan0-0',
    });

    const route = await attempt;
    expect(nativeModule.bindToWifiDirectNetwork).toHaveBeenCalledTimes(1);
    expect(route).toEqual(expect.objectContaining({
      transport: TRANSPORTS.P2P,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 9,
      bound: true,
    }));
    expect(adapter.getStatus().state).toBe(WIFI_DIRECT_ADAPTER_STATE.READY);
    expect(registry.getPeer('peer-device').transports.P2P).toEqual(expect.objectContaining({
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 9,
      isReachable: true,
    }));
  });

  test('ignores a stale disconnect while native negotiation is still being prepared', async () => {
    const stopServiceDiscovery = deferred();
    const emitter = makeEmitter();
    const nativeModule = makeNative({
      stopServiceDiscovery: jest.fn(() => stopServiceDiscovery.promise),
    });
    const adapter = new WifiDirectTransportAdapter({
      nativeModule,
      emitter,
      registry: new PeerRegistry({ myDeviceId: 'self' }),
    });
    const peer = {
      deviceId: 'peer-device',
      deviceName: 'Peer phone',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };

    const attempt = adapter.connectPeer(peer, { timeoutMs: 5000 });
    const outcome = attempt.then(value => ({ value }), error => ({ error }));
    await flushMicrotasks();
    expect(nativeModule.connectToPeer).not.toHaveBeenCalled();

    // Samsung can deliver the final groupFormed=false broadcast from cleanup
    // after the next JS attempt exists but before native connectToPeer starts.
    emitter.emit('PEER_DISCONNECTED', {});
    expect(adapter.getStatus().state).toBe(WIFI_DIRECT_ADAPTER_STATE.CONNECTING);
    emitter.emit('PEER_CONNECTED', {
      groupFormed: true,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 8,
    });
    expect(nativeModule.bindToWifiDirectNetwork).not.toHaveBeenCalled();

    stopServiceDiscovery.resolve(true);
    await flushMicrotasks();
    expect(nativeModule.connectToPeer).toHaveBeenCalledWith('11:22:33:44:55:66');
    emitter.emit('PEER_CONNECTED', {
      groupFormed: true,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 9,
    });

    const result = await outcome;
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(expect.objectContaining({
      transport: TRANSPORTS.P2P,
      connectionEpoch: 9,
    }));
  });

  test('ignores a queued PEER_CONNECTED event from an obsolete native epoch', async () => {
    const emitter = makeEmitter();
    const nativeModule = makeNative();
    const adapter = new WifiDirectTransportAdapter({
      nativeModule,
      emitter,
      registry: new PeerRegistry({ myDeviceId: 'self' }),
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };

    let settled = false;
    const attempt = adapter.connectPeer(peer, { timeoutMs: 5000 });
    attempt.finally(() => { settled = true; }).catch(() => {});
    await flushMicrotasks();

    emitter.emit('PEER_CONNECTED', {
      groupFormed: true,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 8,
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(nativeModule.bindToWifiDirectNetwork).not.toHaveBeenCalled();
    expect(adapter.getStatus().state).toBe(WIFI_DIRECT_ADAPTER_STATE.CONNECTING);

    emitter.emit('PEER_CONNECTED', {
      groupFormed: true,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 9,
    });

    await expect(attempt).resolves.toEqual(expect.objectContaining({
      connectionEpoch: 9,
    }));
  });

  test('preserves the attempt epoch across delayed owner lookup and rejects stale disconnects', async () => {
    const ownerInfo = deferred();
    const emitter = makeEmitter();
    const nativeModule = makeNative({
      getConnectionInfo: jest.fn(() => ownerInfo.promise),
    });
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    const adapter = new WifiDirectTransportAdapter({
      nativeModule,
      emitter,
      registry,
      delay: jest.fn().mockResolvedValue(undefined),
    });
    const peer = {
      deviceId: 'peer-device',
      deviceName: 'Peer phone',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };

    const attempt = adapter.connectPeer(peer, { timeoutMs: 5000 });
    await flushMicrotasks();
    emitter.emit('PEER_CONNECTED', {
      groupFormed: true,
      isGroupOwner: false,
      groupOwnerAddress: null,
      connectionEpoch: 9,
    });
    await flushMicrotasks();

    expect(nativeModule.getConnectionInfo).toHaveBeenCalledTimes(1);
    emitter.emit('PEER_DISCONNECTED', { connectionEpoch: 8 });
    expect(adapter.getStatus().state).toBe(WIFI_DIRECT_ADAPTER_STATE.CONNECTING);

    // Android's requestConnectionInfo callback contains the owner address but
    // no JS/native connectionEpoch. The adapter must retain attempt epoch 9.
    ownerInfo.resolve({
      groupFormed: true,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
    });

    await expect(attempt).resolves.toEqual(expect.objectContaining({
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 9,
    }));
    expect(adapter.getStatus()).toEqual(expect.objectContaining({
      state: WIFI_DIRECT_ADAPTER_STATE.READY,
      activePeerId: 'peer-device',
      activeRoute: expect.objectContaining({ connectionEpoch: 9 }),
    }));

    emitter.emit('PEER_DISCONNECTED', { connectionEpoch: 8 });
    expect(adapter.getStatus()).toEqual(expect.objectContaining({
      state: WIFI_DIRECT_ADAPTER_STATE.READY,
      activePeerId: 'peer-device',
      activeRoute: expect.objectContaining({ connectionEpoch: 9 }),
    }));
    expect(registry.getPeer('peer-device').transports.P2P.stale).toBe(false);

    emitter.emit('PEER_DISCONNECTED', { connectionEpoch: 9 });
    expect(adapter.getStatus()).toEqual(expect.objectContaining({
      state: WIFI_DIRECT_ADAPTER_STATE.IDLE,
      activePeerId: null,
      activeRoute: null,
    }));
  });

  test('cancel during owner lookup prevents a late result from rebinding the process', async () => {
    const ownerInfo = deferred();
    const emitter = makeEmitter();
    const nativeModule = makeNative({
      getConnectionInfo: jest.fn(() => ownerInfo.promise),
    });
    const adapter = new WifiDirectTransportAdapter({
      nativeModule,
      emitter,
      registry: new PeerRegistry({ myDeviceId: 'self' }),
      delay: jest.fn().mockResolvedValue(undefined),
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };

    const attempt = adapter.connectPeer(peer, { timeoutMs: 5000 });
    await flushMicrotasks();
    emitter.emit('PEER_CONNECTED', {
      groupFormed: true,
      isGroupOwner: false,
      groupOwnerAddress: null,
      connectionEpoch: 9,
    });
    await flushMicrotasks();
    expect(nativeModule.getConnectionInfo).toHaveBeenCalledTimes(1);

    await adapter.cancelConnect('cancel during owner lookup');
    await expect(attempt).rejects.toThrow('cancel during owner lookup');
    expect(nativeModule.bindToWifiDirectNetwork).not.toHaveBeenCalled();

    ownerInfo.resolve({
      groupFormed: true,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
    });
    await flushMicrotasks();

    expect(nativeModule.bindToWifiDirectNetwork).not.toHaveBeenCalled();
    expect(nativeModule.unbindNetwork).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus()).toEqual(expect.objectContaining({
      state: WIFI_DIRECT_ADAPTER_STATE.IDLE,
      activePeerId: null,
      activeRoute: null,
    }));
  });

  test('undoes a native bind that resolves after its pending activation was cancelled', async () => {
    const bindResult = deferred();
    const emitter = makeEmitter();
    const nativeModule = makeNative({
      bindToWifiDirectNetwork: jest.fn(() => bindResult.promise),
    });
    const adapter = new WifiDirectTransportAdapter({
      nativeModule,
      emitter,
      registry: new PeerRegistry({ myDeviceId: 'self' }),
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };

    const attempt = adapter.connectPeer(peer, { timeoutMs: 5000 });
    await flushMicrotasks();
    emitter.emit('PEER_CONNECTED', {
      groupFormed: true,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 9,
    });
    await flushMicrotasks();
    expect(nativeModule.bindToWifiDirectNetwork).toHaveBeenCalledTimes(1);

    await adapter.cancelConnect('cancel during native bind');
    await expect(attempt).rejects.toThrow('cancel during native bind');
    expect(nativeModule.unbindNetwork).toHaveBeenCalledTimes(1);

    bindResult.resolve(true);
    await flushMicrotasks();

    expect(nativeModule.unbindNetwork).toHaveBeenCalledTimes(2);
    expect(adapter.getStatus()).toEqual(expect.objectContaining({
      state: WIFI_DIRECT_ADAPTER_STATE.IDLE,
      activePeerId: null,
      activeRoute: null,
    }));
  });

  test('rejects immediately when Android invalidated the native attempt before callback delivery', async () => {
    const nativeModule = makeNative({
      connectToPeer: jest.fn().mockResolvedValue({ started: false, connectionEpoch: 8 }),
    });
    const adapter = new WifiDirectTransportAdapter({
      nativeModule,
      emitter: makeEmitter(),
      registry: new PeerRegistry({ myDeviceId: 'self' }),
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };

    await expect(adapter.connectPeer(peer, { timeoutMs: 5000 })).rejects.toThrow(
      'invalidated the Wi-Fi Direct connection attempt'
    );
    expect(adapter.getStatus().state).toBe(WIFI_DIRECT_ADAPTER_STATE.ERROR);
  });

  test.each([
    ['service-discovery cleanup', {
      stopServiceDiscovery: jest.fn(() => new Promise(() => {})),
    }, false],
    ['native connect action', {
      connectToPeer: jest.fn(() => new Promise(() => {})),
    }, true],
  ])('enforces its deadline while %s never invokes the Android callback', async (
    _stage,
    nativeOverrides,
    expectNativeConnect
  ) => {
    jest.useFakeTimers();
    const nativeModule = makeNative(nativeOverrides);
    const adapter = new WifiDirectTransportAdapter({
      nativeModule,
      emitter: makeEmitter(),
      registry: new PeerRegistry({ myDeviceId: 'self' }),
    });
    const peer = {
      deviceId: 'peer-timeout',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:88' } },
    };

    const attempt = adapter.connectPeer(peer, { timeoutMs: 25 });
    const outcome = attempt.then(value => ({ value }), error => ({ error }));
    await flushMicrotasks();
    expect(nativeModule.connectToPeer).toHaveBeenCalledTimes(expectNativeConnect ? 1 : 0);

    jest.advanceTimersByTime(26);
    const result = await outcome;
    await flushMicrotasks();

    expect(result.error).toEqual(expect.objectContaining({
      message: expect.stringContaining('timed out after 25ms'),
    }));
    expect(nativeModule.cleanupConnection).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus().state).toBe(WIFI_DIRECT_ADAPTER_STATE.IDLE);
  });

  test('group owner route does not invent a group-owner IP', async () => {
    const emitter = makeEmitter();
    const nativeModule = makeNative();
    const adapter = new WifiDirectTransportAdapter({
      nativeModule,
      emitter,
      registry: new PeerRegistry({ myDeviceId: 'self' }),
    });
    const peer = {
      deviceId: 'peer-device',
      deviceName: 'Peer phone',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };

    const attempt = adapter.connectPeer(peer);
    await flushMicrotasks();
    emitter.emit('PEER_CONNECTED', {
      groupFormed: true,
      isGroupOwner: true,
      groupOwnerAddress: null,
      connectionEpoch: 9,
    });

    await expect(attempt).resolves.toEqual(expect.objectContaining({
      isGroupOwner: true,
      groupOwnerAddress: null,
    }));
  });

  test('cancelConnect rejects the pending route and cleans native group/bind state', async () => {
    const emitter = makeEmitter();
    const nativeModule = makeNative();
    const adapter = new WifiDirectTransportAdapter({
      nativeModule,
      emitter,
      registry: new PeerRegistry({ myDeviceId: 'self' }),
    });
    adapter.setIdentity({ deviceId: 'self', deviceName: 'Self phone' });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };

    const attempt = adapter.connectPeer(peer, { timeoutMs: 5000 });
    await flushMicrotasks();
    await adapter.cancelConnect('cancelled by test');

    await expect(attempt).rejects.toThrow('cancelled by test');
    expect(nativeModule.cleanupConnection).toHaveBeenCalledTimes(1);
    expect(nativeModule.unbindNetwork).toHaveBeenCalledTimes(1);
    expect(nativeModule.startAdvertising).toHaveBeenCalledWith('Self phone', 'self');
    expect(nativeModule.startPassiveListening).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus().state).toBe(WIFI_DIRECT_ADAPTER_STATE.IDLE);
  });

  test('serializes a retry behind cancellation cleanup and isolates the old attempt', async () => {
    const firstPreparation = deferred();
    const cleanup = deferred();
    const emitter = makeEmitter();
    const nativeModule = makeNative({
      stopServiceDiscovery: jest.fn()
        .mockImplementationOnce(() => firstPreparation.promise)
        .mockResolvedValue(true),
      cleanupConnection: jest.fn(() => cleanup.promise),
    });
    const adapter = new WifiDirectTransportAdapter({
      nativeModule,
      emitter,
      registry: new PeerRegistry({ myDeviceId: 'self' }),
    });
    const firstPeer = {
      deviceId: 'first-peer',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };
    const secondPeer = {
      deviceId: 'second-peer',
      transports: { P2P: { deviceAddress: '22:33:44:55:66:77' } },
    };

    const firstAttempt = adapter.connectPeer(firstPeer, { timeoutMs: 5000 });
    const firstOutcome = firstAttempt.then(value => ({ value }), error => ({ error }));
    await flushMicrotasks();

    const cancellation = adapter.cancelConnect('replace first attempt');
    const secondAttempt = adapter.connectPeer(secondPeer, { timeoutMs: 5000 });
    const secondOutcome = secondAttempt.then(value => ({ value }), error => ({ error }));
    await flushMicrotasks();

    expect(adapter.getStatus().state).toBe(WIFI_DIRECT_ADAPTER_STATE.DISCONNECTING);
    expect(nativeModule.connectToPeer).not.toHaveBeenCalled();

    // Finishing preparation for the obsolete attempt must not settle or start
    // the retry while native cleanup is still in progress.
    firstPreparation.resolve(true);
    await flushMicrotasks();
    expect(nativeModule.connectToPeer).not.toHaveBeenCalled();

    cleanup.resolve({ clean: true });
    await cancellation;
    await flushMicrotasks();
    expect(nativeModule.connectToPeer).toHaveBeenCalledTimes(1);
    expect(nativeModule.connectToPeer).toHaveBeenCalledWith('22:33:44:55:66:77');

    emitter.emit('PEER_CONNECTED', {
      groupFormed: true,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 9,
    });

    const firstResult = await firstOutcome;
    const secondResult = await secondOutcome;
    expect(firstResult.error).toEqual(expect.objectContaining({ message: 'replace first attempt' }));
    expect(secondResult.error).toBeUndefined();
    expect(secondResult.value).toEqual(expect.objectContaining({
      transport: TRANSPORTS.P2P,
      connectionEpoch: 9,
    }));
    expect(adapter.getStatus().state).toBe(WIFI_DIRECT_ADAPTER_STATE.READY);
  });

  test('disconnect restores advertised/passive availability only after clean cleanup', async () => {
    const nativeModule = makeNative();
    const adapter = new WifiDirectTransportAdapter({
      nativeModule,
      emitter: makeEmitter(),
      registry: new PeerRegistry({ myDeviceId: 'self' }),
    });
    adapter.setIdentity({ deviceId: 'self', deviceName: 'Self phone' });

    const result = await adapter.disconnect();

    expect(result).toEqual({ clean: true });
    expect(nativeModule.cleanupConnection).toHaveBeenCalledTimes(1);
    expect(nativeModule.unbindNetwork).toHaveBeenCalledTimes(1);
    expect(nativeModule.startAdvertising).toHaveBeenCalledWith('Self phone', 'self');
    expect(nativeModule.startPassiveListening).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus().state).toBe(WIFI_DIRECT_ADAPTER_STATE.IDLE);
  });
});
