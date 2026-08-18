jest.mock('../src/webrtc/signaling', () => ({
  isSameSignalingEndpoint: (left, right) => {
    const normalize = value => {
      if (!value || typeof value !== 'string') return null;
      let result = value.trim();
      if (result.startsWith('::ffff:')) result = result.slice(7);
      if (result.startsWith('[') && result.endsWith(']')) result = result.slice(1, -1);
      return result || null;
    };
    const a = normalize(left);
    const b = normalize(right);
    return !!(a && b && a === b);
  },
}));

jest.mock('../src/network/ConnectionCoordinator', () => ({
  connectionCoordinator: {
    adoptSignalingOwnerSession: jest.fn(),
  },
}));

const {
  createLanPassiveAdmissionHandler,
  setLanPassiveAdmissionContextProvider,
} = require('../src/network/LanPassiveAdmission');

const peer = {
  deviceId: 'peer-1',
  transports: {
    LAN: {
      host: '192.168.0.36',
      generation: 3,
      isReachable: true,
      stale: false,
    },
  },
};

function makeRegistry() {
  return {
    getPeer: jest.fn(deviceId => deviceId === peer.deviceId ? peer : null),
    isTransportEndpointCurrent: jest.fn(() => true),
  };
}

describe('passive LAN admission runtime context', () => {
  afterEach(() => {
    setLanPassiveAdmissionContextProvider(null);
  });

  test('rejects a passive LAN identity while the mounted App is busy with a non-LAN connection attempt', () => {
    const coordinator = { adoptSignalingOwnerSession: jest.fn() };
    const handler = createLanPassiveAdmissionHandler({
      registry: makeRegistry(),
      coordinator,
    });
    setLanPassiveAdmissionContextProvider(() => ({
      uiMounted: true,
      appState: 'WIFI_CONNECTING',
      pendingKnownLanPeerId: null,
    }));

    expect(handler({
      message: { type: 'identity', deviceId: 'peer-1' },
      peerAddress: '192.168.0.36',
    })).toEqual(expect.objectContaining({
      accepted: false,
      reason: 'app-busy',
    }));
    expect(coordinator.adoptSignalingOwnerSession).not.toHaveBeenCalled();
  });

  test('allows the exact peer racing a mounted known-LAN outbound attempt', () => {
    const coordinator = {
      adoptSignalingOwnerSession: jest.fn(() => ({ id: 'inbound-winner' })),
    };
    const handler = createLanPassiveAdmissionHandler({
      registry: makeRegistry(),
      coordinator,
    });
    setLanPassiveAdmissionContextProvider(() => ({
      uiMounted: true,
      appState: 'WIFI_CONNECTING',
      pendingKnownLanPeerId: 'peer-1',
    }));

    expect(handler({
      message: { type: 'identity', deviceId: 'peer-1' },
      peerAddress: '192.168.0.36',
    })).toEqual(expect.objectContaining({ accepted: true }));
    expect(coordinator.adoptSignalingOwnerSession).toHaveBeenCalledTimes(1);
  });

  test('does not let stale detached UI state permanently block a trusted passive LAN session', () => {
    const coordinator = {
      adoptSignalingOwnerSession: jest.fn(() => ({ id: 'background-inbound' })),
    };
    const handler = createLanPassiveAdmissionHandler({
      registry: makeRegistry(),
      coordinator,
    });
    setLanPassiveAdmissionContextProvider(() => ({
      uiMounted: false,
      appState: 'CONNECTED',
      pendingKnownLanPeerId: null,
    }));

    expect(handler({
      message: { type: 'identity', deviceId: 'peer-1' },
      peerAddress: '192.168.0.36',
    })).toEqual(expect.objectContaining({ accepted: true }));
    expect(coordinator.adoptSignalingOwnerSession).toHaveBeenCalledTimes(1);
  });
});
