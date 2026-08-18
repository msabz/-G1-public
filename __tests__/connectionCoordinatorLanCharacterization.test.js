jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import TcpSocket from 'react-native-tcp-socket';
import { ConnectionCoordinator, COORDINATOR_STATE } from '../src/network/ConnectionCoordinator';

function makeSocket() {
  const handlers = {};
  return {
    on: jest.fn((event, callback) => { handlers[event] = callback; }),
    once: jest.fn((event, callback) => { handlers[event] = callback; }),
    removeListener: jest.fn(),
    emit: (event, value) => handlers[event] && handlers[event](value),
    write: jest.fn(),
    setKeepAlive: jest.fn(),
    setNoDelay: jest.fn(),
    destroy: jest.fn(),
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ConnectionCoordinator LAN characterization', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('successful LAN attempt preserves logical coordinator state and callback semantics', async () => {
    const socket = makeSocket();
    TcpSocket.createConnection.mockImplementation((_options, onConnect) => {
      Promise.resolve().then(onConnect);
      return socket;
    });

    const onConnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      onConnected,
    });
    const peer = {
      deviceId: 'peer-device',
      deviceName: 'Peer',
      transports: {
        LAN: { host: '192.168.0.36', port: 8089 },
      },
    };

    const session = await coordinator.connectLanPeer(peer, 5000);

    expect(session).toBeTruthy();
    expect(session.isConnected).toBe(true);
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(coordinator.getActivePeer()).toBe(peer);
    expect(coordinator.currentTransport).toBe('LAN');
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledWith(peer, 'LAN');

    coordinator.disconnect();
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
  });

  test('cancelling a pending LAN attempt prevents a late socket from becoming active', async () => {
    const socket = makeSocket();
    let onConnect;
    TcpSocket.createConnection.mockImplementation((_options, callback) => {
      onConnect = callback;
      return socket;
    });

    const onConnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      onConnected,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: {
        LAN: { host: '192.168.0.36', port: 8089 },
      },
    };

    const attempt = coordinator.connectLanPeer(peer, 5000);
    await flushMicrotasks();
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTING);

    coordinator.cancelConnecting();
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);

    onConnect();
    await expect(attempt).resolves.toBeUndefined();

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(coordinator.activeSession).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
  });
});
