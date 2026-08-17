jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import TcpSocket from 'react-native-tcp-socket';
import { SignalingListener, MAX_PENDING_CONNECTIONS } from '../src/network/SignalingListener';
import { SignalingSession, MAX_SIGNALING_BUFFER_BYTES } from '../src/network/SignalingSession';

function makeMockSocket() {
  const handlers = {};
  return {
    on: jest.fn((event, callback) => { handlers[event] = callback; }),
    once: jest.fn((event, callback) => { handlers[event] = callback; }),
    removeListener: jest.fn(),
    emit: (event, value) => { if (handlers[event]) handlers[event](value); },
    destroy: jest.fn(),
    write: jest.fn(),
  };
}

describe('SignalingListener and SignalingSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('SignalingListener starts server and accepts incoming connections without closing server', async () => {
    let serverCallback;
    const mockServer = {
      listen: jest.fn((opts, cb) => cb()),
      on: jest.fn(),
      close: jest.fn(),
    };
    TcpSocket.createServer.mockImplementation(cb => {
      serverCallback = cb;
      return mockServer;
    });

    const onConnection = jest.fn();
    const listener = new SignalingListener({ port: 8089, onConnection });

    await listener.start();
    expect(listener.isListening).toBe(true);

    const socket1 = makeMockSocket();
    serverCallback(socket1);
    expect(onConnection).toHaveBeenCalledTimes(1);
    expect(mockServer.close).not.toHaveBeenCalled();

    listener.stop();
    expect(listener.isListening).toBe(false);
    expect(mockServer.close).toHaveBeenCalledTimes(1);
  });

  test('SignalingListener enforces max pending connections limit', async () => {
    let serverCallback;
    TcpSocket.createServer.mockImplementation(cb => {
      serverCallback = cb;
      return {
        listen: jest.fn((opts, cb) => cb()),
        on: jest.fn(),
        close: jest.fn(),
      };
    });

    const listener = new SignalingListener({ port: 8089 });
    await listener.start();

    const sockets = [];
    for (let i = 0; i < MAX_PENDING_CONNECTIONS; i++) {
      const s = makeMockSocket();
      sockets.push(s);
      serverCallback(s);
    }

    const overflowSocket = makeMockSocket();
    serverCallback(overflowSocket);
    expect(overflowSocket.destroy).toHaveBeenCalledTimes(1);

    listener.stop();
  });

  test('SignalingSession sends and receives newline-delimited JSON messages', () => {
    const onMessage = jest.fn();
    const session = new SignalingSession({ onMessage });
    const socket = makeMockSocket();

    session.attachSocket(socket, 1);
    expect(session.isConnected).toBe(true);

    socket.emit('data', '{"type":"chat","text":"hello"}\n');
    expect(onMessage).toHaveBeenCalledWith({ type: 'chat', text: 'hello' }, session);

    session.sendMessage({ type: 'ping' });
    expect(socket.write).toHaveBeenCalledWith('{"type":"ping"}\n');

    session.destroy();
    expect(session.isConnected).toBe(false);
    expect(socket.destroy).toHaveBeenCalled();
  });

  test('SignalingSession destroys socket if oversized buffer arrives', () => {
    const session = new SignalingSession();
    const socket = makeMockSocket();
    session.attachSocket(socket, 1);

    socket.emit('data', 'x'.repeat(MAX_SIGNALING_BUFFER_BYTES + 10));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(session.isConnected).toBe(false);
  });
});
