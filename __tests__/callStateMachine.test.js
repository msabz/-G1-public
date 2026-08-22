import {
  CALL_DIRECTIONS,
  CALL_EVENTS,
  CALL_STATES,
  createCallState,
  isTerminalCallState,
  transitionCall,
} from '../src/services/CallStateMachine';

describe('CallStateMachine', () => {
  const clock = jest.fn()
    .mockReturnValueOnce(1_000)
    .mockReturnValueOnce(2_000)
    .mockReturnValueOnce(3_000)
    .mockReturnValueOnce(8_400)
    .mockReturnValue(9_000);

  beforeEach(() => clock.mockClear());

  test('drives an outgoing voice call through ringing, connecting, active, and ended', () => {
    let call = createCallState({
      callId: 'call-out-1',
      peerId: 'peer-1',
      direction: CALL_DIRECTIONS.OUTGOING,
      mediaType: 'voice',
    }, clock);

    expect(call.state).toBe(CALL_STATES.OUTGOING);
    call = transitionCall(call, CALL_EVENTS.RING, {}, clock);
    expect(call.state).toBe(CALL_STATES.RINGING);
    call = transitionCall(call, CALL_EVENTS.ANSWER, {}, clock);
    expect(call).toMatchObject({ state: CALL_STATES.CONNECTING, answeredAt: 3_000 });
    call = transitionCall(call, CALL_EVENTS.MEDIA_ACTIVE, {}, clock);
    expect(call.state).toBe(CALL_STATES.ACTIVE);
    call = transitionCall(call, CALL_EVENTS.END, { reason: 'local-ended' }, clock);

    expect(call).toMatchObject({
      state: CALL_STATES.ENDED,
      finalState: CALL_STATES.ENDED,
      endedAt: 9_000,
      duration: 6,
      endReason: 'local-ended',
    });
  });

  test.each([
    [CALL_EVENTS.DECLINE, CALL_STATES.DECLINED],
    [CALL_EVENTS.BUSY, CALL_STATES.BUSY],
    [CALL_EVENTS.MISS, CALL_STATES.MISSED],
    [CALL_EVENTS.FAIL, CALL_STATES.FAILED],
  ])('supports terminal ringing event %s -> %s', (event, expected) => {
    const initial = createCallState({
      callId: `call-${event}`,
      peerId: 'peer-2',
      direction: CALL_DIRECTIONS.INCOMING,
      mediaType: 'video',
    }, () => 1_000);
    const ringing = transitionCall(initial, CALL_EVENTS.RING, {}, () => 1_100);
    const terminal = transitionCall(ringing, event, { reason: event }, () => 1_200);

    expect(terminal.state).toBe(expected);
    expect(terminal.finalState).toBe(expected);
    expect(terminal.duration).toBe(0);
    expect(isTerminalCallState(terminal.state)).toBe(true);
  });

  test('rejects impossible transitions and never revives a terminal call', () => {
    const initial = createCallState({
      callId: 'call-invalid',
      peerId: 'peer-3',
      direction: CALL_DIRECTIONS.INCOMING,
    }, () => 100);

    expect(() => transitionCall(initial, CALL_EVENTS.MEDIA_ACTIVE, {}, () => 200))
      .toThrow('Invalid call transition');

    const missed = transitionCall(initial, CALL_EVENTS.MISS, {}, () => 300);
    expect(transitionCall(missed, CALL_EVENTS.ANSWER, {}, () => 400)).toBe(missed);
  });

  test('requires stable call and peer identities', () => {
    expect(() => createCallState({ peerId: 'peer' })).toThrow('callId is required');
    expect(() => createCallState({ callId: 'call' })).toThrow('peerId is required');
  });
});
