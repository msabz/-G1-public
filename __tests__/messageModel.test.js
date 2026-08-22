import {
  createIncomingTextMessage,
  createMessageId,
  createOutgoingTextMessage,
  filterMessages,
  messagePreview,
  removeMessageById,
  resetMessageSequenceForTests,
  resolveReplyMessage,
  shareableMessageText,
} from '../src/messaging/messageModel';

describe('transport-neutral message model', () => {
  beforeEach(() => resetMessageSequenceForTests());

  test('creates collision-resistant stable ids without using a route address', () => {
    const first = createMessageId(1234, 0.25);
    const second = createMessageId(1234, 0.25);
    expect(first).toMatch(/^msg-/);
    expect(second).toMatch(/^msg-/);
    expect(second).not.toBe(first);
    expect(first).not.toMatch(/192\.168|[0-9a-f]{2}:[0-9a-f]{2}/i);
  });

  test('preserves the same id and reply reference across the signaling boundary', () => {
    const outgoing = createOutgoingTextMessage(
      { text: '  رد جديد  ', replyToMessageId: 'original-1' },
      { now: 2000, random: 0.5 }
    );
    const incoming = createIncomingTextMessage({
      messageId: outgoing.messageId,
      text: outgoing.text,
      replyToMessageId: outgoing.replyToMessageId,
      time: outgoing.time,
    });

    expect(incoming).toMatchObject({
      messageId: outgoing.messageId,
      sender: 'remote',
      text: 'رد جديد',
      replyToMessageId: 'original-1',
      status: 'delivered',
    });
  });

  test('rejects empty outgoing and incoming text', () => {
    expect(createOutgoingTextMessage('   ')).toBeNull();
    expect(createIncomingTextMessage({ text: '\n' })).toBeNull();
  });

  test('resolves replies and reports a missing original truthfully', () => {
    const messages = [{ messageId: 'one', type: 'text', text: 'النص الأصلي' }];
    expect(resolveReplyMessage(messages, 'one')).toBe(messages[0]);
    expect(messagePreview(resolveReplyMessage(messages, 'missing'))).toBe('الرسالة الأصلية غير متاحة');
  });

  test('searches text and attachment metadata without mutating the conversation', () => {
    const messages = [
      { messageId: 'one', type: 'text', text: 'مرحبا يا مصعب' },
      { messageId: 'two', type: 'file', fileName: 'Contract.PDF' },
    ];
    expect(filterMessages(messages, 'مصعب')).toEqual([messages[0]]);
    expect(filterMessages(messages, 'pdf')).toEqual([messages[1]]);
    expect(filterMessages(messages, '')).toBe(messages);
  });

  test('local deletion removes only the selected id', () => {
    const messages = [{ messageId: 'one' }, { messageId: 'two' }];
    expect(removeMessageById(messages, 'one')).toEqual([{ messageId: 'two' }]);
    expect(removeMessageById(messages, 'missing')).toEqual(messages);
  });

  test('shares only user-facing message content', () => {
    expect(shareableMessageText({ type: 'text', text: ' hello ' })).toBe('hello');
    expect(shareableMessageText({ type: 'file', fileName: 'report.pdf' })).toBe('report.pdf');
  });
});
