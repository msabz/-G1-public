const { mergePeerMessageHistory } = require('../src/network/passiveLanAppPolicy');

describe('passive LAN history/live-message convergence', () => {
  test('preserves a live message that arrives while persisted history is loading', () => {
    const history = [
      { sender: 'remote', type: 'text', text: 'older', time: 1000 },
    ];
    const live = [
      { sender: 'remote', type: 'text', text: 'new-live', time: 2000 },
    ];

    expect(mergePeerMessageHistory(history, live)).toEqual([
      { sender: 'remote', type: 'text', text: 'older', time: 1000 },
      { sender: 'remote', type: 'text', text: 'new-live', time: 2000 },
    ]);
  });

  test('deduplicates a message already present in history by stable id', () => {
    const persisted = { id: 'msg-1', sender: 'remote', type: 'text', text: 'hello', time: 1000 };
    const liveCopy = { ...persisted };

    expect(mergePeerMessageHistory([persisted], [liveCopy])).toEqual([persisted]);
  });

  test('deduplicates completed transfer rows by transferId while preserving live terminal fields', () => {
    const persisted = {
      sender: 'remote', type: 'file', transferId: 'transfer-1',
      fileName: 'photo.jpg', progress: 0, time: 1000,
    };
    const live = {
      ...persisted,
      progress: 1,
      localUri: 'file:///received/photo.jpg',
    };

    expect(mergePeerMessageHistory([persisted], [live])).toEqual([live]);
  });

  test('uses a deterministic content fingerprint when no stable id exists', () => {
    const persisted = { sender: 'remote', type: 'text', text: 'same', time: 1234 };
    const duplicate = { ...persisted };
    const distinct = { ...persisted, time: 1235 };

    expect(mergePeerMessageHistory([persisted], [duplicate, distinct])).toEqual([
      persisted,
      distinct,
    ]);
  });

  test('does not mutate either input array', () => {
    const history = [{ sender: 'remote', type: 'text', text: 'a', time: 1 }];
    const live = [{ sender: 'me', type: 'text', text: 'b', time: 2 }];
    const historyBefore = JSON.parse(JSON.stringify(history));
    const liveBefore = JSON.parse(JSON.stringify(live));

    mergePeerMessageHistory(history, live);

    expect(history).toEqual(historyBefore);
    expect(live).toEqual(liveBefore);
  });
});
