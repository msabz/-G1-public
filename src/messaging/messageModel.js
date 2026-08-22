let messageSequence = 0;

const cleanText = value => String(value ?? '').trim();

export function createMessageId(now = Date.now(), random = Math.random()) {
  messageSequence = (messageSequence + 1) % Number.MAX_SAFE_INTEGER;
  const entropy = Math.floor(random * 0x100000000)
    .toString(36)
    .padStart(7, '0');
  return `msg-${Number(now).toString(36)}-${messageSequence.toString(36)}-${entropy}`;
}

export function ensureMessageIdentity(message, options = {}) {
  if (!message || typeof message !== 'object') return null;
  if (message.messageId) return message;
  return {
    ...message,
    messageId: createMessageId(options.now ?? Date.now(), options.random ?? Math.random()),
  };
}

export function createOutgoingTextMessage(input, options = {}) {
  const payload = typeof input === 'string' ? { text: input } : (input || {});
  const text = cleanText(payload.text);
  if (!text) return null;

  return {
    messageId: payload.messageId || createMessageId(options.now ?? Date.now(), options.random ?? Math.random()),
    sender: 'me',
    type: 'text',
    text,
    replyToMessageId: payload.replyToMessageId || null,
    status: payload.status || 'sending',
    time: Number(payload.time || options.now || Date.now()),
  };
}

export function createIncomingTextMessage(payload, options = {}) {
  const text = cleanText(payload?.text);
  if (!text) return null;
  return {
    messageId: payload?.messageId || createMessageId(options.now ?? Date.now(), options.random ?? Math.random()),
    sender: 'remote',
    type: 'text',
    text,
    replyToMessageId: payload?.replyToMessageId || null,
    status: 'delivered',
    time: Number(payload?.time || options.now || Date.now()),
  };
}

export function resolveReplyMessage(messages, replyToMessageId) {
  if (!replyToMessageId) return null;
  return (messages || []).find(message => message?.messageId === replyToMessageId) || null;
}

export function messagePreview(message, maxLength = 72) {
  if (!message) return 'الرسالة الأصلية غير متاحة';
  const raw = message.type === 'text'
    ? message.text
    : message.type === 'image'
      ? 'صورة'
      : message.type === 'voice'
        ? 'رسالة صوتية'
        : message.type === 'call'
          ? 'مكالمة'
          : message.fileName || 'ملف';
  const normalized = cleanText(raw).replace(/\s+/g, ' ');
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export function searchableMessageText(message) {
  if (!message) return '';
  return [message.text, message.fileName, message.mimeType, message.callKind, message.callResult]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

export function filterMessages(messages, query) {
  const normalized = cleanText(query).toLocaleLowerCase();
  if (!normalized) return messages || [];
  return (messages || []).filter(message => searchableMessageText(message).includes(normalized));
}

export function removeMessageById(messages, messageId) {
  if (!messageId) return messages || [];
  return (messages || []).filter(message => message?.messageId !== messageId);
}

export function shareableMessageText(message) {
  if (!message) return '';
  if (message.type === 'text') return cleanText(message.text);
  if (message.type === 'image') return message.fileName ? `صورة: ${message.fileName}` : 'صورة';
  if (message.type === 'voice') return 'رسالة صوتية';
  if (message.type === 'call') return 'سجل مكالمة';
  return cleanText(message.fileName || 'ملف');
}

export function resetMessageSequenceForTests() {
  messageSequence = 0;
}
