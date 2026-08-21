import {
  NativeModules,
  NativeEventEmitter,
  PermissionsAndroid,
  Platform,
} from 'react-native';

const DEFAULT_POLL_MS = 5000;
const MARKER = '[G1/P2P-DISCOVERY]';
const DirectConnection = NativeModules?.DirectConnectionModule || null;

let activeStop = null;

const safeCall = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch (error) {
    return {
      error: error?.message || String(error),
      fallback,
    };
  }
};

export const getAndroidApiLevel = (platform = Platform) => {
  if (platform?.OS !== 'android' || platform?.Version == null) return null;
  const version = Number(platform.Version);
  return Number.isFinite(version) ? version : null;
};

const readNearbyPermission = async () => {
  const apiLevel = getAndroidApiLevel();
  if (apiLevel == null || apiLevel < 33) return 'not-required';
  const permission = PermissionsAndroid?.PERMISSIONS?.NEARBY_WIFI_DEVICES;
  if (!permission || typeof PermissionsAndroid?.check !== 'function') return 'unknown';
  try {
    return (await PermissionsAndroid.check(permission)) ? 'granted' : 'denied';
  } catch (error) {
    return `error:${error?.message || String(error)}`;
  }
};

export const normalizeP2pPeers = peers => (
  Array.isArray(peers) ? peers : []
).map(peer => ({
  deviceName: peer?.deviceName || '',
  deviceAddress: peer?.deviceAddress || '',
  status: Number.isFinite(Number(peer?.status)) ? Number(peer.status) : null,
}));

export async function captureP2pDiscoverySnapshot(nativeModule = DirectConnection) {
  const apiLevel = getAndroidApiLevel();
  if (!nativeModule) {
    return {
      available: false,
      apiLevel,
      nearbyPermission: await readNearbyPermission(),
      peers: [],
      peerCount: 0,
      groupFormed: false,
      isGroupOwner: false,
      groupOwnerAddress: null,
      error: 'DirectConnectionModule unavailable',
    };
  }

  const [supported, locationEnabled, rawPeers, connectionInfo, nearbyPermission] = await Promise.all([
    safeCall(() => nativeModule.isSupported?.(), null),
    safeCall(() => nativeModule.isLocationEnabled?.(), null),
    safeCall(() => nativeModule.requestPeers?.(), []),
    safeCall(() => nativeModule.getConnectionInfo?.(), {}),
    readNearbyPermission(),
  ]);

  const peers = normalizeP2pPeers(Array.isArray(rawPeers) ? rawPeers : []);
  const connection = connectionInfo && !connectionInfo.error ? connectionInfo : {};

  return {
    available: true,
    apiLevel,
    supported: supported && !supported.error ? supported : null,
    locationEnabled: locationEnabled && !locationEnabled.error ? locationEnabled : null,
    nearbyPermission,
    peerCount: peers.length,
    peers,
    groupFormed: connection.groupFormed === true,
    isGroupOwner: connection.isGroupOwner === true,
    groupOwnerAddress: connection.groupOwnerAddress || null,
    requestPeersError: rawPeers?.error || null,
    connectionInfoError: connectionInfo?.error || null,
  };
}

function createEmitter(nativeModule) {
  if (!nativeModule || typeof NativeEventEmitter !== 'function') return null;
  try {
    return new NativeEventEmitter(nativeModule);
  } catch (error) {
    return null;
  }
}

export function startP2pDiscoveryDiagnostics(options = {}) {
  if (activeStop) return activeStop;

  const nativeModule = options.nativeModule || DirectConnection;
  const logger = options.logger || console.log;
  const log = (kind, payload = {}) => {
    try {
      logger(`${MARKER} ${kind} ${JSON.stringify(payload)}`);
    } catch (error) {}
  };

  // Unit-test/bootstrap environments and non-Android runtimes intentionally
  // expose only partial React Native mocks. Diagnostics must never keep those
  // processes alive or throw simply because the Android native module is absent.
  if (!nativeModule) {
    log('UNAVAILABLE', { reason: 'DirectConnectionModule unavailable' });
    return () => {};
  }

  const emitter = options.emitter || createEmitter(nativeModule);
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : DEFAULT_POLL_MS;
  let stopped = false;
  let pollSequence = 0;
  const subscriptions = [];

  const snapshot = async source => {
    if (stopped) return null;
    const data = await captureP2pDiscoverySnapshot(nativeModule);
    if (!stopped) log('SNAPSHOT', { source, sequence: pollSequence, ...data });
    return data;
  };

  const eventNames = [
    'WIFI_P2P_STATE_CHANGED',
    'PEERS_UPDATED',
    'MUSAB_PEER_FOUND',
    'PEER_CONNECTED',
    'PEER_DISCONNECTED',
    'PEER_ADDRESS_RESOLVED',
  ];
  if (emitter?.addListener) {
    eventNames.forEach(name => {
      subscriptions.push(emitter.addListener(name, payload => {
        log('EVENT', { name, payload: payload || null });
      }));
    });
  }

  snapshot('startup');
  const timer = setInterval(() => {
    pollSequence += 1;
    snapshot('poll');
  }, pollMs);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    subscriptions.forEach(subscription => {
      try { subscription?.remove?.(); } catch (error) {}
    });
    if (activeStop === stop) activeStop = null;
    log('STOPPED');
  };

  activeStop = stop;
  return stop;
}

export const P2P_DISCOVERY_DIAGNOSTIC_MARKER = MARKER;
