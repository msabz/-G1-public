import fs from 'fs';
import path from 'path';

describe('App transport-neutral messaging integration', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.js'), 'utf8');

  test('sends stable message identity and reply metadata through signaling', () => {
    expect(source).toContain('const outgoing = createOutgoingTextMessage(input);');
    expect(source).toContain("type: 'chat',");
    expect(source).toContain('messageId: outgoing.messageId');
    expect(source).toContain('replyToMessageId: outgoing.replyToMessageId');
  });

  test('normalizes incoming text and ignores empty payloads', () => {
    expect(source).toContain('const incoming = createIncomingTextMessage(msg);');
    expect(source).toContain('if (mountedRef.current && incoming) addMessage(incoming, true);');
  });

  test('local delete and clear operate on the stable peer conversation only', () => {
    expect(source).toContain('removeMessageById(prev, messageId)');
    expect(source).toContain('deleteMessageLocal(peerIdRef.current, messageId)');
    expect(source).toContain('clearMessages(peerIdRef.current)');
  });
});
