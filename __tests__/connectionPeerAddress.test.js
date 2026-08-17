import {
  createConnectionAddressTracker,
  saveResolvedPeerAddress,
} from '../src/utils/connectionPeerAddress';

describe('connection peer address tracker', () => {
  test('saves the incoming peer address when address arrives before identity', async () => {
    const tracker = createConnectionAddressTracker();
    const savePeerAddress = jest.fn().mockResolvedValue();

    tracker.activateConnection(1);
    tracker.setConnectedPeerAddress(1, '02:00:00:00:00:0B');
    tracker.setIdentity({ peerId: 'peer-b', deviceName: 'Device B', targetPeer: {} });

    await expect(saveResolvedPeerAddress(tracker, savePeerAddress)).resolves.toBe(true);
    expect(savePeerAddress).toHaveBeenCalledWith('peer-b', '02:00:00:00:00:0B', 'Device B');
  });

  test('saves the incoming peer address when identity arrives before address', async () => {
    const tracker = createConnectionAddressTracker();
    const savePeerAddress = jest.fn().mockResolvedValue();

    tracker.activateConnection(1);
    tracker.setIdentity({ peerId: 'peer-b', deviceName: 'Device B', targetPeer: {} });

    await expect(saveResolvedPeerAddress(tracker, savePeerAddress)).resolves.toBe(false);
    tracker.setConnectedPeerAddress(1, '02:00:00:00:00:0B');
    await expect(saveResolvedPeerAddress(tracker, savePeerAddress)).resolves.toBe(true);
    expect(savePeerAddress).toHaveBeenCalledTimes(1);
    expect(savePeerAddress).toHaveBeenCalledWith('peer-b', '02:00:00:00:00:0B', 'Device B');
  });

  test('keeps the outgoing selected target address', async () => {
    const tracker = createConnectionAddressTracker();
    const savePeerAddress = jest.fn().mockResolvedValue();

    tracker.activateConnection(1);
    tracker.setConnectedPeerAddress(1, '02:00:00:00:00:0B');
    tracker.setIdentity({
      peerId: 'peer-a',
      deviceName: 'Device A',
      targetPeer: { deviceAddress: '02:00:00:00:00:0A' },
    });

    await saveResolvedPeerAddress(tracker, savePeerAddress);
    expect(savePeerAddress).toHaveBeenCalledWith('peer-a', '02:00:00:00:00:0A', 'Device A');
  });

  test('ignores PEER_CONNECTED from an earlier connection attempt', async () => {
    const tracker = createConnectionAddressTracker();
    const savePeerAddress = jest.fn().mockResolvedValue();

    expect(tracker.activateConnection(1)).toBe(true);
    expect(tracker.activateConnection(2)).toBe(true);
    tracker.setIdentity({ peerId: 'peer-new', deviceName: 'New', targetPeer: {} });

    expect(tracker.activateConnection(1)).toBe(false);
    expect(tracker.setConnectedPeerAddress(1, '02:00:00:00:00:0B')).toBe(false);
    await expect(saveResolvedPeerAddress(tracker, savePeerAddress)).resolves.toBe(false);
    expect(savePeerAddress).not.toHaveBeenCalled();
  });

  test('rejects PEER_CONNECTED after disconnect and accepts the next generation', async () => {
    const tracker = createConnectionAddressTracker();
    const savePeerAddress = jest.fn().mockResolvedValue();

    expect(tracker.activateConnection(1)).toBe(true);
    tracker.setIdentity({ peerId: 'peer-b', deviceName: 'Device B', targetPeer: {} });
    tracker.clear();

    expect(tracker.activateConnection(1)).toBe(false);
    expect(tracker.setConnectedPeerAddress(1, '02:00:00:00:00:0B')).toBe(false);
    await expect(saveResolvedPeerAddress(tracker, savePeerAddress)).resolves.toBe(false);
    expect(savePeerAddress).not.toHaveBeenCalled();

    expect(tracker.activateConnection(2)).toBe(true);
    expect(tracker.activateConnection(2)).toBe(true);
  });

  test('does not save an empty resolved address', async () => {
    const tracker = createConnectionAddressTracker();
    const savePeerAddress = jest.fn().mockResolvedValue();

    tracker.activateConnection(1);
    tracker.setIdentity({ peerId: 'peer-b', deviceName: 'Device B', targetPeer: {} });
    expect(tracker.setConnectedPeerAddress(1, '   ')).toBe(false);

    await expect(saveResolvedPeerAddress(tracker, savePeerAddress)).resolves.toBe(false);
    expect(savePeerAddress).not.toHaveBeenCalled();
  });
});
