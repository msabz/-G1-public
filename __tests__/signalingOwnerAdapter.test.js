jest.mock('../src/webrtc/signaling', () => ({
  addSignalingDisconnectObserver: jest.fn(),
  cancelSignalingConnectAttempt: jest.fn(),
  closeSignaling: jest.fn(),
  connectToSignalingServer: jest.fn(),
  createSignalingServer: jest.fn(),
  getActiveSession: jest.fn(),
  sendSignalingMessage: jest.fn(),
  waitForClientConnection: jest.fn(),
}));

import * as signalingRuntime from '../src/webrtc/signaling';
import { signalingOwner } from '../src/webrtc/signalingOwner';

describe('signalingOwner adapter', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('delegates outbound and inbound coordinator ownership without adding a second session owner', async () => {
    const session = { isConnected: true };
    const subscription = { remove: jest.fn() };
    const disconnectObserver = jest.fn();
    const cancelReason = new Error('cancel obsolete connect');
    const message = { type: 'chat', text: 'hello' };

    signalingRuntime.connectToSignalingServer.mockResolvedValue(undefined);
    signalingRuntime.createSignalingServer.mockResolvedValue(undefined);
    signalingRuntime.waitForClientConnection.mockResolvedValue(undefined);
    signalingRuntime.cancelSignalingConnectAttempt.mockReturnValue(true);
    signalingRuntime.getActiveSession.mockReturnValue(session);
    signalingRuntime.sendSignalingMessage.mockReturnValue(true);
    signalingRuntime.closeSignaling.mockReturnValue(undefined);
    signalingRuntime.addSignalingDisconnectObserver.mockReturnValue(subscription);

    await expect(signalingOwner.connectOutbound({
      host: '192.168.0.36',
      port: 8089,
      maxRetries: 3,
      retryDelayMs: 600,
      timeoutMs: 5000,
    })).resolves.toBeUndefined();
    expect(signalingRuntime.connectToSignalingServer).toHaveBeenCalledWith(
      '192.168.0.36',
      8089,
      3,
      600
    );

    await expect(signalingOwner.acceptInbound({
      port: 8089,
      timeoutMs: 15000,
    })).resolves.toBe(session);
    expect(signalingRuntime.createSignalingServer).toHaveBeenCalledWith(8089);
    expect(signalingRuntime.waitForClientConnection).toHaveBeenCalledWith(15000);

    expect(signalingOwner.cancelConnect(cancelReason)).toBe(true);
    expect(signalingRuntime.cancelSignalingConnectAttempt).toHaveBeenCalledWith(cancelReason);

    expect(signalingOwner.getActiveSession()).toBe(session);
    expect(signalingOwner.sendMessage(message)).toBe(true);
    expect(signalingRuntime.sendSignalingMessage).toHaveBeenCalledWith(message);

    expect(signalingOwner.subscribeDisconnect(disconnectObserver)).toBe(subscription);
    expect(signalingRuntime.addSignalingDisconnectObserver).toHaveBeenCalledWith(disconnectObserver);

    signalingOwner.disconnect();
    expect(signalingRuntime.closeSignaling).toHaveBeenCalledTimes(1);
  });
});
