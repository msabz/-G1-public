jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import { ConnectionCoordinator, COORDINATOR_STATE } from '../src/network/ConnectionCoordinator';

const LAN = 'LAN';

function makePeer(deviceId = 'peer-device') {
  return {
    deviceId,
    transports: {
      LAN: { host: '192.168.0.36', port: 8089 },
    },
  };
}

function makeOwner({ isOutbound = false, isConnected = true, pendingConnect = false } = {}) {
  const session = {
    isConnected,
    isOutbound,
    sendMessage: jest.fn(),
    destroy: jest.fn(),
  };
  const observers = [];
  const subscriptions = [];
  let rejectPendingConnect = null;

  const owner = {
    session,
    observers,
    subscriptions,
    connectOutbound: pendingConnect
      ? jest.fn(() => new Promise((resolve, reject) => {
          rejectPendingConnect = reject;
        }))
      : jest.fn().mockResolvedValue(undefined),
    cancelConnect: jest.fn(reason => {
      if (!rejectPendingConnect) return false;
      const reject = rejectPendingConnect;
      rejectPendingConnect = null;
      reject(reason instanceof Error ? reason : new Error(String(reason || 'cancelled')));
      return true;
    }),
    getActiveSession: jest.fn(() => session),
    sendMessage: jest.fn().mockReturnValue(true),
    disconnect: jest.fn(),
    subscribeDisconnect: jest.fn(observer => {
      observers.push(observer);
      const subscription = { remove: jest.fn() };
      subscriptions.push(subscription);
      return subscription;
    }),
  };

  return owner;
}

describe('ConnectionCoordinator signaling-owner session adoption', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('adopts an already-connected inbound owner session without opening another connection or heartbeat', () => {
    const owner = makeOwner({ isOutbound: false });
    const peer = makePeer();
    const onConnected = jest.fn();
    const coordinator = new ConnectionCoordinator({ signalingOwner: owner, onConnected });

    const adopted = coordinator.adoptSignalingOwnerSession(peer, LAN, { requireInbound: true });

    expect(adopted).toBe(owner.session);
    expect(owner.connectOutbound).not.toHaveBeenCalled();
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(coordinator.getActivePeer()).toBe(peer);
    expect(coordinator.currentTransport).toBe(LAN);
    expect(coordinator.activeSession).toBe(owner.session);
    expect(coordinator.activeSessionManagedExternally).toBe(true);
    expect(coordinator.heartbeatInterval).toBeNull();
    expect(owner.subscribeDisconnect).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledWith(peer, LAN);
  });

  test('requireInbound rejects an outbound active owner session before mutating coordinator state', () => {
    const owner = makeOwner({ isOutbound: true });
    const coordinator = new ConnectionCoordinator({ signalingOwner: owner });

    expect(() => coordinator.adoptSignalingOwnerSession(makePeer(), LAN, { requireInbound: true }))
      .toThrow(/inbound|واردة/i);

    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(coordinator.currentPeer).toBeNull();
    expect(coordinator.currentTransport).toBeNull();
    expect(owner.connectOutbound).not.toHaveBeenCalled();
    expect(owner.subscribeDisconnect).not.toHaveBeenCalled();
  });

  test('re-adopting the same externally managed peer/transport is idempotent and refreshes the session snapshot', () => {
    const owner = makeOwner({ isOutbound: false });
    const peer = makePeer();
    const onConnected = jest.fn();
    const coordinator = new ConnectionCoordinator({ signalingOwner: owner, onConnected });

    const first = coordinator.adoptSignalingOwnerSession(peer, LAN, { requireInbound: true });
    const generation = coordinator.generation;
    const replacementSession = {
      isConnected: true,
      isOutbound: false,
      sendMessage: jest.fn(),
      destroy: jest.fn(),
    };
    owner.session = replacementSession;
    owner.getActiveSession.mockImplementation(() => owner.session);

    const second = coordinator.adoptSignalingOwnerSession(peer, LAN, { requireInbound: true });

    expect(first).not.toBe(second);
    expect(second).toBe(replacementSession);
    expect(coordinator.activeSession).toBe(replacementSession);
    expect(coordinator.generation).toBe(generation);
    expect(owner.subscribeDisconnect).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  test('terminal owner disconnect after adoption returns the logical coordinator to IDLE exactly once', () => {
    const owner = makeOwner({ isOutbound: false });
    const peer = makePeer();
    const onDisconnected = jest.fn();
    const coordinator = new ConnectionCoordinator({ signalingOwner: owner, onDisconnected });

    coordinator.adoptSignalingOwnerSession(peer, LAN, { requireInbound: true });
    expect(owner.observers).toHaveLength(1);

    owner.observers[0]({ reason: 'heartbeat-timeout', recovered: false });
    owner.observers[0]({ reason: 'duplicate-terminal-event', recovered: false });

    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(coordinator.activeSession).toBeNull();
    expect(coordinator.currentPeer).toBeNull();
    expect(coordinator.currentTransport).toBeNull();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledWith(peer);
  });

  test('same-peer CONNECTING race cancels only the pending outbound attempt and adopts the inbound owner session', async () => {
    const owner = makeOwner({ isOutbound: false, pendingConnect: true });
    const peer = makePeer();
    const coordinator = new ConnectionCoordinator({ signalingOwner: owner });

    const outboundAttempt = coordinator.connectLanPeer(peer, 5000);
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTING);

    const adopted = coordinator.adoptSignalingOwnerSession(peer, LAN, { requireInbound: true });

    expect(adopted).toBe(owner.session);
    expect(owner.cancelConnect).toHaveBeenCalledTimes(1);
    expect(owner.disconnect).not.toHaveBeenCalled();
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(coordinator.activeSession).toBe(owner.session);
    expect(coordinator.currentPeer).toBe(peer);
    expect(coordinator.currentTransport).toBe(LAN);

    await expect(outboundAttempt).resolves.toBeUndefined();
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
  });
});
