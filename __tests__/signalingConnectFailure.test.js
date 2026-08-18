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
import { closeSignaling, connectToSignalingServer } from '../src/webrtc/signaling';

function makeSocket() {
  const handlers = {};
  return {
    on: jest.fn((event, callback) => { handlers[event] = callback; }),
    once: jest.fn((event, callback) => { handlers[event] = callback; }),
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

describe('initial signaling connection failure', () => {
  afterEach(() => {
    closeSignaling();
    jest.clearAllMocks();
  });

  test('rejects after the outbound socket exhausts retries instead of remaining pending', async () => {
    const socket = makeSocket();
    TcpSocket.createConnection.mockImplementation(() => socket);

    const error = new Error('ECONNREFUSED');
    const rejected = jest.fn();
    connectToSignalingServer('192.168.0.36', 8089, 1, 1).catch(rejected);

    socket.emit('error', error);
    await flushMicrotasks();

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveBeenCalledWith(error);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
});
