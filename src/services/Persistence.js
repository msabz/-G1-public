import { NativeModules } from 'react-native';
const { StorageModule } = NativeModules;

// حفظ المحادثات محلياً — كل محادثة مرتبطة بهوية الجهاز الآخر.
// messageId هوية تطبيقية مستقرة ولا تعتمد على IP أو transport.
export function saveMessage(peerId, message) {
  return StorageModule.saveMessage(peerId, {
    messageId: message.messageId ?? null,
    sender: message.sender || 'me',
    type: message.type || 'text',
    text: message.text ?? null,
    fileName: message.fileName ?? null,
    mimeType: message.mimeType ?? null,
    path: message.path ?? null,
    localUri: message.localUri ?? null,
    size: message.size ?? 0,
    status: message.status ?? null,
    replyToMessageId: message.replyToMessageId ?? null,
    editedAt: message.editedAt ?? null,
    time: message.time ?? Date.now(),
  }).catch(() => null);
}

export function loadMessages(peerId, limit = 300) {
  return StorageModule.loadMessages(peerId, limit).catch(() => []);
}

export function clearMessages(peerId) {
  return StorageModule.clearMessages(peerId).catch(() => false);
}

export function deleteMessageLocal(peerId, messageId) {
  return StorageModule.deleteMessageLocal(peerId, messageId).catch(() => false);
}

// Tombstone foundation for a future synchronized "delete for everyone" event.
export function markMessageDeleted(peerId, messageId) {
  return StorageModule.markMessageDeleted(peerId, messageId).catch(() => false);
}

export function updateMessageStatus(peerId, messageId, status) {
  return StorageModule.updateMessageStatus(peerId, messageId, status).catch(() => false);
}

export function editMessage(peerId, messageId, text, editedAt = Date.now()) {
  return StorageModule.editMessage(peerId, messageId, text, editedAt).catch(() => false);
}

export function savePeer(peerId, name, lastMessage) {
  return StorageModule.savePeer(peerId, name || '', lastMessage || '').catch(() => false);
}

export function listPeers() {
  return StorageModule.listPeers().catch(() => []);
}

// يربط جهة الاتصال بعنوان الجهاز ليتم الاتصال به مباشرةً لاحقاً.
export function savePeerAddress(peerId, deviceAddress, deviceName) {
  return StorageModule.savePeerAddress(peerId, deviceAddress, deviceName || '').catch(() => false);
}

export function deletePeer(peerId) {
  return StorageModule.deletePeer(peerId).catch(() => false);
}

// Persistent call history is independent from transient React call UI.
export function saveCallRecord(record) {
  return StorageModule.saveCallRecord({
    callId: record.callId ?? null,
    peerId: record.peerId,
    peerName: record.peerName ?? null,
    direction: record.direction || 'incoming',
    mediaType: record.mediaType || 'voice',
    startedAt: record.startedAt ?? Date.now(),
    answeredAt: record.answeredAt ?? null,
    endedAt: record.endedAt ?? null,
    duration: record.duration ?? 0,
    finalState: record.finalState || 'ringing',
    endReason: record.endReason ?? null,
  }).catch(() => null);
}

export function listCallRecords(limit = 300) {
  return StorageModule.listCallRecords(limit).catch(() => []);
}

export function deleteCallRecord(callId) {
  return StorageModule.deleteCallRecord(callId).catch(() => false);
}

export function clearCallHistory() {
  return StorageModule.clearCallHistory().catch(() => false);
}

// هوية ثابتة لهذا الجهاز — تُنشأ مرة واحدة وتبقى.
export function getDeviceIdentity() {
  return StorageModule.getDeviceIdentity();
}

export function setDeviceName(name) {
  return StorageModule.setDeviceName(name);
}
