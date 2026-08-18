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
    connectToPeer: jest.fn().mockResolvedValue(true),
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

describe('WifiDirectTransportAdapter', () => {
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
      connectionEpoch: 10,
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
    expect(adapter.getStatus().state).toBe(WIFI_DIRECT_ADAPTER_STATE.IDLE);
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
