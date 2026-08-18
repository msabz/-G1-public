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
  cancelSignalingConnectAttempt,
  closeSignaling,
  connectToSignalingServer,
  getActivePeerAddress,
  getActiveSession,
  getDefaultListener,
  getSignalingHealth,
  setOnDisconnect,
  startPersistentListener,
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

describe('signaling connect-attempt cancellation', () => {
  let onServerConnection;

  beforeEach(() => {
    TcpSocket.createServer.mockImplementation(callback => {
      onServerConnection = callback;
      return {
        listen: jest.fn((_, callback) => callback()),
        on: jest.fn(),
        close: jest.fn(),
      };
    });
  });

  afterEach(() => {
    closeSignaling();
    getDefaultListener().stop();
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

  test('closeSignaling also destroys a healthy active session, so it remains a full-close operation', async () => {
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

  test('connect-only cancellation settles a pending attempt and suppresses a late socket', async () => {
    const socket = makeSocket();
    let onConnect;
    TcpSocket.createConnection.mockImplementation((_options, callback) => {
      onConnect = callback;
      return socket;
    });

    const attempt = connectToSignalingServer('192.168.0.36', 8089, 1, 1);
    await flushMicrotasks();

    expect(cancelSignalingConnectAttempt()).toBe(true);
    await expect(attempt).rejects.toThrow('أُلغيت محاولة الاتصال بقناة الإشارات');
    expect(cancelSignalingConnectAttempt()).toBe(false);

    onConnect();
    await flushMicrotasks();

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(getActiveSession()).toBeNull();
  });

  test('cancelling an obsolete outbound attempt preserves an inbound session that wins the race', async () => {
    const disconnected = jest.fn();
    setOnDisconnect(disconnected);
    await startPersistentListener(8089);

    const outboundSocket = makeSocket('192.168.0.36');
    let onOutboundConnect;
    TcpSocket.createConnection.mockImplementation((_options, callback) => {
      onOutboundConnect = callback;
      return outboundSocket;
    });

    const attempt = connectToSignalingServer('192.168.0.36', 8089, 1, 1);
    await flushMicrotasks();

    const inboundSocket = makeSocket('192.168.0.55');
    onServerConnection(inboundSocket);
    await flushMicrotasks();

    expect(getSignalingHealth().connected).toBe(true);
    expect(getActivePeerAddress()).toBe('192.168.0.55');
    expect(inboundSocket.destroy).not.toHaveBeenCalled();

    expect(cancelSignalingConnectAttempt()).toBe(true);
    await expect(attempt).rejects.toThrow('أُلغيت محاولة الاتصال بقناة الإشارات');

    expect(getActiveSession()?.socket).toBe(inboundSocket);
    expect(getSignalingHealth().connected).toBe(true);
    expect(inboundSocket.destroy).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();

    onOutboundConnect();
    await flushMicrotasks();

    expect(outboundSocket.destroy).toHaveBeenCalledTimes(1);
    expect(getActiveSession()?.socket).toBe(inboundSocket);
    expect(getSignalingHealth().connected).toBe(true);
    expect(disconnected).not.toHaveBeenCalled();
  });
});
