import {
  clearCallHistory,
  deleteCallRecord,
  listCallRecords,
} from './Persistence';

const STATE_ALIASES = Object.freeze({
  connected: 'ended',
  rejected: 'declined',
  noanswer: 'missed',
  cancelled: 'ended',
});

export function normalizeCallRecord(record) {
  if (!record?.callId) return null;
  const finalState = STATE_ALIASES[record.finalState] || record.finalState || 'failed';
  return {
    ...record,
    direction: record.direction === 'outgoing' ? 'outgoing' : 'incoming',
    mediaType: record.mediaType === 'video' ? 'video' : 'voice',
    startedAt: Number(record.startedAt) || 0,
    answeredAt: record.answeredAt == null ? null : Number(record.answeredAt),
    endedAt: record.endedAt == null ? null : Number(record.endedAt),
    duration: Math.max(0, Number(record.duration) || 0),
    finalState,
  };
}

export async function loadCallHistory({ limit = 300, peerId = null } = {}) {
  const records = await listCallRecords(limit);
  return (records || [])
    .map(normalizeCallRecord)
    .filter(Boolean)
    .filter(record => !peerId || record.peerId === peerId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function removeCallHistoryEntry(callId) {
  if (!callId) return Promise.resolve(false);
  return deleteCallRecord(callId);
}

export function removeAllCallHistory() {
  return clearCallHistory();
}

export function callHistoryPresentation(record) {
  const call = normalizeCallRecord(record);
  if (!call) return null;
  const incoming = call.direction === 'incoming';
  const missed = call.finalState === 'missed';
  const resultLabels = {
    ended: call.duration > 0 ? 'مكتملة' : 'منتهية',
    missed: incoming ? 'فائتة' : 'لم يتم الرد',
    declined: incoming ? 'مرفوضة' : 'رفض الطرف الآخر',
    busy: 'مشغول',
    failed: 'فشلت',
  };
  return {
    ...call,
    isMissed: missed,
    directionIcon: incoming ? '↙' : '↗',
    mediaIcon: call.mediaType === 'video' ? '🎥' : '📞',
    resultLabel: resultLabels[call.finalState] || call.finalState,
  };
}

export function formatCallHistoryDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  return minutes > 0
    ? `${minutes}:${String(remainder).padStart(2, '0')}`
    : `${remainder} ث`;
}
