let mockSignalMessageObserver = null;
let mockSignalDisconnectObserver = null;
let mockIncomingStartObserver = null;
let mockIncomingDoneObserver = null;
let mockActiveCall = null;

jest.mock('../src/webrtc/signaling', () => ({
  addSignalingMessageObserver: jest.fn(cb => {
    mockSignalMessageObserver = cb;
    return { remove: jest.fn(() => { if (mockSignalMessageObserver === cb) mockSignalMessageObserver = null; }) };
  }),
  addSignalingDisconnectObserver: jest.fn(cb => {
    mockSignalDisconnectObserver = cb;
    return { remove: jest.fn(() => { if (mockSignalDisconnectObserver === cb) mockSignalDisconnectObserver = null; }) };
  }),
}));

jest.mock('../src/media/FileShare', () => ({
  onIncomingStart: jest.fn(cb => {
    mockIncomingStartObserver = cb;
    return { remove: jest.fn(() => { if (mockIncomingStartObserver === cb) mockIncomingStartObserver = null; }) };
  }),
  onIncomingDone: jest.fn(cb => {
    mockIncomingDoneObserver = cb;
    return { remove: jest.fn(() => { if (mockIncomingDoneObserver === cb) mockIncomingDoneObserver = null; }) };
  }),
}));

jest.mock('../src/services/Persistence', () => ({
  saveMessage: jest.fn().mockResolvedValue(true),
  savePeer: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/services/Background', () => ({
  showMessageNotification: jest.fn().mockResolvedValue(true),
}));

// BackgroundRuntime only needs the CallRuntime contract here. Mocking that
// boundary keeps this unit test independent from React Native's native module
// loader while still verifying that incoming call metadata is routed correctly.
jest.mock('../src/services/CallRuntime', () => ({
  clearCallRuntime: jest.fn(callId => {
    if (!callId || mockActiveCall?.callId === callId) mockActiveCall = null;
  }),
  getActiveCall: jest.fn(() => mockActiveCall),
  handleIncomingCallRequest: jest.fn((msg, peer = {}) => {
    mockActiveCall = {
      ...msg,
      callId: msg.callId,
      video: !!msg.video,
      direction: 'incoming',
      peerId: peer.deviceId,
      peerName: peer.deviceName || peer.name,
      finalState: null,
    };
    return mockActiveCall;
  }),
  handleRemoteCallSignal: jest.fn(() => {}),
  setCallUiAttached: jest.fn(() => {}),
}));

import { saveMessage, savePeer } from '../src/services/Persistence';
import { showMessageNotification } from '../src/services/Background';
import {
  clearPendingIncomingCall,
  getPendingIncomingCall,
  initializeBackgroundRuntime,
  setUiAttached,
  shutdownBackgroundRuntimeForTests,
} from '../src/services/BackgroundRuntime';
import { handleRemoteCallSignal } from '../src/services/CallRuntime';

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('BackgroundRuntime', () => {
  beforeEach(() => {
    shutdownBackgroundRuntimeForTests();
    mockActiveCall = null;
    jest.clearAllMocks();
    initializeBackgroundRuntime();
    setUiAttached(true);
  });

  afterAll(() => {
    shutdownBackgroundRuntimeForTests();
  });

  test('does not duplicate chat persistence while the React UI is attached', async () => {
    mockSignalMessageObserver({ type: 'identity', deviceId: 'peer-1', deviceName: 'Moto' });
    mockSignalMessageObserver({ type: 'chat', text: 'hello' });
    await flushAsync();

    expect(saveMessage).not.toHaveBeenCalled();
    expect(showMessageNotification).not.toHaveBeenCalled();
  });

  test('persists and notifies incoming chat when the UI is detached', async () => {
    mockSignalMessageObserver({ type: 'identity', deviceId: 'peer-2', deviceName: 'Moto' });
    setUiAttached(false);
    mockSignalMessageObserver({
      type: 'chat',
      messageId: 'background-msg-1',
      text: 'background hello',
      replyToMessageId: 'original-msg',
      time: 1234,
    });
    await flushAsync();

    expect(saveMessage).toHaveBeenCalledWith(
      'peer-2',
      expect.objectContaining({
        sender: 'remote',
        type: 'text',
        messageId: 'background-msg-1',
        text: 'background hello',
        replyToMessageId: 'original-msg',
        status: 'delivered',
      })
    );
    expect(savePeer).toHaveBeenCalledWith('peer-2', 'Moto', 'background hello');
    expect(showMessageNotification).toHaveBeenCalledWith('Moto', 'background hello');
  });

  test('queues a background message until peer identity arrives instead of losing it', async () => {
    setUiAttached(false);
    mockSignalMessageObserver({ type: 'chat', text: 'early message' });
    await flushAsync();
    expect(saveMessage).not.toHaveBeenCalled();

    mockSignalMessageObserver({ type: 'identity', deviceId: 'peer-3', deviceName: 'Samsung' });
    await flushAsync();

    expect(saveMessage).toHaveBeenCalledWith(
      'peer-3',
      expect.objectContaining({ text: 'early message' })
    );
    expect(showMessageNotification).toHaveBeenCalledWith('Samsung', 'early message');
  });

  test('persists a completed incoming file when UI transfer listeners are gone', async () => {
    mockSignalMessageObserver({ type: 'identity', deviceId: 'peer-4', deviceName: 'Moto' });
    setUiAttached(false);
    mockIncomingStartObserver({
      id: 'ft-1',
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      kind: 'image',
      size: 1024,
    });
    mockIncomingDoneObserver({
      id: 'ft-1',
      path: 'content://downloads/photo.jpg',
      size: 1024,
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      kind: 'image',
    });
    await flushAsync();

    expect(saveMessage).toHaveBeenCalledWith(
      'peer-4',
      expect.objectContaining({
        sender: 'remote',
        type: 'image',
        fileName: 'photo.jpg',
        localUri: 'content://downloads/photo.jpg',
        status: 'delivered',
      })
    );
    expect(showMessageNotification).toHaveBeenCalledWith('Moto', 'صورة');
  });

  test('keeps pending incoming call metadata for the call-notification layer', () => {
    mockSignalMessageObserver({ type: 'identity', deviceId: 'peer-5', deviceName: 'Moto' });
    mockSignalMessageObserver({ type: 'call-request', callId: 'call-123', video: true });

    expect(getPendingIncomingCall()).toMatchObject({
      callId: 'call-123',
      video: true,
      peerId: 'peer-5',
      peerName: 'Moto',
    });

    clearPendingIncomingCall();
    expect(getPendingIncomingCall()).toBeNull();
  });

  test('forwards connecting, active, and failed call lifecycle signals', () => {
    for (const type of ['call-connected', 'call-active', 'call-failed']) {
      mockSignalMessageObserver({ type, callId: 'call-lifecycle' });
    }

    expect(handleRemoteCallSignal.mock.calls.map(([message]) => message.type)).toEqual([
      'call-connected',
      'call-active',
      'call-failed',
    ]);
  });
});
