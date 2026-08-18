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

const { createLanPassiveAdmissionHandler } = require('../src/network/LanPassiveAdmission');

function makeRegistry(peer, current = true) {
  return {
    getPeer: jest.fn(deviceId => deviceId === peer?.deviceId ? peer : null),
    isTransportEndpointCurrent: jest.fn(() => current),
  };
}

describe('LAN passive session admission policy', () => {
  const peer = {
    deviceId: 'peer-1',
    deviceName: 'Peer One',
    transports: {
      LAN: {
        host: '192.168.0.36',
        port: 8089,
        generation: 4,
        isReachable: true,
        stale: false,
      },
    },
  };

  test('admits a current discovered LAN identity only when the live socket endpoint matches', () => {
    const registry = makeRegistry(peer, true);
    const coordinator = {
      adoptSignalingOwnerSession: jest.fn(() => ({ id: 'inbound-session' })),
    };
    const handler = createLanPassiveAdmissionHandler({ registry, coordinator });

    const result = handler({
      message: { type: 'identity', deviceId: 'peer-1', deviceName: 'Claimed Name' },
      peerAddress: '::ffff:192.168.0.36',
    });

    expect(result).toEqual(expect.objectContaining({
      accepted: true,
      peerId: 'peer-1',
      transport: 'LAN',
    }));
    expect(registry.isTransportEndpointCurrent).toHaveBeenCalledWith(peer.transports.LAN, 'LAN');
    expect(coordinator.adoptSignalingOwnerSession).toHaveBeenCalledWith(
      peer,
      'LAN',
      { requireInbound: true }
    );
  });

  test('rejects an unknown deviceId without adopting the socket', () => {
    const registry = makeRegistry(peer, true);
    const coordinator = { adoptSignalingOwnerSession: jest.fn() };
    const handler = createLanPassiveAdmissionHandler({ registry, coordinator });

    const result = handler({
      message: { type: 'identity', deviceId: 'unknown-peer' },
      peerAddress: '192.168.0.36',
    });

    expect(result).toEqual(expect.objectContaining({ accepted: false }));
    expect(coordinator.adoptSignalingOwnerSession).not.toHaveBeenCalled();
  });

  test('rejects a stale or unreachable LAN route', () => {
    const registry = makeRegistry(peer, false);
    const coordinator = { adoptSignalingOwnerSession: jest.fn() };
    const handler = createLanPassiveAdmissionHandler({ registry, coordinator });

    const result = handler({
      message: { type: 'identity', deviceId: 'peer-1' },
      peerAddress: '192.168.0.36',
    });

    expect(result).toEqual(expect.objectContaining({ accepted: false }));
    expect(coordinator.adoptSignalingOwnerSession).not.toHaveBeenCalled();
  });

  test('rejects a matching deviceId arriving from a different socket endpoint', () => {
    const registry = makeRegistry(peer, true);
    const coordinator = { adoptSignalingOwnerSession: jest.fn() };
    const handler = createLanPassiveAdmissionHandler({ registry, coordinator });

    const result = handler({
      message: { type: 'identity', deviceId: 'peer-1' },
      peerAddress: '192.168.0.55',
    });

    expect(result).toEqual(expect.objectContaining({ accepted: false, reason: 'endpoint-mismatch' }));
    expect(coordinator.adoptSignalingOwnerSession).not.toHaveBeenCalled();
  });

  test('rejects non-identity frames and coordinator adoption failures', () => {
    const registry = makeRegistry(peer, true);
    const coordinator = {
      adoptSignalingOwnerSession: jest.fn(() => {
        throw new Error('different peer already connected');
      }),
    };
    const handler = createLanPassiveAdmissionHandler({ registry, coordinator });

    expect(handler({
      message: { type: 'chat', text: 'not identity' },
      peerAddress: '192.168.0.36',
    })).toEqual(expect.objectContaining({ accepted: false, reason: 'identity-required' }));

    expect(handler({
      message: { type: 'identity', deviceId: 'peer-1' },
      peerAddress: '192.168.0.36',
    })).toEqual(expect.objectContaining({ accepted: false, reason: 'coordinator-rejected' }));
  });
});
