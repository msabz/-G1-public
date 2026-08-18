jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import TcpSocket from 'react-native-tcp-socket';
import {
  ConnectionCoordinator,
  COORDINATOR_STATE,
} from '../src/network/ConnectionCoordinator';
import { TRANSPORTS } from '../src/network/PeerRegistry';

function makeOwner(overrides = {}) {
  const session = {
    isConnected: true,
    isOutbound: true,
    sendMessage: jest.fn(),
    destroy: jest.fn(),
  };
  let disconnectObserver = null;
  return {
    session,
    connectOutbound: jest.fn().mockResolvedValue(undefined),
    acceptInbound: jest.fn().mockImplementation(async () => {
      session.isOutbound = false;
      return session;
    }),
    cancelConnect: jest.fn(),
    getActiveSession: jest.fn(() => session),
    sendMessage: jest.fn().mockReturnValue(true),
    disconnect: jest.fn(),
    subscribeDisconnect: jest.fn(observer => {
      disconnectObserver = observer;
      return { remove: jest.fn() };
    }),
    emitDisconnect() {
      disconnectObserver?.({ reason: 'test-disconnect' });
    },
    ...overrides,
  };
}

function makeP2pAdapter(route, overrides = {}) {
  return {
    setIdentity: jest.fn(),
    connectPeer: jest.fn().mockResolvedValue(route),
    cancelConnect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue({ clean: true }),
    getStatus: jest.fn(() => ({ state: 'READY' })),
    ...overrides,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ConnectionCoordinator Wi-Fi Direct ownership', () => {
  afterEach(() => jest.clearAllMocks());

  test('client role prepares P2P route, opens signaling through owner, and owns logical session', async () => {
    const owner = makeOwner();
    const p2pAdapter = makeP2pAdapter({
      transport: TRANSPORTS.P2P,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 11,
      bound: true,
    });
    const onConnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      myDeviceName: 'Self phone',
      signalingOwner: owner,
      p2pAdapter,
      onConnected,
    });
    const peer = {
      deviceId: 'peer-device',
      deviceName: 'Peer phone',
      transports: {
        P2P: { deviceAddress: 'AA:BB:CC:DD:EE:FF' },
      },
    };

    const session = await coordinator.connectP2pPeer(peer, 12000, {
      port: 8089,
      maxRetries: 4,
      retryDelayMs: 700,
    });

    expect(p2pAdapter.connectPeer).toHaveBeenCalledWith(peer, {
      timeoutMs: 12000,
      incoming: false,
    });
    expect(owner.connectOutbound).toHaveBeenCalledWith({
      host: '192.168.49.1',
      port: 8089,
      maxRetries: 4,
      retryDelayMs: 700,
      timeoutMs: 12000,
    });
    expect(owner.acceptInbound).not.toHaveBeenCalled();
    expect(owner.sendMessage).toHaveBeenCalledWith({
      type: 'identity',
      deviceId: 'self-device',
      deviceName: 'Self phone',
    });
    expect(TcpSocket.createConnection).not.toHaveBeenCalled();
    expect(session).toBe(owner.session);
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(coordinator.currentTransport).toBe(TRANSPORTS.P2P);
    expect(coordinator.activeSessionManagedExternally).toBe(true);
    expect(coordinator.heartbeatInterval).toBeNull();
    expect(onConnected).toHaveBeenCalledWith(peer, TRANSPORTS.P2P);
  });

  test('group owner waits for inbound signaling through the same signaling owner', async () => {
    const owner = makeOwner();
    const p2pAdapter = makeP2pAdapter({
      transport: TRANSPORTS.P2P,
      isGroupOwner: true,
      groupOwnerAddress: null,
      connectionEpoch: 12,
      bound: true,
    });
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      myDeviceName: 'Self phone',
      signalingOwner: owner,
      p2pAdapter,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };

    await coordinator.connectP2pPeer(peer, 9000, { signalingTimeoutMs: 15000 });

    expect(owner.acceptInbound).toHaveBeenCalledWith({ port: 8089, timeoutMs: 15000 });
    expect(owner.connectOutbound).not.toHaveBeenCalled();
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(coordinator.currentTransport).toBe(TRANSPORTS.P2P);
  });

  test('cancelling a pending P2P attempt tears down both route and signaling attempt without promotion', async () => {
    let rejectRoute;
    const p2pAdapter = makeP2pAdapter(null, {
      connectPeer: jest.fn(() => new Promise((_resolve, reject) => {
        rejectRoute = reject;
      })),
    });
    p2pAdapter.cancelConnect.mockImplementation(() => {
      rejectRoute?.(new Error('cancelled'));
      return Promise.resolve(true);
    });
    const owner = makeOwner();
    const onConnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
      p2pAdapter,
      onConnected,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };

    const attempt = coordinator.connectP2pPeer(peer, 9000);
    await flushMicrotasks();
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTING);

    coordinator.cancelConnecting();
    await expect(attempt).resolves.toBeUndefined();

    expect(p2pAdapter.cancelConnect).toHaveBeenCalledTimes(1);
    expect(owner.cancelConnect).toHaveBeenCalledTimes(1);
    expect(owner.disconnect).toHaveBeenCalledTimes(1);
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(coordinator.currentPeer).toBeNull();
    expect(coordinator.currentTransport).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
  });

  test('signaling failure after group formation cleans P2P and exposes coordinator ERROR', async () => {
    const failure = new Error('signaling refused');
    const owner = makeOwner({
      connectOutbound: jest.fn().mockRejectedValue(failure),
    });
    const p2pAdapter = makeP2pAdapter({
      transport: TRANSPORTS.P2P,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
    });
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
      p2pAdapter,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: 'AA:AA:AA:AA:AA:AA' } },
    };

    await expect(coordinator.connectP2pPeer(peer, 7000)).rejects.toBe(failure);

    expect(owner.disconnect).toHaveBeenCalledTimes(1);
    expect(p2pAdapter.disconnect).toHaveBeenCalledTimes(1);
    expect(coordinator.state).toBe(COORDINATOR_STATE.ERROR);
    expect(coordinator.activeSession).toBeNull();
  });

  test('terminal signaling loss releases the owned P2P group instead of starting a second heartbeat/reconnect owner', async () => {
    const owner = makeOwner();
    const p2pAdapter = makeP2pAdapter({
      transport: TRANSPORTS.P2P,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
    });
    const onDisconnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
      p2pAdapter,
      onDisconnected,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: 'AA:BB:CC:00:00:01' } },
    };

    await coordinator.connectP2pPeer(peer, 7000);
    owner.emitDisconnect();
    await flushMicrotasks();

    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(coordinator.activeSession).toBeNull();
    expect(p2pAdapter.disconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledWith(peer);
  });

  test('explicit disconnect closes signaling and P2P transport exactly through their owners', async () => {
    const owner = makeOwner();
    const p2pAdapter = makeP2pAdapter({
      transport: TRANSPORTS.P2P,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
    });
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
      p2pAdapter,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: 'AA:BB:CC:00:00:02' } },
    };

    await coordinator.connectP2pPeer(peer, 7000);
    coordinator.disconnect();
    await flushMicrotasks();

    expect(owner.disconnect).toHaveBeenCalledTimes(1);
    expect(p2pAdapter.disconnect).toHaveBeenCalledTimes(1);
    expect(owner.session.destroy).not.toHaveBeenCalled();
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
  });

  test('P2P adapter can be wired before use and receives stable local identity', () => {
    const first = makeP2pAdapter(null);
    const second = makeP2pAdapter(null);
    const coordinator = new ConnectionCoordinator();

    coordinator.setP2pAdapter(first);
    coordinator.setIdentity({ deviceId: 'self-device', deviceName: 'Self phone' });

    expect(first.setIdentity).toHaveBeenCalledWith({
      deviceId: 'self-device',
      deviceName: 'Self phone',
    });
    expect(() => coordinator.setP2pAdapter(second)).not.toThrow();
    expect(second.setIdentity).toHaveBeenCalledWith({
      deviceId: 'self-device',
      deviceName: 'Self phone',
    });
  });
});
