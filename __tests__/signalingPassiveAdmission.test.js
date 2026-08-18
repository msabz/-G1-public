jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

jest.mock('react-native', () => ({
  NativeModules: {
    DirectConnectionModule: {
      getLocalIpAddress: jest.fn().mockResolvedValue('192.168.0.182'),
    },
    ServiceModule: {
      startAvailabilityService: jest.fn().mockResolvedValue(true),
      startConnectionService: jest.fn().mockResolvedValue(true),
      updateConnectionStatus: jest.fn().mockResolvedValue(true),
    },
  },
}));

const TcpSocket = require('react-native-tcp-socket');
const signaling = require('../src/webrtc/signaling');

function makeSocket(remoteAddress = '192.168.0.36', localAddress = '192.168.0.182') {
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

function emitJson(socket, message) {
  const payload = JSON.stringify(message) + '\n';
  socket.emit('data', {
    length: payload.length,
    toString: () => payload,
  });
}

describe('passive inbound signaling admission', () => {
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
  });

  afterEach(() => {
    try { signaling.closeSignaling(); } catch (e) {}
    try { signaling.getDefaultListener().stop(); } catch (e) {}
    try { signaling.setPassiveInboundAdmissionHandler?.(null); } catch (e) {}
    signaling.setOnMessage(null);
    signaling.setOnDisconnect(null);
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('rejects passive application messages before identity admission', async () => {
    const validator = jest.fn(() => ({ accepted: true }));
    const received = jest.fn();
    signaling.setPassiveInboundAdmissionHandler(validator);
    signaling.setOnMessage(received);
    await signaling.startPersistentListener(8089);

    const socket = makeSocket();
    onConnection(socket);
    emitJson(socket, { type: 'call-request', video: false });

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(received).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
  });

  test('consumes pre-identity route metadata, admits identity synchronously, then dispatches application messages', async () => {
    const validator = jest.fn(() => ({ accepted: true, peerId: 'peer-1', transport: 'LAN' }));
    const received = jest.fn();
    signaling.setPassiveInboundAdmissionHandler(validator);
    signaling.setOnMessage(received);
    await signaling.startPersistentListener(8089);

    const socket = makeSocket('::ffff:192.168.0.36');
    onConnection(socket);

    emitJson(socket, { type: 'my-ip', ip: '192.168.0.36' });
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();

    const identity = { type: 'identity', deviceId: 'peer-1', deviceName: 'Peer One' };
    emitJson(socket, identity);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledWith(expect.objectContaining({
      message: identity,
      peerAddress: '192.168.0.36',
    }));
    expect(received).toHaveBeenCalledWith(identity);

    const chat = { type: 'chat', text: 'hello' };
    emitJson(socket, chat);
    expect(received).toHaveBeenCalledWith(chat);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  test('rejects an identity that fails passive admission validation', async () => {
    const validator = jest.fn(() => ({ accepted: false, reason: 'route-mismatch' }));
    const received = jest.fn();
    signaling.setPassiveInboundAdmissionHandler(validator);
    signaling.setOnMessage(received);
    await signaling.startPersistentListener(8089);

    const socket = makeSocket();
    onConnection(socket);
    emitJson(socket, { type: 'identity', deviceId: 'spoofed-peer' });

    expect(validator).toHaveBeenCalledTimes(1);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(received).not.toHaveBeenCalled();
    expect(signaling.getSignalingHealth().connected).toBe(false);
  });

  test('expires a silent unadmitted passive session without opening recovery or notifying UI', async () => {
    jest.useFakeTimers();
    const validator = jest.fn(() => ({ accepted: true }));
    const disconnected = jest.fn();
    signaling.setPassiveInboundAdmissionHandler(validator);
    signaling.setOnDisconnect(disconnected);
    await signaling.startPersistentListener(8089);

    const socket = makeSocket();
    onConnection(socket);
    jest.advanceTimersByTime(signaling.PASSIVE_INBOUND_IDENTITY_TIMEOUT_MS);

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(validator).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
    expect(signaling.getSignalingHealth().connected).toBe(false);
    expect(signaling.getSignalingHealth().recoveryInProgress).toBe(false);
  });

  test('does not apply passive LAN admission to explicit server mode used by Wi-Fi Direct', async () => {
    const validator = jest.fn(() => ({ accepted: false }));
    const received = jest.fn();
    signaling.setPassiveInboundAdmissionHandler(validator);
    signaling.setOnMessage(received);
    await signaling.createSignalingServer(8089);

    const socket = makeSocket('192.168.49.20', '192.168.49.1');
    onConnection(socket);
    const call = { type: 'call-request', video: true };
    emitJson(socket, call);

    expect(validator).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledWith(call);
  });

  test('preserves admission across same-endpoint inbound transient recovery', async () => {
    jest.useFakeTimers();
    const validator = jest.fn(() => ({ accepted: true, peerId: 'peer-1', transport: 'LAN' }));
    const received = jest.fn();
    signaling.setPassiveInboundAdmissionHandler(validator);
    signaling.setOnMessage(received);
    await signaling.startPersistentListener(8089);

    const first = makeSocket('192.168.0.36');
    onConnection(first);
    emitJson(first, { type: 'identity', deviceId: 'peer-1' });
    expect(validator).toHaveBeenCalledTimes(1);

    first.emit('close');
    expect(signaling.getSignalingHealth().recoveryInProgress).toBe(true);

    const replacement = makeSocket('::ffff:192.168.0.36');
    onConnection(replacement);
    expect(signaling.getSignalingHealth().connected).toBe(true);
    expect(signaling.getSignalingHealth().recoveryInProgress).toBe(false);

    const chat = { type: 'chat', text: 'after-redial' };
    emitJson(replacement, chat);
    expect(received).toHaveBeenCalledWith(chat);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(replacement.destroy).not.toHaveBeenCalled();
  });
});
