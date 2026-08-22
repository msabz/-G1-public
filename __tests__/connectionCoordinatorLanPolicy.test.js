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
    emit: (event, value) => handlers[event] && handlers[event](value),
    write: jest.fn(),
    setKeepAlive: jest.fn(),
    setNoDelay: jest.fn(),
    destroy: jest.fn(),
  };
}

function makeOwner() {
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
  };
}

const peer = {
  deviceId: 'peer-device',
  transports: {
    LAN: { host: '192.168.0.36', port: 8089 },
  },
};

describe('ConnectionCoordinator LAN connect policy', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('forwards an explicit live-LAN retry policy to the external signaling owner', async () => {
    const owner = makeOwner();
    const coordinator = new ConnectionCoordinator({ signalingOwner: owner });

    await coordinator.connectLanPeer(peer, 5000, {
      maxRetries: 5,
      retryDelayMs: 800,
    });

    expect(owner.connectOutbound).toHaveBeenCalledTimes(1);
    expect(owner.connectOutbound).toHaveBeenCalledWith({
      host: '192.168.0.36',
      port: 8089,
      maxRetries: 5,
      retryDelayMs: 800,
      timeoutMs: 5000,
    });
  });

  test('forwards a scoped IPv6 link-local LAN host without stripping its zone', async () => {
    const owner = makeOwner();
    const coordinator = new ConnectionCoordinator({ signalingOwner: owner });
    const scopedPeer = {
      deviceId: 'peer-ipv6',
      transports: {
        LAN: { host: 'fe80::a12b:34ff:fe56:7890%wlan0', port: 8089 },
      },
    };

    await coordinator.connectLanPeer(scopedPeer, 5000);

    expect(owner.connectOutbound).toHaveBeenCalledWith(expect.objectContaining({
      host: 'fe80::a12b:34ff:fe56:7890%wlan0',
      port: 8089,
    }));
  });

  test('applies the same explicit attempt count and retry delay to the legacy socket path', async () => {
    jest.useFakeTimers();
    const sockets = [];
    TcpSocket.createConnection.mockImplementation(() => {
      const socket = makeSocket();
      sockets.push(socket);
      return socket;
    });

    const coordinator = new ConnectionCoordinator();
    const attempt = coordinator.connectLanPeer(peer, 5000, {
      maxRetries: 2,
      retryDelayMs: 750,
    });

    expect(TcpSocket.createConnection).toHaveBeenCalledTimes(1);
    sockets[0].emit('error', new Error('first failure'));

    jest.advanceTimersByTime(749);
    expect(TcpSocket.createConnection).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    expect(TcpSocket.createConnection).toHaveBeenCalledTimes(2);

    sockets[1].emit('error', new Error('second failure'));
    await expect(attempt).rejects.toThrow('second failure');

    expect(TcpSocket.createConnection).toHaveBeenCalledTimes(2);
    expect(coordinator.state).toBe(COORDINATOR_STATE.ERROR);
  });
});
