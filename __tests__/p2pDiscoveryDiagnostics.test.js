jest.mock('react-native', () => ({
  NativeModules: {},
  NativeEventEmitter: jest.fn(),
  PermissionsAndroid: {
    PERMISSIONS: { NEARBY_WIFI_DEVICES: 'android.permission.NEARBY_WIFI_DEVICES' },
    check: jest.fn(async () => true),
  },
  Platform: { OS: 'android', Version: 34 },
}));

import {
  captureP2pDiscoverySnapshot,
  getAndroidApiLevel,
  normalizeP2pPeers,
  startP2pDiscoveryDiagnostics,
} from '../src/network/p2pDiscoveryDiagnostics';

describe('p2pDiscoveryDiagnostics', () => {
  test('tolerates partial/non-Android React Native runtime metadata', () => {
    expect(getAndroidApiLevel(undefined)).toBeNull();
    expect(getAndroidApiLevel({ OS: 'ios', Version: '18' })).toBeNull();
    expect(getAndroidApiLevel({ OS: 'android', Version: 34 })).toBe(34);
  });

  test('normalizes native peer snapshots without inventing stable identity', () => {
    expect(normalizeP2pPeers([
      { deviceName: 'moto g35 5G', deviceAddress: 'AA:BB:CC:DD:EE:FF', status: 3 },
    ])).toEqual([
      { deviceName: 'moto g35 5G', deviceAddress: 'AA:BB:CC:DD:EE:FF', status: 3 },
    ]);
  });

  test('captures read-only framework evidence from the native module', async () => {
    const nativeModule = {
      isSupported: jest.fn(async () => true),
      isLocationEnabled: jest.fn(async () => true),
      requestPeers: jest.fn(async () => [
        { deviceName: 'Samsung', deviceAddress: '11:22:33:44:55:66', status: 3 },
      ]),
      getConnectionInfo: jest.fn(async () => ({
        groupFormed: false,
        isGroupOwner: false,
        groupOwnerAddress: null,
      })),
    };

    const snapshot = await captureP2pDiscoverySnapshot(nativeModule);

    expect(snapshot).toMatchObject({
      available: true,
      apiLevel: 34,
      supported: true,
      locationEnabled: true,
      nearbyPermission: 'granted',
      peerCount: 1,
      groupFormed: false,
    });
    expect(snapshot.peers[0].deviceAddress).toBe('11:22:33:44:55:66');
    expect(nativeModule.requestPeers).toHaveBeenCalledTimes(1);
  });

  test('logs native events and stops without mutating transport state', () => {
    jest.useFakeTimers();
    const listeners = {};
    const emitter = {
      addListener: jest.fn((name, callback) => {
        listeners[name] = callback;
        return { remove: jest.fn() };
      }),
    };
    const nativeModule = {
      isSupported: jest.fn(async () => true),
      isLocationEnabled: jest.fn(async () => true),
      requestPeers: jest.fn(async () => []),
      getConnectionInfo: jest.fn(async () => ({ groupFormed: false })),
      discoverPeers: jest.fn(),
      connectToPeer: jest.fn(),
      cleanupConnection: jest.fn(),
    };
    const logger = jest.fn();

    const stop = startP2pDiscoveryDiagnostics({
      nativeModule,
      emitter,
      logger,
      pollMs: 5000,
    });

    listeners.PEERS_UPDATED?.({ peers: [] });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('PEERS_UPDATED'));
    expect(nativeModule.discoverPeers).not.toHaveBeenCalled();
    expect(nativeModule.connectToPeer).not.toHaveBeenCalled();
    expect(nativeModule.cleanupConnection).not.toHaveBeenCalled();

    stop();
    jest.useRealTimers();
  });
});
