import { PeerRegistry, PEER_STATUS, TRANSPORTS } from '../src/network/PeerRegistry';

describe('PeerRegistry disconnect status', () => {
  test.each([
    [true, PEER_STATUS.ONLINE],
    [false, PEER_STATUS.OFFLINE],
  ])('recomputes status from transport reachability (reachable=%s)', (isOnline, expectedStatus) => {
    const registry = new PeerRegistry();
    registry.upsertBluetoothPeer({
      deviceId: 'peer-1',
      address: 'AA:BB:CC:DD:EE:FF',
      isOnline,
    });
    registry.setPeerConnected('peer-1', TRANSPORTS.BLUETOOTH);

    registry.setPeerDisconnected('peer-1');

    expect(registry.getPeer('peer-1')).toEqual(expect.objectContaining({
      status: expectedStatus,
      connectedTransport: null,
    }));
  });
});
