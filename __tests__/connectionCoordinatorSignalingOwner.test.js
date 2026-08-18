jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import TcpSocket from 'react-native-tcp-socket';
import { ConnectionCoordinator, COORDINATOR_STATE } from '../src/network/ConnectionCoordinator';

function makeOwner(overrides = {}) {
  const session = {
    isConnected: true,
    sendMessage: jest.fn(),
    destroy: jest.fn(),
  };
  return {
    session,
    connectOutbound: jest.fn().mockResolvedValue(undefined),
    cancelConnect: jest.fn(),
    getActiveSession: jest.fn(() => session),
    sendMessage: jest.fn().mockReturnValue(true),
    disconnect: jest.fn(),
    ...overrides,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ConnectionCoordinator signaling-owner boundary', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('delegates outbound LAN session ownership without starting a second heartbeat', async () => {
    const owner = makeOwner();
    const onConnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
      onConnected,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: {
        LAN: { host: '192.168.0.36', port: 8089 },
      },
    };

    const session = await coordinator.connectLanPeer(peer, 5000);

    expect(owner.connectOutbound).toHaveBeenCalledTimes(1);
    expect(owner.connectOutbound).toHaveBeenCalledWith({
      host: '192.168.0.36',
      port: 8089,
      maxRetries: 3,
      retryDelayMs: 600,
      timeoutMs: 5000,
    });
    expect(TcpSocket.createConnection).not.toHaveBeenCalled();
    expect(session).toBe(owner.session);
    expect(coordinator.activeSession).toBe(owner.session);
    expect(coordinator.activeSessionManagedExternally).toBe(true);
    expect(coordinator.heartbeatInterval).toBeNull();
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(coordinator.getActivePeer()).toBe(peer);
    expect(onConnected).toHaveBeenCalledWith(peer, 'LAN');
  });

  test('delegates send and disconnect to the external owner instead of destroying its session directly', async () => {
    const owner = makeOwner();
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { LAN: { host: '192.168.0.36', port: 8089 } },
    };

    await coordinator.connectLanPeer(peer, 5000);

    expect(coordinator.sendMessage({ type: 'chat', text: 'hello' })).toBe(true);
    expect(owner.sendMessage).toHaveBeenCalledWith({ type: 'chat', text: 'hello' });

    coordinator.disconnect();

    expect(owner.disconnect).toHaveBeenCalledTimes(1);
    expect(owner.session.destroy).not.toHaveBeenCalled();
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(coordinator.activeSession).toBeNull();
  });

  test('cancelling an externally owned attempt stays IDLE when the owner rejects the cancelled operation', async () => {
    let rejectConnect;
    const owner = makeOwner({
      connectOutbound: jest.fn(() => new Promise((_resolve, reject) => {
        rejectConnect = reject;
      })),
    });
    owner.cancelConnect.mockImplementation(() => {
      rejectConnect(new Error('cancelled'));
    });

    const onConnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
      onConnected,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { LAN: { host: '192.168.0.36', port: 8089 } },
    };

    const attempt = coordinator.connectLanPeer(peer, 5000);
    await flushMicrotasks();
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTING);

    coordinator.cancelConnecting();
    await expect(attempt).resolves.toBeUndefined();

    expect(owner.cancelConnect).toHaveBeenCalledTimes(1);
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(coordinator.activeSession).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
  });

  test('real owner failure is surfaced as coordinator ERROR rather than mistaken for cancellation', async () => {
    const failure = new Error('ECONNREFUSED');
    const owner = makeOwner({
      connectOutbound: jest.fn().mockRejectedValue(failure),
    });
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { LAN: { host: '192.168.0.36', port: 8089 } },
    };

    await expect(coordinator.connectLanPeer(peer, 5000)).rejects.toBe(failure);

    expect(coordinator.state).toBe(COORDINATOR_STATE.ERROR);
    expect(coordinator.activeSession).toBeNull();
  });

  test('invalid signaling-owner contract fails before coordinator state is mutated', async () => {
    const coordinator = new ConnectionCoordinator({ signalingOwner: {} });
    const peer = {
      deviceId: 'peer-device',
      transports: { LAN: { host: '192.168.0.36', port: 8089 } },
    };

    await expect(coordinator.connectLanPeer(peer, 5000)).rejects.toThrow(
      'Configured signaling owner is missing connectOutbound()'
    );
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(coordinator.currentPeer).toBeNull();
    expect(coordinator.currentTransport).toBeNull();
  });

  test('allows same signaling-owner rebinding but refuses replacement while connecting or connected', async () => {
    let resolveConnect;
    const owner = makeOwner({
      connectOutbound: jest.fn(() => new Promise(resolve => {
        resolveConnect = resolve;
      })),
    });
    const coordinator = new ConnectionCoordinator({ signalingOwner: owner });
    const peer = {
      deviceId: 'peer-device',
      transports: { LAN: { host: '192.168.0.36', port: 8089 } },
    };

    const attempt = coordinator.connectLanPeer(peer, 5000);
    await flushMicrotasks();
    expect(() => coordinator.setSignalingOwner(owner)).not.toThrow();
    expect(() => coordinator.setSignalingOwner(makeOwner())).toThrow(
      'Cannot replace signaling owner while a connection is active'
    );

    resolveConnect();
    await attempt;
    expect(() => coordinator.setSignalingOwner(owner)).not.toThrow();
    expect(() => coordinator.setSignalingOwner(makeOwner())).toThrow(
      'Cannot replace signaling owner while a connection is active'
    );

    coordinator.disconnect();
    expect(() => coordinator.setSignalingOwner(makeOwner())).not.toThrow();
  });
});
