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
import { NativeModules } from 'react-native';
import {
  MAX_SIGNALING_BUFFER_BYTES,
  SIGNALING_HEARTBEAT_INTERVAL_MS,
  SIGNALING_HEARTBEAT_TIMEOUT_MS,
  SIGNALING_RECOVERY_GRACE_MS,
  createSignalingServer,
  startPersistentListener,
  connectToSignalingServer,
  getDefaultListener,
  getActivePeerAddress,
  getSignalingHealth,
  isSameSignalingEndpoint,
  setOnMessage,
  setOnDisconnect,
  closeSignaling,
} from '../src/webrtc/signaling';

function makeSocket(remoteAddress = null, localAddress = null) {
  const handlers = {};
  return {
    remoteAddress,
    localAddress,
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
}

describe('signaling resource limits', () => {
  let onConnection;

  beforeEach(() => {
    TcpSocket.createServer.mockImplementation(callback => {
      onConnection = callback;
      return {
        listen: jest.fn((_, callback) => callback()),
        on: jest.fn(),
        close: jest.fn(),
      };
    });
    NativeModules.DirectConnectionModule.getLocalIpAddress.mockResolvedValue(null);
  });

  afterEach(() => {
    closeSignaling();
    getDefaultListener().stop();
    setOnMessage(null);
    setOnDisconnect(null);
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('normalizes signaling endpoints before comparing session ownership', () => {
    expect(isSameSignalingEndpoint('::ffff:192.168.0.36', '192.168.0.36')).toBe(true);
    expect(isSameSignalingEndpoint('[fe80::1]', 'fe80::1')).toBe(true);
    expect(isSameSignalingEndpoint('192.168.0.36', '192.168.0.55')).toBe(false);
  });

  test('closes a peer that sends an unterminated oversized signaling buffer', async () => {
    const received = jest.fn();
    setOnMessage(received);
    await createSignalingServer(8089);
    const socket = makeSocket();
    onConnection(socket);

    socket.emit('data', {
      length: MAX_SIGNALING_BUFFER_BYTES + 1,
      toString: () => 'x'.repeat(MAX_SIGNALING_BUFFER_BYTES + 1),
    });

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(received).not.toHaveBeenCalled();
  });

  test('handles bounded heartbeat frames internally without leaking them to application handlers', async () => {
    const received = jest.fn();
    setOnMessage(received);
    await createSignalingServer(8089);
    const socket = makeSocket();
    onConnection(socket);

    socket.emit('data', { length: 17, toString: () => '{"type":"ping"}\n' });

    expect(socket.destroy).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"type":"pong"'));
  });

  test('closes a completed signaling message larger than the limit', async () => {
    const received = jest.fn();
    setOnMessage(received);
    await createSignalingServer(8089);
    const socket = makeSocket();
    onConnection(socket);

    const message = `{"type":"ping","payload":"${'x'.repeat(MAX_SIGNALING_BUFFER_BYTES)}"}\n`;
    socket.emit('data', { length: message.length, toString: () => message });

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(received).not.toHaveBeenCalled();
  });

  test('accepts a completed application signaling message exactly at the limit', async () => {
    const received = jest.fn();
    setOnMessage(received);
    await createSignalingServer(8089);
    const socket = makeSocket();
    onConnection(socket);

    const prefix = '{"type":"chat","payload":"';
    const suffix = '"}';
    const message = `${prefix}${'x'.repeat(MAX_SIGNALING_BUFFER_BYTES - prefix.length - suffix.length)}${suffix}\n`;
    socket.emit('data', { length: message.length, toString: () => message });

    expect(socket.destroy).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledTimes(1);
  });

  test('accepts several bounded application messages received in one TCP data event', async () => {
    const received = jest.fn();
    setOnMessage(received);
    await createSignalingServer(8089);
    const socket = makeSocket();
    onConnection(socket);

    const message = '{"type":"chat","text":"x"}\n';
    socket.emit('data', {
      length: message.length * 5000,
      toString: () => message.repeat(5000),
    });

    expect(socket.destroy).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledTimes(5000);
  });

  test('persistent listener rejects a duplicate inbound socket without destroying the healthy session', async () => {
    await startPersistentListener(8089);

    const first = makeSocket();
    onConnection(first);
    expect(first.destroy).not.toHaveBeenCalled();

    const duplicate = makeSocket();
    onConnection(duplicate);

    expect(first.destroy).not.toHaveBeenCalled();
    expect(duplicate.destroy).toHaveBeenCalledTimes(1);
  });

  test('Wi-Fi Direct server mode reuses the persistent listener instead of binding port 8089 twice', async () => {
    await startPersistentListener(8089);
    expect(TcpSocket.createServer).toHaveBeenCalledTimes(1);

    await createSignalingServer(8089);

    expect(TcpSocket.createServer).toHaveBeenCalledTimes(1);
    expect(getDefaultListener().getStatus().isListening).toBe(true);
  });

  test('exposes the active socket remote address for file-transfer routing', async () => {
    await startPersistentListener(8089);
    const socket = makeSocket('::ffff:192.168.0.36');
    onConnection(socket);

    expect(getActivePeerAddress()).toBe('192.168.0.36');
  });

  test('announces the local route from every accepted signaling session', async () => {
    await startPersistentListener(8089);
    const socket = makeSocket('192.168.0.36', '::ffff:192.168.0.182');
    onConnection(socket);
    await flushMicrotasks();

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"type":"my-ip"'));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('192.168.0.182'));
    expect(NativeModules.ServiceModule.startConnectionService).toHaveBeenCalled();
  });

  test('falls back to native local IP lookup when socket localAddress is unavailable', async () => {
    NativeModules.DirectConnectionModule.getLocalIpAddress.mockResolvedValue('192.168.49.40');
    await startPersistentListener(8089);
    const socket = makeSocket('192.168.49.1', null);
    onConnection(socket);
    await flushMicrotasks();

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('192.168.49.40'));
  });

  test('enables TCP keepalive and no-delay on long-lived signaling sockets', async () => {
    await startPersistentListener(8089);
    const socket = makeSocket('192.168.0.36');
    onConnection(socket);

    expect(socket.setKeepAlive).toHaveBeenCalledWith(true, 5000);
    expect(socket.setNoDelay).toHaveBeenCalledWith(true);
  });

  test('sends heartbeat pings and keeps health state active', async () => {
    jest.useFakeTimers();
    await startPersistentListener(8089);
    const socket = makeSocket('192.168.0.36');
    onConnection(socket);

    expect(getSignalingHealth().heartbeatRunning).toBe(true);
    jest.advanceTimersByTime(SIGNALING_HEARTBEAT_INTERVAL_MS);

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"type":"ping"'));
  });

  test('destroys a silent signaling session after the heartbeat timeout and opens recovery grace', async () => {
    jest.useFakeTimers();
    await startPersistentListener(8089);
    const socket = makeSocket('192.168.0.36');
    onConnection(socket);

    jest.advanceTimersByTime(SIGNALING_HEARTBEAT_TIMEOUT_MS + SIGNALING_HEARTBEAT_INTERVAL_MS);

    expect(socket.destroy).toHaveBeenCalled();
    expect(getSignalingHealth().connected).toBe(false);
    expect(getSignalingHealth().recoveryInProgress).toBe(true);
  });

  test('does not notify UI when an inbound peer redials within the recovery grace', async () => {
    jest.useFakeTimers();
    const disconnected = jest.fn();
    setOnDisconnect(disconnected);
    await startPersistentListener(8089);

    const first = makeSocket('192.168.0.36');
    onConnection(first);
    first.emit('close');

    expect(getSignalingHealth().recoveryInProgress).toBe(true);
    expect(disconnected).not.toHaveBeenCalled();

    const replacement = makeSocket('192.168.0.36');
    onConnection(replacement);
    jest.advanceTimersByTime(SIGNALING_RECOVERY_GRACE_MS + 100);

    expect(getSignalingHealth().connected).toBe(true);
    expect(getSignalingHealth().recoveryInProgress).toBe(false);
    expect(disconnected).not.toHaveBeenCalled();
  });

  test('notifies UI only after an inbound recovery grace expires', async () => {
    jest.useFakeTimers();
    const disconnected = jest.fn();
    setOnDisconnect(disconnected);
    await startPersistentListener(8089);

    const socket = makeSocket('192.168.0.36');
    onConnection(socket);
    socket.emit('close');

    jest.advanceTimersByTime(SIGNALING_RECOVERY_GRACE_MS - 1);
    expect(disconnected).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  test('reuses a healthy session only for the same peer endpoint', async () => {
    jest.useFakeTimers();
    const sockets = [];
    TcpSocket.createConnection.mockImplementation((options, callback) => {
      const socket = makeSocket(options.host);
      sockets.push(socket);
      setTimeout(callback, 0);
      return socket;
    });

    const initialConnect = connectToSignalingServer('192.168.0.36', 8089, 1, 1);
    jest.advanceTimersByTime(0);
    await flushMicrotasks();
    await initialConnect;

    await expect(connectToSignalingServer('::ffff:192.168.0.36', 8089, 1, 1)).resolves.toBeUndefined();
    expect(sockets).toHaveLength(1);

    await expect(connectToSignalingServer('192.168.0.55', 8089, 1, 1)).rejects.toThrow('يوجد اتصال نشط مع جهاز آخر');
    expect(sockets).toHaveLength(1);
    expect(getActivePeerAddress()).toBe('192.168.0.36');
    expect(sockets[0].destroy).not.toHaveBeenCalled();
  });

  test('outbound peer transparently redials the same endpoint after transient loss', async () => {
    jest.useFakeTimers();
    const disconnected = jest.fn();
    setOnDisconnect(disconnected);
    const sockets = [];

    TcpSocket.createConnection.mockImplementation((options, callback) => {
      const socket = makeSocket(options.host);
      sockets.push(socket);
      setTimeout(callback, 0);
      return socket;
    });

    const initialConnect = connectToSignalingServer('192.168.0.36', 8089, 1, 1);
    jest.advanceTimersByTime(0);
    await flushMicrotasks();
    await initialConnect;

    expect(sockets).toHaveLength(1);
    sockets[0].emit('close');
    expect(getSignalingHealth().recoveryInProgress).toBe(true);

    jest.advanceTimersByTime(0);
    await flushMicrotasks();

    expect(sockets).toHaveLength(2);
    expect(getSignalingHealth().connected).toBe(true);
    expect(getActivePeerAddress()).toBe('192.168.0.36');
    expect(disconnected).not.toHaveBeenCalled();
  });
});
