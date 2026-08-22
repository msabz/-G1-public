jest.mock('../src/services/Persistence', () => ({
  clearCallHistory: jest.fn().mockResolvedValue(true),
  deleteCallRecord: jest.fn().mockResolvedValue(true),
  listCallRecords: jest.fn().mockResolvedValue([]),
}));

import { listCallRecords } from '../src/services/Persistence';
import {
  callHistoryPresentation,
  formatCallHistoryDuration,
  loadCallHistory,
  normalizeCallRecord,
} from '../src/services/CallHistory';

describe('CallHistory', () => {
  beforeEach(() => jest.clearAllMocks());

  test('normalizes legacy results without losing direction, media, or duration', () => {
    expect(normalizeCallRecord({
      callId: 'call-1',
      peerId: 'peer-1',
      direction: 'outgoing',
      mediaType: 'video',
      startedAt: '1000',
      answeredAt: '1500',
      endedAt: '4500',
      duration: '3',
      finalState: 'noanswer',
    })).toMatchObject({
      callId: 'call-1',
      direction: 'outgoing',
      mediaType: 'video',
      startedAt: 1000,
      answeredAt: 1500,
      endedAt: 4500,
      duration: 3,
      finalState: 'missed',
    });
  });

  test('loads newest-first history and can scope it to one peer', async () => {
    listCallRecords.mockResolvedValue([
      { callId: 'older', peerId: 'peer-a', startedAt: 100, finalState: 'ended' },
      { callId: 'other', peerId: 'peer-b', startedAt: 300, finalState: 'failed' },
      { callId: 'newer', peerId: 'peer-a', startedAt: 200, finalState: 'declined' },
    ]);

    await expect(loadCallHistory({ peerId: 'peer-a' })).resolves.toEqual([
      expect.objectContaining({ callId: 'newer' }),
      expect.objectContaining({ callId: 'older' }),
    ]);
  });

  test('presents incoming missed and outgoing failed calls distinctly', () => {
    expect(callHistoryPresentation({
      callId: 'missed', peerId: 'p', direction: 'incoming', finalState: 'missed',
    })).toMatchObject({ isMissed: true, directionIcon: '↙', resultLabel: 'فائتة' });
    expect(callHistoryPresentation({
      callId: 'failed', peerId: 'p', direction: 'outgoing', finalState: 'failed',
    })).toMatchObject({ isMissed: false, directionIcon: '↗', resultLabel: 'فشلت' });
  });

  test('formats durations predictably', () => {
    expect(formatCallHistoryDuration(8)).toBe('8 ث');
    expect(formatCallHistoryDuration(125)).toBe('2:05');
  });
});
