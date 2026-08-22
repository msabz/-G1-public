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

function emitRaw(socket, payload) {
  socket.emit('data', {
    length: payload.length,
    toString: () => payload,
  });
}

function emitJson(socket, message) {
  emitJsonBatch(socket, [message]);
}

function emitJsonBatch(socket, messages) {
  emitRaw(socket, messages.map(message => JSON.stringify(message)).join('\n') + '\n');
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('stable-identity simultaneous LAN arbitration', () => {
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
    try { signaling.closeSignaling(); } catch (e) {}
    try { signaling.getDefaultListener().stop(); } catch (e) {}
    signaling.setPassiveInboundAdmissionHandler(null);
    signaling.setOnMessage(null);
    signaling.setOnDisconnect(null);
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  async function establishOutbound() {
    const outbound = makeSocket('192.168.0.36');
    TcpSocket.createConnection.mockImplementation((options, callback) => {
      setTimeout(callback, 0);
      return outbound;
    });
    await signaling.startPersistentListener(8089);
    const connect = signaling.connectToSignalingServer('192.168.0.36', 8089, 1, 1);
    jest.advanceTimersByTime(0);
    await flushMicrotasks();
    await connect;
    expect(signaling.getSignalingHealth().direction).toBe('outbound');
    return outbound;
  }

  test('yields outbound and promotes validated inbound when stable-id policy prefers inbound', async () => {
    const validator = jest.fn(({ message }) => ({
      accepted: true,
      peerId: message.deviceId,
      transport: 'LAN',
      preferInbound: true,
    }));
    signaling.setPassiveInboundAdmissionHandler(validator);

    const outbound = await establishOutbound();
    const inbound = makeSocket('192.168.0.36');
    onConnection(inbound);

    expect(outbound.destroy).not.toHaveBeenCalled();
    expect(inbound.destroy).not.toHaveBeenCalled();

    emitJson(inbound, { type: 'my-ip', ip: '192.168.0.36' });
    emitJson(inbound, { type: 'identity', deviceId: 'peer-device', deviceName: 'Peer' });

    expect(outbound.destroy).toHaveBeenCalledTimes(1);
    expect(inbound.destroy).not.toHaveBeenCalled();
    expect(signaling.getSignalingHealth().connected).toBe(true);
    expect(signaling.getSignalingHealth().direction).toBe('inbound');
    expect(signaling.getSignalingHealth().passiveAdmissionAccepted).toBe(true);
    expect(validator).toHaveBeenCalledTimes(2);
    expect(validator.mock.calls[0][0]).toEqual(expect.objectContaining({ validateOnly: true }));
    expect(validator.mock.calls[1][0]).not.toHaveProperty('validateOnly');
    expect(validator.mock.calls[1][0]).toEqual(expect.objectContaining({
      message: expect.objectContaining({ deviceId: 'peer-device' }),
      session: expect.objectContaining({ isOutbound: false }),
    }));
  });

  test('preserves application frames coalesced after identity on the winning inbound socket', async () => {
    const validator = jest.fn(({ message }) => ({
      accepted: true,
      peerId: message.deviceId,
      transport: 'LAN',
      preferInbound: true,
    }));
    const received = [];
    signaling.setPassiveInboundAdmissionHandler(validator);
    signaling.setOnMessage(message => received.push(message));

    const outbound = await establishOutbound();
    const inbound = makeSocket('192.168.0.36');
    onConnection(inbound);

    emitJsonBatch(inbound, [
      { type: 'identity', deviceId: 'peer-device', deviceName: 'Peer' },
      { type: 'chat', text: 'same-read-frame' },
    ]);

    expect(outbound.destroy).toHaveBeenCalledTimes(1);
    expect(signaling.getSignalingHealth().direction).toBe('inbound');
    expect(received).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'identity', deviceId: 'peer-device' }),
      expect.objectContaining({ type: 'chat', text: 'same-read-frame' }),
    ]));
  });

  test('preserves a partial trailing frame across promotion and completes it on the next TCP read', async () => {
    const validator = jest.fn(({ message }) => ({
      accepted: true,
      peerId: message.deviceId,
      transport: 'LAN',
      preferInbound: true,
    }));
    const received = [];
    signaling.setPassiveInboundAdmissionHandler(validator);
    signaling.setOnMessage(message => received.push(message));

    const outbound = await establishOutbound();
    const inbound = makeSocket('192.168.0.36');
    onConnection(inbound);

    const identity = JSON.stringify({ type: 'identity', deviceId: 'peer-device', deviceName: 'Peer' });
    const chat = JSON.stringify({ type: 'chat', text: 'segmented-frame' });
    const splitAt = Math.floor(chat.length / 2);

    emitRaw(inbound, `${identity}\n${chat.slice(0, splitAt)}`);

    expect(outbound.destroy).toHaveBeenCalledTimes(1);
    expect(signaling.getSignalingHealth().direction).toBe('inbound');
    expect(received).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'identity', deviceId: 'peer-device' }),
    ]));
    expect(received).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'chat', text: 'segmented-frame' }),
    ]));

    emitRaw(inbound, `${chat.slice(splitAt)}\n`);

    expect(received).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'chat', text: 'segmented-frame' }),
    ]));
  });

  test('does not let a different LAN peer replace the active outbound session', async () => {
    const validator = jest.fn(({ message }) => ({
      accepted: true,
      peerId: message.deviceId,
      transport: 'LAN',
      preferInbound: true,
    }));
    signaling.setPassiveInboundAdmissionHandler(validator);

    const outbound = await establishOutbound();
    const intruder = makeSocket('192.168.0.55');
    onConnection(intruder);
    emitJson(intruder, { type: 'identity', deviceId: 'other-peer', deviceName: 'Other' });

    expect(intruder.destroy).toHaveBeenCalledTimes(1);
    expect(outbound.destroy).not.toHaveBeenCalled();
    expect(signaling.getSignalingHealth().connected).toBe(true);
    expect(signaling.getSignalingHealth().direction).toBe('outbound');
    expect(signaling.getSignalingHealth().peerAddress).toBe('192.168.0.36');
  });

  test('allows only one provisional duplicate inbound inspection at a time', async () => {
    const validator = jest.fn(({ message }) => ({
      accepted: true,
      peerId: message.deviceId,
      transport: 'LAN',
      preferInbound: true,
    }));
    signaling.setPassiveInboundAdmissionHandler(validator);

    const outbound = await establishOutbound();
    const firstInbound = makeSocket('192.168.0.36');
    const secondInbound = makeSocket('192.168.0.36');
    onConnection(firstInbound);
    onConnection(secondInbound);

    expect(secondInbound.destroy).toHaveBeenCalledTimes(1);
    expect(firstInbound.destroy).not.toHaveBeenCalled();

    emitJson(firstInbound, { type: 'identity', deviceId: 'peer-device', deviceName: 'Peer' });

    expect(outbound.destroy).toHaveBeenCalledTimes(1);
    expect(signaling.getSignalingHealth().direction).toBe('inbound');
  });

  test('keeps a simultaneous inbound candidate until asymmetric LAN discovery catches up', async () => {
    let routeKnown = false;
    const validator = jest.fn(({ message, validateOnly }) => {
      if (!routeKnown) {
        return { accepted: false, pending: true, reason: 'awaiting-lan-discovery' };
      }
      return {
        accepted: true,
        peerId: message.deviceId,
        transport: 'LAN',
        ...(validateOnly ? { preferInbound: true } : {}),
      };
    });
    signaling.setPassiveInboundAdmissionHandler(validator);

    const outbound = await establishOutbound();
    const inbound = makeSocket('192.168.0.36');
    onConnection(inbound);
    emitJson(inbound, { type: 'identity', deviceId: 'peer-device', deviceName: 'Peer' });

    expect(inbound.destroy).not.toHaveBeenCalled();
    expect(outbound.destroy).not.toHaveBeenCalled();
    expect(signaling.getSignalingHealth().direction).toBe('outbound');

    routeKnown = true;
    jest.advanceTimersByTime(signaling.PASSIVE_INBOUND_ADMISSION_RETRY_MS);

    expect(validator).toHaveBeenCalledTimes(3);
    expect(validator.mock.calls[0][0]).toEqual(expect.objectContaining({ validateOnly: true }));
    expect(validator.mock.calls[1][0]).toEqual(expect.objectContaining({ validateOnly: true }));
    expect(validator.mock.calls[2][0]).not.toHaveProperty('validateOnly');
    expect(outbound.destroy).toHaveBeenCalledTimes(1);
    expect(inbound.destroy).not.toHaveBeenCalled();
    expect(signaling.getSignalingHealth()).toEqual(expect.objectContaining({
      connected: true,
      direction: 'inbound',
      passiveAdmissionAccepted: true,
    }));
  });

  test('rejects a conflicting second identity coalesced with a pending identity', async () => {
    const validator = jest.fn(() => ({
      accepted: false,
      pending: true,
      reason: 'awaiting-lan-discovery',
    }));
    signaling.setPassiveInboundAdmissionHandler(validator);

    const outbound = await establishOutbound();
    const inbound = makeSocket('192.168.0.36');
    onConnection(inbound);
    emitJsonBatch(inbound, [
      { type: 'identity', deviceId: 'peer-a', deviceName: 'Peer A' },
      { type: 'identity', deviceId: 'peer-b', deviceName: 'Peer B' },
    ]);

    expect(inbound.destroy).toHaveBeenCalledTimes(1);
    expect(outbound.destroy).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
    expect(signaling.getSignalingHealth().direction).toBe('outbound');
  });

  test('bounds complete application frames while duplicate admission is pending', async () => {
    const validator = jest.fn(() => ({
      accepted: false,
      pending: true,
      reason: 'awaiting-lan-discovery',
    }));
    signaling.setPassiveInboundAdmissionHandler(validator);

    const outbound = await establishOutbound();
    const inbound = makeSocket('192.168.0.36');
    onConnection(inbound);
    emitJson(inbound, { type: 'identity', deviceId: 'peer-device', deviceName: 'Peer' });
    emitJsonBatch(inbound, Array.from({ length: 17 }, (_, index) => ({
      type: 'chat',
      text: `buffered-${index}`,
    })));

    expect(inbound.destroy).toHaveBeenCalledTimes(1);
    expect(outbound.destroy).not.toHaveBeenCalled();
    expect(signaling.getSignalingHealth().direction).toBe('outbound');
  });

  test('closeSignaling cancels duplicate admission retries even when destroy emits no terminal event', async () => {
    const validator = jest.fn(() => ({
      accepted: false,
      pending: true,
      reason: 'awaiting-lan-discovery',
    }));
    signaling.setPassiveInboundAdmissionHandler(validator);

    await establishOutbound();
    const inbound = makeSocket('192.168.0.36');
    onConnection(inbound);
    emitJson(inbound, { type: 'identity', deviceId: 'peer-device', deviceName: 'Peer' });
    expect(validator).toHaveBeenCalledTimes(1);

    signaling.closeSignaling();
    jest.advanceTimersByTime(signaling.PASSIVE_INBOUND_IDENTITY_TIMEOUT_MS);

    expect(validator).toHaveBeenCalledTimes(1);
    expect(inbound.destroy).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('rolls back to the healthy outbound session when final inbound admission fails', async () => {
    const validator = jest.fn(({ message, validateOnly }) => validateOnly
      ? {
          accepted: true,
          peerId: message.deviceId,
          transport: 'LAN',
          preferInbound: true,
        }
      : {
          accepted: false,
          reason: 'coordinator-rejected',
        });
    signaling.setPassiveInboundAdmissionHandler(validator);

    const outbound = await establishOutbound();
    const inbound = makeSocket('192.168.0.36');
    onConnection(inbound);
    emitJson(inbound, { type: 'identity', deviceId: 'peer-device', deviceName: 'Peer' });

    expect(inbound.destroy).toHaveBeenCalled();
    expect(outbound.destroy).not.toHaveBeenCalled();
    expect(signaling.getSignalingHealth().connected).toBe(true);
    expect(signaling.getSignalingHealth().direction).toBe('outbound');
    expect(signaling.getSignalingHealth().peerAddress).toBe('192.168.0.36');
    expect(signaling.getSignalingHealth().heartbeatRunning).toBe(true);
  });

  test('rejects an oversized UTF-8 frame during provisional inspection', async () => {
    const validator = jest.fn();
    signaling.setPassiveInboundAdmissionHandler(validator);

    const outbound = await establishOutbound();
    const inbound = makeSocket('192.168.0.36');
    onConnection(inbound);
    emitRaw(inbound, `${'ع'.repeat(40 * 1024)}\n`);

    expect(inbound.destroy).toHaveBeenCalledTimes(1);
    expect(outbound.destroy).not.toHaveBeenCalled();
    expect(validator).not.toHaveBeenCalled();
    expect(signaling.getSignalingHealth().direction).toBe('outbound');
  });

  test('retains outbound and rejects validated inbound when stable-id policy prefers outbound', async () => {
    const validator = jest.fn(({ message }) => ({
      accepted: true,
      peerId: message.deviceId,
      transport: 'LAN',
      preferInbound: false,
    }));
    signaling.setPassiveInboundAdmissionHandler(validator);

    const outbound = await establishOutbound();
    const inbound = makeSocket('192.168.0.36');
    onConnection(inbound);
    emitJson(inbound, { type: 'identity', deviceId: 'peer-device', deviceName: 'Peer' });

    expect(inbound.destroy).toHaveBeenCalledTimes(1);
    expect(outbound.destroy).not.toHaveBeenCalled();
    expect(signaling.getSignalingHealth().connected).toBe(true);
    expect(signaling.getSignalingHealth().direction).toBe('outbound');
  });
});
