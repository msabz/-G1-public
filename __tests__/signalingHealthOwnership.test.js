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

function emitJson(socket, message) {
  const payload = JSON.stringify(message) + '\n';
  socket.emit('data', { length: payload.length, toString: () => payload });
}

describe('signaling health exposes session ownership needed by App promotion', () => {
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
    try { signaling.setPassiveInboundAdmissionHandler(null); } catch (e) {}
    signaling.setOnMessage(null);
    jest.clearAllMocks();
  });

  test('reports an admitted passive inbound session explicitly', async () => {
    signaling.setPassiveInboundAdmissionHandler(() => ({
      accepted: true,
      peerId: 'peer-1',
      transport: 'LAN',
    }));
    await signaling.startPersistentListener(8089);

    const socket = makeSocket('::ffff:192.168.0.36');
    onConnection(socket);
    emitJson(socket, { type: 'identity', deviceId: 'peer-1' });

    expect(signaling.getSignalingHealth()).toEqual(expect.objectContaining({
      connected: true,
      peerAddress: '192.168.0.36',
      direction: 'inbound',
      passiveAdmissionAccepted: true,
    }));
  });
});
