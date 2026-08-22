jest.mock('react-native', () => {
  let nativeActionListener = null;
  let appStateListener = null;
  const callNotificationModule = {
    showIncomingCall: jest.fn().mockResolvedValue(true),
    cancelIncomingCall: jest.fn().mockResolvedValue(true),
    showMissedCall: jest.fn().mockResolvedValue(true),
    saveCallSession: jest.fn().mockResolvedValue(true),
    getPendingCallSession: jest.fn().mockResolvedValue(null),
    clearCallSession: jest.fn().mockResolvedValue(true),
    getPendingIncomingCall: jest.fn().mockResolvedValue(null),
    consumePendingCallAction: jest.fn().mockResolvedValue(null),
    acknowledgeCallAction: jest.fn().mockResolvedValue(true),
  };
  return {
    __callRuntimeTest: {
      emitNativeAction(action) { nativeActionListener?.(action); },
      emitAppState(state) { appStateListener?.(state); },
    },
    AppState: {
      currentState: 'active',
      addEventListener: jest.fn((event, listener) => {
        appStateListener = listener;
        return { remove: jest.fn(() => { if (appStateListener === listener) appStateListener = null; }) };
      }),
    },
    NativeEventEmitter: class NativeEventEmitter {
      addListener(event, listener) {
        nativeActionListener = listener;
        return { remove: jest.fn(() => { if (nativeActionListener === listener) nativeActionListener = null; }) };
      }
    },
    NativeModules: { CallNotificationModule: callNotificationModule },
  };
});

jest.mock('../src/webrtc/signaling', () => ({
  sendSignalingMessage: jest.fn(() => true),
}));

jest.mock('../src/media/AudioClip', () => ({
  startRingtone: jest.fn().mockResolvedValue(true),
  stopRingtone: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/services/Persistence', () => ({
  listCallRecords: jest.fn().mockResolvedValue([]),
  saveCallRecord: jest.fn().mockResolvedValue('saved'),
}));

import { sendSignalingMessage } from '../src/webrtc/signaling';
import { startRingtone, stopRingtone } from '../src/media/AudioClip';
import { listCallRecords, saveCallRecord } from '../src/services/Persistence';
import { __callRuntimeTest, NativeModules } from 'react-native';
import {
  CALL_STATES,
  answerIncomingCall,
  beginOutgoingCall,
  configureCallRuntimeForTests,
  declineIncomingCall,
  endCall,
  getActiveCall,
  handleIncomingCallRequest,
  handleRemoteCallSignal,
  initializeCallRuntime,
  markCallActive,
  registerCallUiController,
  setCallUiAttached,
  shutdownCallRuntimeForTests,
  waitForCallRuntimeIdle,
} from '../src/services/CallRuntime';

