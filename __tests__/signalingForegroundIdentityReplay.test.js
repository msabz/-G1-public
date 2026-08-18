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
  const handlers = new Map();
  const add = (event, callback) => {
    const list = handlers.get(event) || [];
    list.push(callback);
    handlers.set(event, list);
  };
  const remove = (event, callback) => {
    const list = handlers.get(event) || [];
    handlers.set(event, list.filter(item => item !== callback));
  };
  return {
    remoteAddress,
    localAddress: null,
    on: jest.fn((event, callback) => add(event, callback)),
    once: jest.fn((event, callback) => {
      const wrapper = value => {
        remove(event, wrapper);
        callback(value);
      };
      add(event, wrapper);
    }),
    removeListener: jest.fn((event, callback) => remove(event, callback)),
    emit: (event, value) => {
      const list = [...(handlers.get(event) || [])];
      list.forEach(callback => callback(value));
    },
    write: jest.fn(),
    setKeepAlive: jest.fn(),
    setNoDelay: jest.fn(),
    destroy: jest.fn(),
  };
}

function emitJson(socket, message) {
  const payload = `${JSON.stringify(message)}\n`;
  socket.emit('data', {
    length: payload.length,
    toString: () => payload,
  });
}

describe('foreground rebind of an admitted passive LAN session', () => {
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
    signaling.setPassiveInboundAdmissionHandler(null);
    signaling.setOnMessage(null);
    signaling.setOnDisconnect(null);
    jest.clearAllMocks();
  });

  test('replays only the validated passive identity when App installs a new message callback', async () => {
    signaling.setPassiveInboundAdmissionHandler(({ message }) => ({
      accepted: true,
      peerId: message.deviceId,
      transport: 'LAN',
    }));

    const firstAppMessages = [];
    const firstCallback = message => firstAppMessages.push(message);
    signaling.setOnMessage(firstCallback);

    await signaling.startPersistentListener(8089);
    const inbound = makeSocket('192.168.0.36');
    onConnection(inbound);

    const identity = {
      type: 'identity',
      deviceId: 'peer-device',
      deviceName: 'Peer Device',
    };
    emitJson(inbound, identity);

    expect(signaling.getSignalingHealth()).toEqual(expect.objectContaining({
      connected: true,
      direction: 'inbound',
      passiveAdmissionRequired: true,
      passiveAdmissionAccepted: true,
    }));
    expect(firstAppMessages).toEqual([identity]);

    const remountedCallback = jest.fn();
    signaling.setOnMessage(remountedCallback);

    expect(remountedCallback).toHaveBeenCalledTimes(1);
    expect(remountedCallback).toHaveBeenCalledWith(identity);
    expect(inbound.write).not.toHaveBeenCalledWith(`${JSON.stringify(identity)}\n`);

    remountedCallback.mockClear();
    signaling.setOnMessage(remountedCallback);
    expect(remountedCallback).not.toHaveBeenCalled();
  });

  test('does not replay arbitrary application frames during callback replacement', async () => {
    signaling.setPassiveInboundAdmissionHandler(({ message }) => ({
      accepted: true,
      peerId: message.deviceId,
      transport: 'LAN',
    }));

    const firstCallback = jest.fn();
    signaling.setOnMessage(firstCallback);

    await signaling.startPersistentListener(8089);
    const inbound = makeSocket('192.168.0.36');
    onConnection(inbound);

    emitJson(inbound, {
      type: 'identity',
      deviceId: 'peer-device',
      deviceName: 'Peer Device',
    });
    emitJson(inbound, { type: 'chat', text: 'background-message' });

    const remountedCallback = jest.fn();
    signaling.setOnMessage(remountedCallback);

    expect(remountedCallback).toHaveBeenCalledTimes(1);
    expect(remountedCallback).toHaveBeenCalledWith(expect.objectContaining({
      type: 'identity',
      deviceId: 'peer-device',
    }));
    expect(remountedCallback).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat',
      text: 'background-message',
    }));
  });
});
