jest.mock('react-native', () => ({
  NativeModules: {},
  NativeEventEmitter: jest.fn(),
}));
jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import {
  BLUETOOTH_TRANSPORT_EVENT,
  BLUETOOTH_TRANSPORT_STATE,
  BluetoothTransportAdapter,
  createBluetoothFallbackHooks,
} from '../src/bluetooth/BluetoothTransportAdapter';
import { TransportFallbackEngine } from '../src/network/TransportFallbackEngine';

function makeEmitter() {
  const listeners = new Map();
  return {
    addListener: jest.fn((event, callback) => {
      const callbacks = listeners.get(event) || new Set();
      callbacks.add(callback);
      listeners.set(event, callbacks);
      return { remove: () => callbacks.delete(callback) };
    }),
    emit(event, payload) {
      [...(listeners.get(event) || [])].forEach(callback => callback(payload));
    },
  };
}

function makeNative(overrides = {}) {
  return {
    startListening: jest.fn().mockResolvedValue(true),
    startDiscovery: jest.fn().mockResolvedValue(true),
    startDiscoveryWithTimeout: jest.fn().mockResolvedValue(true),
    stopDiscovery: jest.fn().mockResolvedValue(true),
    requestDiscoverable: jest.fn().mockResolvedValue(true),
    connect: jest.fn().mockResolvedValue({
      address: 'AA:BB:CC:DD:EE:FF',
      deviceName: 'Peer phone',
      remoteNodeId: 'peer',
      sessionId: 'session-1',
      protocolVersion: 1,
      security: 'AUTHENTICATED_RFCOMM',
      bonded: true,
    }),
    cancelConnect: jest.fn().mockResolvedValue(true),
    sendMessage: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeRegistry() {
  return {
    upsertBluetoothPeer: jest.fn(),
    setPeerConnected: jest.fn(),
    setPeerDisconnected: jest.fn(),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

describe('BluetoothTransportAdapter', () => {
  test('discovers paired/scanned devices through a bounded discovery seam', async () => {
    const nativeModule = makeNative();
    const emitter = makeEmitter();
    const adapter = new BluetoothTransportAdapter({ nativeModule, emitter, registry: makeRegistry() });
    const events = [];
    adapter.subscribe(event => events.push(event));

    await adapter.discover({ timeoutMs: 9000, requestDiscoverable: true, discoverableSeconds: 90 });
    emitter.emit('BT_DEVICE_FOUND', {
      address: 'aa:bb:cc:dd:ee:ff',
      name: 'Peer phone',
      bonded: true,
      source: 'BONDED',
    });
    emitter.emit('BT_DEVICE_FOUND', {
      address: 'AA:BB:CC:DD:EE:FF',
      name: 'Peer phone (scan)',
      rssi: -48,
      source: 'SCAN',
    });
    emitter.emit('BT_DISCOVERY_FINISHED', { deviceCount: 1 });

    expect(nativeModule.startListening).toHaveBeenCalledTimes(1);
    expect(nativeModule.requestDiscoverable).toHaveBeenCalledWith(90);
    expect(nativeModule.startDiscoveryWithTimeout).toHaveBeenCalledWith(9000);
    expect(adapter.getStatus().devices).toEqual([
      expect.objectContaining({
        address: 'AA:BB:CC:DD:EE:FF',
        name: 'Peer phone (scan)',
        rssi: -48,
      }),
    ]);
    expect(events.some(event => event.type === BLUETOOTH_TRANSPORT_EVENT.DISCOVERY_FINISHED)).toBe(true);
    expect(adapter.getStatus().state).toBe(BLUETOOTH_TRANSPORT_STATE.LISTENING);
  });

  test('does not start inquiry until the discoverability request is accepted', async () => {
    const discoverability = deferred();
    const nativeModule = makeNative({
      requestDiscoverable: jest.fn(() => discoverability.promise),
    });
    const adapter = new BluetoothTransportAdapter({
      nativeModule,
      emitter: makeEmitter(),
      registry: makeRegistry(),
    });

    const discovery = adapter.discover({
      timeoutMs: 9000,
      requestDiscoverable: true,
      discoverableSeconds: 120,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeModule.requestDiscoverable).toHaveBeenCalledWith(120);
    expect(nativeModule.startDiscoveryWithTimeout).not.toHaveBeenCalled();

    discoverability.resolve({ accepted: true, durationSeconds: 120 });
    await discovery;
    expect(nativeModule.startDiscoveryWithTimeout).toHaveBeenCalledWith(9000);
  });

  test('connects with authenticated RFCOMM metadata and registers only a stable supplied peer ID', async () => {
    const nativeModule = makeNative({
      connect: jest.fn().mockResolvedValue({
        address: 'AA:BB:CC:DD:EE:FF',
        deviceName: 'Peer phone',
        remoteNodeId: 'g1-peer-id',
        sessionId: 'session-1',
        protocolVersion: 1,
        security: 'AUTHENTICATED_RFCOMM',
        bonded: true,
      }),
    });
    const registry = makeRegistry();
    const adapter = new BluetoothTransportAdapter({ nativeModule, emitter: makeEmitter(), registry });
    const peer = {
      deviceId: 'g1-peer-id',
      deviceName: 'Peer phone',
      transports: { BLUETOOTH: { address: 'aa:bb:cc:dd:ee:ff' } },
    };

    const route = await adapter.connectPeer(peer, {
      maxAttempts: 2,
      connectTimeoutMs: 2500,
      maxReconnectAttempts: 3,
    });

    expect(nativeModule.connect).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF', expect.objectContaining({
      maxAttempts: 2,
      connectTimeoutMs: 2500,
      autoReconnect: true,
      maxReconnectAttempts: 3,
    }));
    expect(route).toEqual(expect.objectContaining({
      transport: 'BLUETOOTH',
      address: 'AA:BB:CC:DD:EE:FF',
      security: 'AUTHENTICATED_RFCOMM',
      sessionId: 'session-1',
      bonded: true,
    }));
    expect(registry.upsertBluetoothPeer).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'g1-peer-id',
      address: 'AA:BB:CC:DD:EE:FF',
    }));
    expect(registry.setPeerConnected).toHaveBeenCalledWith('g1-peer-id', 'BLUETOOTH');
  });

  test('disconnects and rejects when the authenticated remote node differs from the expected stable peer', async () => {
    const emitter = makeEmitter();
    const connectedResult = {
      address: 'AA:BB:CC:DD:EE:FF',
      deviceName: 'Unexpected phone',
      remoteNodeId: 'different-stable-peer',
      sessionId: 'mismatch-session',
      protocolVersion: 1,
      security: 'AUTHENTICATED_RFCOMM',
      bonded: true,
    };
    const nativeModule = makeNative({
      connect: jest.fn(() => {
        emitter.emit('BT_CONNECTED', connectedResult);
        return Promise.resolve(connectedResult);
      }),
    });
    const registry = makeRegistry();
    const adapter = new BluetoothTransportAdapter({
      nativeModule,
      emitter,
      registry,
    });
    const peer = {
      deviceId: 'expected-stable-peer',
      deviceName: 'Expected phone',
      transports: { BLUETOOTH: { address: 'AA:BB:CC:DD:EE:FF' } },
    };

    await expect(adapter.connectPeer(peer)).rejects.toMatchObject({
      code: 'BT_IDENTITY_MISMATCH',
    });

    expect(nativeModule.disconnect).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus().activeRoute).toBeNull();
    expect(registry.upsertBluetoothPeer).not.toHaveBeenCalled();
    expect(registry.setPeerConnected).not.toHaveBeenCalled();
  });

  test('adopts authenticated remoteNodeId for a provisional Bluetooth peer', async () => {
    const emitter = makeEmitter();
    const connectedResult = {
      address: 'AA:BB:CC:DD:EE:FF',
      deviceName: 'Stable phone',
      remoteNodeId: 'stable-g1-peer',
      sessionId: 'provisional-session',
      protocolVersion: 1,
      security: 'AUTHENTICATED_RFCOMM',
      bonded: true,
    };
    const nativeModule = makeNative({
      connect: jest.fn(() => {
        emitter.emit('BT_CONNECTED', connectedResult);
        return Promise.resolve(connectedResult);
      }),
    });
    const registry = makeRegistry();
    const adapter = new BluetoothTransportAdapter({
      nativeModule,
      emitter,
      registry,
    });
    const provisionalPeer = {
      deviceId: 'bluetooth:AA:BB:CC:DD:EE:FF',
      deviceName: 'Scanned phone',
      transports: { BLUETOOTH: { address: 'AA:BB:CC:DD:EE:FF' } },
    };

    const route = await adapter.connectPeer(provisionalPeer);

    expect(route).toEqual(expect.objectContaining({
      deviceId: 'stable-g1-peer',
      remoteNodeId: 'stable-g1-peer',
      peer: expect.objectContaining({ deviceId: 'stable-g1-peer' }),
    }));
    expect(provisionalPeer.deviceId).toBe('bluetooth:AA:BB:CC:DD:EE:FF');
    expect(adapter.getStatus().activePeerId).toBe('stable-g1-peer');
    expect(registry.upsertBluetoothPeer).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'stable-g1-peer',
      address: 'AA:BB:CC:DD:EE:FF',
    }));
    expect(registry.setPeerConnected).toHaveBeenCalledWith('stable-g1-peer', 'BLUETOOTH');
  });

  test('allows a bounded first-pairing confirmation window by default', async () => {
    const nativeModule = makeNative({
      connect: jest.fn().mockResolvedValue({
        address: 'AA:BB:CC:DD:EE:FF',
        deviceName: 'Peer phone',
        remoteNodeId: 'first-pair-peer',
        sessionId: 'session-1',
        protocolVersion: 1,
        security: 'AUTHENTICATED_RFCOMM',
        bonded: true,
      }),
    });
    const adapter = new BluetoothTransportAdapter({
      nativeModule,
      emitter: makeEmitter(),
      registry: makeRegistry(),
    });
    const peer = {
      deviceId: 'first-pair-peer',
      transports: { BLUETOOTH: { address: 'AA:BB:CC:DD:EE:FF' } },
    };

    await adapter.connectPeer(peer);

    expect(nativeModule.connect).toHaveBeenCalledWith(
      'AA:BB:CC:DD:EE:FF',
      expect.objectContaining({
        maxAttempts: 2,
        connectTimeoutMs: 15000,
      }),
    );
  });

  test('cancels an owned connection attempt while listener preparation is still pending', async () => {
    const listening = deferred();
    const nativeModule = makeNative({
      startListening: jest.fn(() => listening.promise),
    });
    const adapter = new BluetoothTransportAdapter({
      nativeModule,
      emitter: makeEmitter(),
      registry: makeRegistry(),
    });
    const peer = {
      deviceId: 'peer',
      transports: { BLUETOOTH: { address: 'AA:BB:CC:DD:EE:FF' } },
    };

    const connection = adapter.connectPeer(peer);
    const rejection = expect(connection).rejects.toThrow('preparation deadline');
    await Promise.resolve();

    expect(adapter.getStatus().pendingPeerId).toBe('peer');
    expect(nativeModule.connect).not.toHaveBeenCalled();
    await adapter.cancelConnect({ reason: 'preparation deadline' });

    listening.resolve(true);
    await rejection;

    expect(nativeModule.connect).not.toHaveBeenCalled();
    expect(adapter.getStatus().activeRoute).toBeNull();
    expect(adapter.getStatus().pendingPeerId).toBeNull();
    expect(adapter.getStatus().state).toBe(BLUETOOTH_TRANSPORT_STATE.LISTENING);
  });

  test('rejects and disconnects a late outbound success after cancellation', async () => {
    const nativeConnection = deferred();
    const emitter = makeEmitter();
    const nativeModule = makeNative({
      connect: jest.fn(() => nativeConnection.promise),
    });
    const registry = makeRegistry();
    const adapter = new BluetoothTransportAdapter({ nativeModule, emitter, registry });
    const events = [];
    adapter.subscribe(event => events.push(event));
    const peer = {
      deviceId: 'peer',
      transports: { BLUETOOTH: { address: 'AA:BB:CC:DD:EE:FF' } },
    };
    const connectedResult = {
      address: 'AA:BB:CC:DD:EE:FF',
      deviceName: 'Peer phone',
      remoteNodeId: 'peer',
      sessionId: 'late-session',
      protocolVersion: 1,
      security: 'AUTHENTICATED_RFCOMM',
      bonded: true,
      incoming: false,
    };

    const connection = adapter.connectPeer(peer);
    const rejection = expect(connection).rejects.toThrow('fallback deadline');
    for (let tick = 0; tick < 4 && nativeModule.connect.mock.calls.length === 0; tick += 1) {
      await Promise.resolve();
    }
    expect(nativeModule.connect).toHaveBeenCalledTimes(1);

    await adapter.cancelConnect('fallback deadline');
    emitter.emit('BT_CONNECTED', connectedResult);
    nativeConnection.resolve(connectedResult);
    await rejection;
    await Promise.resolve();

    expect(nativeModule.disconnect).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus().activeRoute).toBeNull();
    expect(adapter.getStatus().state).toBe(BLUETOOTH_TRANSPORT_STATE.LISTENING);
    expect(registry.upsertBluetoothPeer).not.toHaveBeenCalled();
    expect(registry.setPeerConnected).not.toHaveBeenCalled();
    expect(events.some(event => event.type === BLUETOOTH_TRANSPORT_EVENT.CONNECTED)).toBe(false);
  });

  test('disconnects a route accepted by the pending attempt when cancellation wins before native resolve', async () => {
    const nativeConnection = deferred();
    const emitter = makeEmitter();
    const connectedResult = {
      address: 'AA:BB:CC:DD:EE:FF',
      deviceName: 'Peer phone',
      remoteNodeId: 'peer',
      sessionId: 'accepted-before-cancel',
      protocolVersion: 1,
      security: 'AUTHENTICATED_RFCOMM',
      bonded: true,
      incoming: false,
    };
    const nativeModule = makeNative({
      connect: jest.fn(() => {
        emitter.emit('BT_CONNECTED', connectedResult);
        return nativeConnection.promise;
      }),
    });
    const registry = makeRegistry();
    const adapter = new BluetoothTransportAdapter({ nativeModule, emitter, registry });
    const peer = {
      deviceId: 'peer',
      transports: { BLUETOOTH: { address: 'AA:BB:CC:DD:EE:FF' } },
    };

    const connection = adapter.connectPeer(peer);
    const rejection = expect(connection).rejects.toThrow('fallback deadline');
    for (let tick = 0; tick < 4 && nativeModule.connect.mock.calls.length === 0; tick += 1) {
      await Promise.resolve();
    }
    expect(adapter.getStatus().activeRoute).toEqual(expect.objectContaining({
      sessionId: 'accepted-before-cancel',
    }));

    await adapter.cancelConnect('fallback deadline');

    expect(nativeModule.cancelConnect).toHaveBeenCalledTimes(1);
    expect(nativeModule.disconnect).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus().activeRoute).toBeNull();
    expect(adapter.getStatus().activePeerId).toBeNull();
    expect(adapter.getStatus().state).toBe(BLUETOOTH_TRANSPORT_STATE.LISTENING);
    expect(registry.setPeerDisconnected).toHaveBeenCalledWith('peer');

    nativeConnection.resolve(connectedResult);
    await rejection;
    expect(adapter.getStatus().activeRoute).toBeNull();
  });

  test('preserves an authenticated incoming route when cancelling the simultaneous outbound attempt', async () => {
    const nativeConnection = deferred();
    const emitter = makeEmitter();
    const nativeModule = makeNative({
      connect: jest.fn(() => nativeConnection.promise),
    });
    const registry = makeRegistry();
    const adapter = new BluetoothTransportAdapter({ nativeModule, emitter, registry });
    const peer = {
      deviceId: 'peer',
      transports: { BLUETOOTH: { address: 'AA:BB:CC:DD:EE:FF' } },
    };
    const incomingResult = {
      address: 'AA:BB:CC:DD:EE:FF',
      deviceName: 'Peer phone',
      remoteNodeId: 'peer',
      sessionId: 'incoming-wins',
      protocolVersion: 1,
      security: 'AUTHENTICATED_RFCOMM',
      bonded: true,
      incoming: true,
    };

    const connection = adapter.connectPeer(peer);
    const rejection = expect(connection).rejects.toThrow('outbound superseded');
    for (let tick = 0; tick < 4 && nativeModule.connect.mock.calls.length === 0; tick += 1) {
      await Promise.resolve();
    }
    emitter.emit('BT_CONNECTED', incomingResult);
    expect(adapter.getStatus().activeRoute).toEqual(expect.objectContaining({
      sessionId: 'incoming-wins',
    }));

    await adapter.cancelConnect('outbound superseded');
    expect(nativeModule.disconnect).not.toHaveBeenCalled();
    expect(adapter.getStatus().activeRoute).toEqual(expect.objectContaining({
      sessionId: 'incoming-wins',
    }));

    emitter.emit('BT_CONNECTED', {
      ...incomingResult,
      incoming: false,
      sessionId: 'obsolete-outbound',
    });
    await Promise.resolve();
    expect(nativeModule.disconnect).not.toHaveBeenCalled();
    expect(adapter.getStatus().activeRoute).toEqual(expect.objectContaining({
      sessionId: 'incoming-wins',
    }));

    nativeConnection.resolve(incomingResult);
    await rejection;
    expect(adapter.getStatus().state).toBe(BLUETOOTH_TRANSPORT_STATE.CONNECTED);
  });

  test('exposes two-way message and reconnect events without declaring a final disconnect', async () => {
    const emitter = makeEmitter();
    const adapter = new BluetoothTransportAdapter({
      nativeModule: makeNative(),
      emitter,
      registry: makeRegistry(),
    });
    const events = [];
    adapter.subscribe(event => events.push(event));
    adapter.startObserving();

    emitter.emit('BT_CONNECTED', {
      address: 'AA:BB:CC:DD:EE:FF',
      deviceName: 'Incoming peer',
      remoteNodeId: 'incoming-stable-peer',
      sessionId: 'incoming-session',
      security: 'AUTHENTICATED_RFCOMM',
      bonded: true,
      incoming: true,
    });
    await adapter.sendMessage('outbound');
    emitter.emit('BT_MESSAGE', { text: 'inbound', sessionId: 'incoming-session', sequence: 1 });
    emitter.emit('BT_RECONNECTING', { attempt: 1, maxAttempts: 3 });

    expect(adapter.nativeModule.sendMessage).toHaveBeenCalledWith('outbound');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: BLUETOOTH_TRANSPORT_EVENT.MESSAGE, text: 'inbound' }),
      expect.objectContaining({ type: BLUETOOTH_TRANSPORT_EVENT.RECONNECTING, attempt: 1 }),
    ]));
    expect(events.some(event => event.type === BLUETOOTH_TRANSPORT_EVENT.DISCONNECTED)).toBe(false);
    expect(adapter.getStatus().state).toBe(BLUETOOTH_TRANSPORT_STATE.RECONNECTING);
  });

  test('accepts a native auto-reconnect only for the same authenticated Bluetooth peer', () => {
    const emitter = makeEmitter();
    const nativeModule = makeNative();
    const registry = makeRegistry();
    const adapter = new BluetoothTransportAdapter({ nativeModule, emitter, registry });
    const events = [];
    adapter.subscribe(event => events.push(event));
    adapter.startObserving();

    emitter.emit('BT_CONNECTED', {
      address: 'AA:BB:CC:DD:EE:FF',
      deviceName: 'Incoming peer',
      remoteNodeId: 'stable-peer',
      sessionId: 'session-before-drop',
      security: 'AUTHENTICATED_RFCOMM',
      bonded: true,
      incoming: true,
    });
    emitter.emit('BT_RECONNECTING', { attempt: 1, maxAttempts: 3 });
    emitter.emit('BT_CONNECTED', {
      address: 'AA:BB:CC:DD:EE:FF',
      deviceName: 'Incoming peer',
      remoteNodeId: 'stable-peer',
      sessionId: 'session-after-reconnect',
      security: 'AUTHENTICATED_RFCOMM',
      bonded: true,
      incoming: false,
      reconnected: true,
    });

    expect(nativeModule.disconnect).not.toHaveBeenCalled();
    expect(adapter.getStatus()).toEqual(expect.objectContaining({
      state: BLUETOOTH_TRANSPORT_STATE.CONNECTED,
      activePeerId: 'stable-peer',
      activeRoute: expect.objectContaining({ sessionId: 'session-after-reconnect' }),
    }));
    expect(registry.setPeerConnected).toHaveBeenLastCalledWith('stable-peer', 'BLUETOOTH');
    expect(events).toContainEqual(expect.objectContaining({
      type: BLUETOOTH_TRANSPORT_EVENT.CONNECTED,
      route: expect.objectContaining({ sessionId: 'session-after-reconnect' }),
    }));
  });

  test('serializes coordinator message objects while preserving string compatibility', async () => {
    const nativeModule = makeNative();
    const emitter = makeEmitter();
    const adapter = new BluetoothTransportAdapter({ nativeModule, emitter, registry: makeRegistry() });
    const events = [];
    adapter.subscribe(event => events.push(event));
    adapter.startObserving();
    emitter.emit('BT_CONNECTED', {
      address: 'AA:BB:CC:DD:EE:FF',
      remoteNodeId: 'incoming-stable-peer',
      sessionId: 'session-1',
      security: 'AUTHENTICATED_RFCOMM',
      bonded: true,
      incoming: true,
    });

    await adapter.sendMessage({ type: 'chat', text: 'مرحبا' }, { id: 'coordinator-session' });
    await adapter.sendMessage('legacy text');
    emitter.emit('BT_MESSAGE', {
      text: JSON.stringify({ type: 'chat', text: 'reply' }),
      sessionId: 'session-1',
    });

    expect(nativeModule.sendMessage).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ type: 'chat', text: 'مرحبا' }),
    );
    expect(nativeModule.sendMessage).toHaveBeenNthCalledWith(2, 'legacy text');
    expect(events).toContainEqual(expect.objectContaining({
      type: BLUETOOTH_TRANSPORT_EVENT.MESSAGE,
      message: { type: 'chat', text: 'reply' },
    }));
  });

  test('subscribeDisconnect ignores reconnect/message events and observes final disconnect once', () => {
    const emitter = makeEmitter();
    const adapter = new BluetoothTransportAdapter({
      nativeModule: makeNative(),
      emitter,
      registry: makeRegistry(),
    });
    const observer = jest.fn();
    const unsubscribe = adapter.subscribeDisconnect(observer);
    adapter.startObserving();

    emitter.emit('BT_RECONNECTING', { attempt: 1, maxAttempts: 3 });
    emitter.emit('BT_MESSAGE', { text: 'still connected' });
    emitter.emit('BT_DISCONNECTED', { reason: 'retry-exhausted', unexpected: true });
    unsubscribe();
    emitter.emit('BT_DISCONNECTED', { reason: 'second-event', unexpected: true });

    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({
      type: BLUETOOTH_TRANSPORT_EVENT.DISCONNECTED,
      reason: 'retry-exhausted',
    }));
  });

  test('provides hooks consumed directly by TransportFallbackEngine', async () => {
    const adapter = new BluetoothTransportAdapter({
      nativeModule: makeNative(),
      emitter: makeEmitter(),
      registry: makeRegistry(),
    });
    const hooks = createBluetoothFallbackHooks(adapter);
    const peer = { deviceId: 'peer', transports: { BLUETOOTH: { address: 'AA:BB:CC:DD:EE:FF' } } };
    const engine = new TransportFallbackEngine({
      bluetoothTimeoutMs: 1000,
      coordinator: {},
    });

    await expect(engine.connect(peer, hooks)).resolves.toEqual(expect.objectContaining({
      transport: 'BLUETOOTH',
    }));
    await expect(hooks.cancelBluetooth()).resolves.toBe(true);
    expect(adapter.nativeModule.cancelConnect).toHaveBeenCalledTimes(1);
  });

  test('intentional disconnect clears the active route and peer registry state', async () => {
    const registry = makeRegistry();
    const adapter = new BluetoothTransportAdapter({
      nativeModule: makeNative(),
      emitter: makeEmitter(),
      registry,
    });
    const peer = { deviceId: 'peer', transports: { BLUETOOTH: { address: 'AA:BB:CC:DD:EE:FF' } } };
    await adapter.connectPeer(peer);

    await adapter.disconnect();

    expect(adapter.nativeModule.disconnect).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus().activeRoute).toBeNull();
    expect(registry.setPeerDisconnected).toHaveBeenCalledWith('peer');
  });

  test('rejects an endpoint without an address before touching native Bluetooth', async () => {
    const nativeModule = makeNative();
    const adapter = new BluetoothTransportAdapter({ nativeModule, emitter: makeEmitter(), registry: makeRegistry() });

    await expect(adapter.connectPeer({ deviceId: 'missing-route' })).rejects.toThrow(/address/);
    expect(nativeModule.connect).not.toHaveBeenCalled();
  });
});
