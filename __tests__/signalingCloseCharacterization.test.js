jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

jest.mock('react-native', () => ({
  NativeModules: {
    DirectConnectionModule: {
      getLocalIpAddress: jest.fn().mockResolvedValue(null),
    },
    ServiceModule: {
      startAvailabilityService: jest.fn().mockResolvedValue(true),
      startConnectionService: jest.fn().mockResolvedValue(true),
      updateConnectionStatus: jest.fn().mockResolvedValue(true),
    },
  },
}));

import TcpSocket from 'react-native-tcp-socket';
import {
  connectToSignalingServer,
  closeSignaling,
  getSignalingHealth,
  setOnDisconnect,
} from '../src/webrtc/signaling';

function makeSocket(remoteAddress = null) {
  const handlers = {};
  return {
    remoteAddress,
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

describe('closeSignaling ownership characterization', () => {
  afterEach(() => {
    closeSignaling();
    setOnDisconnect(null);
    jest.clearAllMocks();
  });

  test('full close cancels a pending outbound attempt and rejects a late socket', async () => {
    let onConnect;
    const socket = makeSocket('192.168.0.36');
    TcpSocket.createConnection.mockImplementation((_options, callback) => {
      onConnect = callback;
      return socket;
    });

    const attempt = connectToSignalingServer('192.168.0.36', 8089, 1, 1);
    await flushMicrotasks();

    closeSignaling();
    await expect(attempt).rejects.toThrow('أُغلقت قناة الإشارات');

    onConnect();
    await flushMicrotasks();

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(getSignalingHealth().connected).toBe(false);
  });

  test('full close destroys a healthy active session, so it is not attempt-only cancellation', async () => {
    const disconnected = jest.fn();
    setOnDisconnect(disconnected);
    const socket = makeSocket('192.168.0.36');
    TcpSocket.createConnection.mockImplementation((_options, callback) => {
      Promise.resolve().then(callback);
      return socket;
    });

    await connectToSignalingServer('192.168.0.36', 8089, 1, 1);
    expect(getSignalingHealth().connected).toBe(true);

    closeSignaling();

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(getSignalingHealth().connected).toBe(false);
    expect(disconnected).not.toHaveBeenCalled();
  });
});
