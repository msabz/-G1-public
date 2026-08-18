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
  closeSignaling,
  connectToSignalingServer,
  getActiveSession,
  getSignalingHealth,
  setOnDisconnect,
} from '../src/webrtc/signaling';

function makeSocket(remoteAddress = '192.168.0.36') {
  const handlers = {};
  return {
    remoteAddress,
    localAddress: '192.168.0.182',
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

describe('signaling close/cancellation characterization', () => {
  afterEach(() => {
    closeSignaling();
    setOnDisconnect(null);
    jest.clearAllMocks();
  });

  test('closeSignaling settles a pending outbound attempt and destroys its late socket', async () => {
    const socket = makeSocket();
    let onConnect;
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
    expect(getActiveSession()).toBeNull();
  });

  test('closeSignaling also destroys a healthy active session, so it is not a connect-only cancellation primitive', async () => {
    const socket = makeSocket();
    TcpSocket.createConnection.mockImplementation((_options, callback) => {
      Promise.resolve().then(callback);
      return socket;
    });

    await connectToSignalingServer('192.168.0.36', 8089, 1, 1);
    expect(getSignalingHealth().connected).toBe(true);
    expect(getActiveSession()).toBeTruthy();

    closeSignaling();

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(getActiveSession()).toBeNull();
    expect(getSignalingHealth().connected).toBe(false);
  });
});
