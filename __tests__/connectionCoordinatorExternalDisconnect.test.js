jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import { ConnectionCoordinator, COORDINATOR_STATE } from '../src/network/ConnectionCoordinator';

function makePeer() {
  return {
    deviceId: 'peer-device',
    transports: {
      LAN: { host: '192.168.0.36', port: 8089 },
    },
  };
}

function makeOwner() {
  const session = {
    isConnected: true,
    sendMessage: jest.fn(),
    destroy: jest.fn(),
  };
  const observers = [];
  const subscriptions = [];

  const owner = {
    session,
    observers,
    subscriptions,
    connectOutbound: jest.fn().mockResolvedValue(undefined),
    cancelConnect: jest.fn(),
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

describe('ConnectionCoordinator external signaling disconnect synchronization', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('terminal signaling disconnect moves the logical coordinator to IDLE exactly once', async () => {
    const owner = makeOwner();
    const peer = makePeer();
    const onDisconnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      signalingOwner: owner,
      onDisconnected,
    });

    await coordinator.connectLanPeer(peer, 5000);

    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(owner.subscribeDisconnect).toHaveBeenCalledTimes(1);
    expect(owner.observers).toHaveLength(1);

    owner.observers[0]({ reason: 'heartbeat-timeout', recovered: false });

    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(coordinator.activeSession).toBeNull();
    expect(coordinator.currentPeer).toBeNull();
    expect(coordinator.currentTransport).toBeNull();
    expect(owner.subscriptions[0].remove).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledWith(peer);

    owner.observers[0]({ reason: 'duplicate-terminal-event', recovered: false });
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  test('explicit disconnect unsubscribes before closing the owner and does not double-notify', async () => {
    const owner = makeOwner();
    const peer = makePeer();
    const onDisconnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      signalingOwner: owner,
      onDisconnected,
    });

    await coordinator.connectLanPeer(peer, 5000);
    expect(owner.observers).toHaveLength(1);

    owner.disconnect.mockImplementation(() => {
      owner.observers[0]({ reason: 'explicit-close', recovered: false });
    });

    coordinator.disconnect();

    expect(owner.subscriptions[0].remove).toHaveBeenCalledTimes(1);
    expect(owner.disconnect).toHaveBeenCalledTimes(1);
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  test('a stale disconnect callback from an older generation cannot terminate a newer connection', async () => {
    const owner = makeOwner();
    const peer = makePeer();
    const onDisconnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      signalingOwner: owner,
      onDisconnected,
    });

    await coordinator.connectLanPeer(peer, 5000);
    expect(owner.observers).toHaveLength(1);
    const firstObserver = owner.observers[0];

    firstObserver({ reason: 'first-session-ended', recovered: false });
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(onDisconnected).toHaveBeenCalledTimes(1);

    await coordinator.connectLanPeer(peer, 5000);
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(owner.observers).toHaveLength(2);

    firstObserver({ reason: 'late-old-generation-event', recovered: false });

    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(coordinator.getActivePeer()).toBe(peer);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });
});