const mockCallNotificationModule = NativeModules.CallNotificationModule;

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('CallRuntime', () => {
  beforeAll(async () => {
    await waitForCallRuntimeIdle();
  });

  beforeEach(async () => {
    shutdownCallRuntimeForTests();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-22T06:00:00.000Z'));
    mockCallNotificationModule.getPendingCallSession.mockResolvedValue(null);
    mockCallNotificationModule.getPendingIncomingCall.mockResolvedValue(null);
    mockCallNotificationModule.consumePendingCallAction.mockResolvedValue(null);
    listCallRecords.mockResolvedValue([]);
    initializeCallRuntime();
    await waitForCallRuntimeIdle();
  });

  afterEach(() => {
    shutdownCallRuntimeForTests();
    jest.useRealTimers();
  });

  test('owns the correlated outgoing voice lifecycle and durable duration', async () => {
    const callId = beginOutgoingCall({
      callId: 'call-out-1',
      peerId: 'peer-1',
      peerName: 'Moto',
      video: false,
    });
    expect(getActiveCall()).toMatchObject({ callId, state: CALL_STATES.RINGING, mediaType: 'voice' });

    expect(handleRemoteCallSignal({ type: 'call-ringing', callId })).toBe(true);
    expect(handleRemoteCallSignal({ type: 'call-accept', callId })).toBe(true);
    expect(getActiveCall().state).toBe(CALL_STATES.CONNECTING);
    expect(markCallActive(callId)).toBe(true);
    expect(getActiveCall().state).toBe(CALL_STATES.ACTIVE);

    jest.advanceTimersByTime(5_400);
    expect(endCall(callId)).toBe(true);
    await waitForCallRuntimeIdle();

    expect(getActiveCall()).toMatchObject({ state: CALL_STATES.ENDED, duration: 5, endReason: 'local-ended' });
    expect(sendSignalingMessage).toHaveBeenLastCalledWith({ type: 'call-end', callId });
    expect(saveCallRecord).toHaveBeenLastCalledWith(expect.objectContaining({
      callId,
      mediaType: 'voice',
      direction: 'outgoing',
      finalState: 'ended',
      duration: 5,
    }));
    expect(mockCallNotificationModule.clearCallSession).toHaveBeenCalledWith(callId);
  });

  test('notification Answer updates the same callId before invoking the media UI seam', async () => {
    const accept = jest.fn();
    registerCallUiController({ accept });
    __callRuntimeTest.emitAppState('background');
    handleIncomingCallRequest(
      { type: 'call-request', callId: 'call-in-1', video: true },
      { deviceId: 'peer-2', deviceName: 'Samsung' },
    );

    expect(startRingtone).toHaveBeenCalledTimes(1);
    expect(mockCallNotificationModule.showIncomingCall).toHaveBeenCalledWith('call-in-1', 'Samsung', true);
    expect(sendSignalingMessage).toHaveBeenCalledWith({ type: 'call-ringing', callId: 'call-in-1' });

    __callRuntimeTest.emitNativeAction({ action: 'accept', callId: 'call-in-1', actionAt: 1234 });
    await flushAsync();

    expect(getActiveCall()).toMatchObject({ callId: 'call-in-1', state: CALL_STATES.CONNECTING });
    expect(sendSignalingMessage).toHaveBeenCalledWith({ type: 'call-accept', callId: 'call-in-1' });
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-in-1', mediaType: 'video' }),
      { fromNotification: true, signalingHandled: true },
    );
    expect(mockCallNotificationModule.acknowledgeCallAction)
      .toHaveBeenCalledWith('call-in-1', 'accept', 1234);
    expect(stopRingtone).toHaveBeenCalled();
  });

  test('notification Decline signals and persists the correlated terminal result', async () => {
    const reject = jest.fn();
    registerCallUiController({ reject });
    handleIncomingCallRequest(
      { type: 'call-request', callId: 'call-decline', video: false },
      { deviceId: 'peer-decline', deviceName: 'Declined peer' },
    );

    __callRuntimeTest.emitNativeAction({
      action: 'reject',
      callId: 'call-decline',
      actionAt: 222,
    });
    await flushAsync();
    await waitForCallRuntimeIdle();

    expect(getActiveCall()).toMatchObject({
      callId: 'call-decline',
      state: CALL_STATES.DECLINED,
      finalState: CALL_STATES.DECLINED,
      endReason: 'notification-decline',
    });
    expect(sendSignalingMessage).toHaveBeenCalledWith({
      type: 'call-reject',
      callId: 'call-decline',
    });
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-decline', state: CALL_STATES.DECLINED }),
      { fromNotification: true, signalingHandled: true },
    );
    expect(mockCallNotificationModule.acknowledgeCallAction)
      .toHaveBeenCalledWith('call-decline', 'reject', 222);
    expect(saveCallRecord).toHaveBeenLastCalledWith(expect.objectContaining({
      callId: 'call-decline',
      finalState: 'declined',
    }));
  });

  test('does not apply a notification action to a different active call', async () => {
    handleIncomingCallRequest(
      { type: 'call-request', callId: 'call-current', video: false },
      { deviceId: 'peer-3' },
    );
    __callRuntimeTest.emitNativeAction({ action: 'reject', callId: 'call-stale', actionAt: 77 });
    await flushAsync();

    expect(getActiveCall()).toMatchObject({ callId: 'call-current', state: CALL_STATES.RINGING });
    expect(sendSignalingMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'call-reject' }));
    expect(mockCallNotificationModule.acknowledgeCallAction).not.toHaveBeenCalled();
  });

  test('deduplicates a replayed durable notification action', async () => {
    const accept = jest.fn();
    registerCallUiController({ accept });
    handleIncomingCallRequest(
      { type: 'call-request', callId: 'call-replay', video: false },
      { deviceId: 'peer-replay' },
    );
    const action = { action: 'accept', callId: 'call-replay', actionAt: 88 };
    __callRuntimeTest.emitNativeAction(action);
    __callRuntimeTest.emitNativeAction(action);
    await flushAsync();

    expect(sendSignalingMessage.mock.calls.filter(([message]) => message.type === 'call-accept')).toHaveLength(1);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  test('treats a second UI answer as an idempotent no-op', () => {
    const accept = jest.fn();
    registerCallUiController({ accept });
    handleIncomingCallRequest(
      { type: 'call-request', callId: 'call-double-answer', video: true },
      { deviceId: 'peer-double-answer' },
    );

    expect(answerIncomingCall('call-double-answer')).toBe(true);
    expect(answerIncomingCall('call-double-answer')).toBe(true);

    expect(getActiveCall()).toMatchObject({
      callId: 'call-double-answer',
      state: CALL_STATES.CONNECTING,
    });
    expect(sendSignalingMessage.mock.calls.filter(
      ([message]) => message.type === 'call-accept' && message.callId === 'call-double-answer',
    )).toHaveLength(1);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  test('does not decline an incoming call after it has been accepted', () => {
    const reject = jest.fn();
    registerCallUiController({ reject });
    handleIncomingCallRequest(
      { type: 'call-request', callId: 'call-accept-then-reject', video: false },
      { deviceId: 'peer-accept-then-reject' },
    );

    expect(answerIncomingCall('call-accept-then-reject')).toBe(true);
    expect(declineIncomingCall('call-accept-then-reject')).toBe(false);

    expect(getActiveCall()).toMatchObject({
      callId: 'call-accept-then-reject',
      state: CALL_STATES.CONNECTING,
    });
    expect(sendSignalingMessage).not.toHaveBeenCalledWith({
      type: 'call-reject',
      callId: 'call-accept-then-reject',
    });
    expect(reject).not.toHaveBeenCalled();
  });

  test('rejects a second incoming call as busy without replacing the active session', async () => {
    beginOutgoingCall({ callId: 'call-active', peerId: 'peer-a', video: false });
    const result = handleIncomingCallRequest(
      { type: 'call-request', callId: 'call-waiting', video: true },
      { deviceId: 'peer-b', deviceName: 'Waiting peer' },
    );
    await waitForCallRuntimeIdle();

    expect(result).toMatchObject({ accepted: false, reason: 'busy' });
    expect(getActiveCall().callId).toBe('call-active');
    expect(sendSignalingMessage).toHaveBeenCalledWith({ type: 'call-busy', callId: 'call-waiting' });
    expect(saveCallRecord).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'call-waiting',
      finalState: 'busy',
      mediaType: 'video',
    }));
  });

  test('restores a ringing call before consuming durable notification Answer', async () => {
    shutdownCallRuntimeForTests();
    mockCallNotificationModule.getPendingCallSession.mockResolvedValue({
      callId: 'call-restore',
      peerId: 'peer-r',
      peerName: 'Restored peer',
      direction: 'incoming',
      mediaType: 'video',
      state: 'ringing',
      startedAt: Date.now() - 2_000,
      ringingAt: Date.now() - 2_000,
      lastTransitionAt: Date.now() - 2_000,
      correlationMode: 'call-id',
    });
    mockCallNotificationModule.consumePendingCallAction.mockResolvedValue({
      action: 'accept',
      callId: 'call-restore',
      actionAt: 555,
    });
    initializeCallRuntime();
    await waitForCallRuntimeIdle();

    expect(getActiveCall()).toMatchObject({
      callId: 'call-restore',
      state: CALL_STATES.CONNECTING,
      recovered: true,
    });
    expect(sendSignalingMessage).toHaveBeenCalledWith({ type: 'call-accept', callId: 'call-restore' });
    expect(mockCallNotificationModule.acknowledgeCallAction)
      .toHaveBeenCalledWith('call-restore', 'accept', 555);

    const accept = jest.fn();
    registerCallUiController({ accept });
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-restore', state: CALL_STATES.CONNECTING }),
      { fromNotification: true, signalingHandled: true },
    );
  });

  test('restores an active snapshot as connecting and never auto-activates media', async () => {
    shutdownCallRuntimeForTests();
    mockCallNotificationModule.getPendingCallSession.mockResolvedValue({
      callId: 'call-active-restart',
      peerId: 'peer-r2',
      direction: 'outgoing',
      mediaType: 'voice',
      state: 'active',
      startedAt: Date.now() - 10_000,
      answeredAt: Date.now() - 8_000,
      activeAt: Date.now() - 7_000,
      lastTransitionAt: Date.now() - 7_000,
      correlationMode: 'call-id',
    });
    mockCallNotificationModule.consumePendingCallAction.mockResolvedValue(null);
    initializeCallRuntime();
    await waitForCallRuntimeIdle();

    expect(getActiveCall()).toMatchObject({
      callId: 'call-active-restart',
      state: CALL_STATES.CONNECTING,
      recovered: true,
    });
    expect(sendSignalingMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'call-accept' }));
  });

  test('marks an unanswered incoming call missed and replaces ringing with a missed notification', async () => {
    configureCallRuntimeForTests({ timeoutMs: 1_000 });
    handleIncomingCallRequest(
      { type: 'call-request', callId: 'call-timeout', video: false },
      { deviceId: 'peer-timeout', deviceName: 'Late peer' },
    );
    jest.advanceTimersByTime(1_000);
    await flushAsync();
    await waitForCallRuntimeIdle();

    expect(getActiveCall()).toMatchObject({ state: CALL_STATES.MISSED, endReason: 'ring-timeout' });
    expect(sendSignalingMessage).toHaveBeenCalledWith({ type: 'call-missed', callId: 'call-timeout' });
    expect(mockCallNotificationModule.showMissedCall).toHaveBeenCalledWith('call-timeout', 'Late peer', false);
    expect(saveCallRecord).toHaveBeenLastCalledWith(expect.objectContaining({
      callId: 'call-timeout',
      finalState: 'missed',
      duration: 0,
    }));
  });

  test('times out an outgoing call even when the remote ringing frame is lost', async () => {
    configureCallRuntimeForTests({ timeoutMs: 1_000 });
    beginOutgoingCall({ callId: 'call-no-ring-frame', peerId: 'silent-peer', video: false });

    expect(getActiveCall().state).toBe(CALL_STATES.RINGING);
    jest.advanceTimersByTime(1_000);
    await flushAsync();
    await waitForCallRuntimeIdle();

    expect(getActiveCall()).toMatchObject({
      callId: 'call-no-ring-frame',
      state: CALL_STATES.MISSED,
      endReason: 'no-answer',
    });
    expect(sendSignalingMessage).toHaveBeenCalledWith({
      type: 'call-cancel',
      callId: 'call-no-ring-frame',
    });
  });
});
