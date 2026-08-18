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

describe('graceful signaling disconnect', () => {
  afterEach(() => {
    try { signaling.closeSignaling(); } catch (e) {}
    signaling.setOnMessage(null);
    signaling.setOnDisconnect(null);
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test.each(['disconnect-request', 'disconnect-ack'])(
    '%s suppresses transient redial when the socket closes during teardown',
    async frameType => {
      jest.useFakeTimers();
      const sockets = [];
      TcpSocket.createConnection.mockImplementation((options, callback) => {
        const socket = makeSocket(options.host);
        sockets.push(socket);
        setTimeout(callback, 0);
        return socket;
      });

      const connect = signaling.connectToSignalingServer('192.168.0.36', 8089, 1, 1);
      jest.advanceTimersByTime(0);
      await flushMicrotasks();
      await connect;

      expect(signaling.sendSignalingMessage({ type: frameType })).toBe(true);
      expect(signaling.getSignalingHealth().gracefulDisconnectPending).toBe(true);

      sockets[0].emit('close');
      await flushMicrotasks();

      expect(sockets).toHaveLength(1);
      expect(signaling.getSignalingHealth().connected).toBe(false);
      expect(signaling.getSignalingHealth().recoveryInProgress).toBe(false);
      expect(signaling.getSignalingHealth().gracefulDisconnectPending).toBe(false);
    }
  );
});
