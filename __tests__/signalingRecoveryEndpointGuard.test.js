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
  SIGNALING_RECOVERY_GRACE_MS,
  closeSignaling,
  getDefaultListener,
  getSignalingHealth,
  startPersistentListener,
} from '../src/webrtc/signaling';

function makeSocket(remoteAddress) {
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

describe('signaling inbound recovery endpoint ownership', () => {
  let onConnection;

  beforeEach(() => {
    jest.useFakeTimers();
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
    closeSignaling();
    getDefaultListener().stop();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('rejects a different endpoint racing an inbound recovery and still accepts the original endpoint', async () => {
    await startPersistentListener(8089);

    const original = makeSocket('192.168.0.36');
    onConnection(original);
    expect(getSignalingHealth().connected).toBe(true);

    original.emit('close');
    expect(getSignalingHealth().connected).toBe(false);
    expect(getSignalingHealth().recoveryInProgress).toBe(true);

    const intruder = makeSocket('192.168.0.55');
    onConnection(intruder);

    expect(intruder.destroy).toHaveBeenCalledTimes(1);
    expect(getSignalingHealth().connected).toBe(false);
    expect(getSignalingHealth().recoveryInProgress).toBe(true);

    const legitimateRedial = makeSocket('::ffff:192.168.0.36');
    onConnection(legitimateRedial);

    expect(legitimateRedial.destroy).not.toHaveBeenCalled();
    expect(getSignalingHealth().connected).toBe(true);
    expect(getSignalingHealth().peerAddress).toBe('192.168.0.36');
    expect(getSignalingHealth().recoveryInProgress).toBe(false);

    jest.advanceTimersByTime(SIGNALING_RECOVERY_GRACE_MS + 100);
    expect(getSignalingHealth().connected).toBe(true);
  });
});
