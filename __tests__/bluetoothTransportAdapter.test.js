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
      remoteNodeId: 'remote-node',
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

  test('connects with authenticated RFCOMM metadata and registers only a stable supplied peer ID', async () => {
    const nativeModule = makeNative();
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

  test('serializes coordinator message objects while preserving string compatibility', async () => {
    const nativeModule = makeNative();
    const emitter = makeEmitter();
    const adapter = new BluetoothTransportAdapter({ nativeModule, emitter, registry: makeRegistry() });
    const events = [];
    adapter.subscribe(event => events.push(event));
    adapter.startObserving();
    emitter.emit('BT_CONNECTED', {
      address: 'AA:BB:CC:DD:EE:FF',
      sessionId: 'session-1',
      security: 'AUTHENTICATED_RFCOMM',
      bonded: true,
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
