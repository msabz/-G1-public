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

const TcpSocket = require('react-native-tcp-socket');
const signaling = require('../src/webrtc/signaling');

function makeSocket(remoteAddress = '192.168.0.36') {
  const handlers = {};
  return {
    remoteAddress,
    localAddress: null,
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

describe('outbound signaling identity replay', () => {
  afterEach(() => {
    try { signaling.closeSignaling(); } catch (e) {}
    signaling.setOnMessage(null);
    signaling.setOnDisconnect(null);
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('replays the last stable identity immediately on a transient outbound redial', async () => {
    jest.useFakeTimers();
    const sockets = [];
    TcpSocket.createConnection.mockImplementation((options, callback) => {
      const socket = makeSocket(options.host);
      sockets.push(socket);
      setTimeout(callback, 0);
      return socket;
    });

    const initialConnect = signaling.connectToSignalingServer('192.168.0.36', 8089, 1, 1);
    jest.advanceTimersByTime(0);
    await flushMicrotasks();
    await initialConnect;

    const identity = {
      type: 'identity',
      deviceId: 'local-device',
      deviceName: 'Local Device',
    };
    expect(signaling.sendSignalingMessage(identity)).toBe(true);
    expect(sockets[0].write).toHaveBeenCalledWith(`${JSON.stringify(identity)}\n`);

    sockets[0].emit('close');
    expect(signaling.getSignalingHealth().recoveryInProgress).toBe(true);

    jest.advanceTimersByTime(0);
    await flushMicrotasks();

    expect(sockets).toHaveLength(2);
    expect(signaling.getSignalingHealth().connected).toBe(true);
    expect(sockets[1].write).toHaveBeenCalledWith(`${JSON.stringify(identity)}\n`);
  });

  test('keeps explicit App identity sends idempotent after automatic replay', async () => {
    jest.useFakeTimers();
    const sockets = [];
    TcpSocket.createConnection.mockImplementation((options, callback) => {
      const socket = makeSocket(options.host);
      sockets.push(socket);
      setTimeout(callback, 0);
      return socket;
    });

    const first = signaling.connectToSignalingServer('192.168.0.36', 8089, 1, 1);
    jest.advanceTimersByTime(0);
    await flushMicrotasks();
    await first;

    const identity = { type: 'identity', deviceId: 'local-device', deviceName: 'Local Device' };
    signaling.sendSignalingMessage(identity);
    signaling.closeSignaling();

    const second = signaling.connectToSignalingServer('192.168.0.55', 8089, 1, 1);
    jest.advanceTimersByTime(0);
    await flushMicrotasks();
    await second;

    const identityWritesBeforeExplicitSend = sockets[1].write.mock.calls
      .map(call => call[0])
      .filter(payload => payload.includes('"type":"identity"')).length;
    expect(identityWritesBeforeExplicitSend).toBe(1);

    expect(signaling.sendSignalingMessage(identity)).toBe(true);
    const identityWritesAfterExplicitSend = sockets[1].write.mock.calls
      .map(call => call[0])
      .filter(payload => payload.includes('"type":"identity"')).length;
    expect(identityWritesAfterExplicitSend).toBe(1);
  });
});
