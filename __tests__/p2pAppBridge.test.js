jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import { PeerRegistry, TRANSPORTS } from '../src/network/PeerRegistry';
import {
  buildCoordinatorP2pPeer,
  connectP2pFromApp,
  isCoordinatorOwnedP2pSession,
  resolveStableP2pDeviceId,
  shouldYieldNativeP2pEvent,
} from '../src/network/p2pAppBridge';

describe('p2pAppBridge', () => {
  test('never promotes raw Wi-Fi Direct address into G1 identity', () => {
    expect(resolveStableP2pDeviceId(
      {},
      { deviceAddress: 'AA:BB:CC:DD:EE:FF', deviceName: 'Nearby phone' }
    )).toBeNull();

    expect(() => buildCoordinatorP2pPeer({
      contact: {},
      discoveredPeer: { deviceAddress: 'AA:BB:CC:DD:EE:FF' },
      registry: new PeerRegistry({ myDeviceId: 'self' }),
    })).toThrow(/هوية G1 الثابتة/);
  });

  test('rejects a saved peerId/deviceId when it is only a Wi-Fi Direct route address', () => {
    expect(resolveStableP2pDeviceId(
      {
        peerId: 'AA:BB:CC:DD:EE:FF',
        deviceAddress: 'aa:bb:cc:dd:ee:ff',
      },
      { deviceAddress: '11:22:33:44:55:66' }
    )).toBeNull();

    expect(resolveStableP2pDeviceId(
      {
        deviceId: '11:22:33:44:55:66',
        deviceAddress: 'AA:BB:CC:DD:EE:FF',
      },
      { deviceAddress: '11:22:33:44:55:66' }
    )).toBeNull();
  });

  test('rejects a confirmed discovery peerId when it still equals the route address', () => {
    expect(resolveStableP2pDeviceId(
      { peerId: 'saved-id' },
      {
        isMusab: true,
        peerId: 'AA:BB:CC:DD:EE:FF',
        deviceAddress: 'aa:bb:cc:dd:ee:ff',
      }
    )).toBeNull();
  });

  test('prefers DNS-SD stable peerId for a confirmed G1 discovery', () => {
    expect(resolveStableP2pDeviceId(
      { peerId: 'saved-id' },
      { isMusab: true, peerId: 'dns-id', deviceAddress: 'AA:BB' }
    )).toBe('dns-id');
  });

  test('builds a current P2P registry endpoint from saved identity plus fresh route', () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    const result = buildCoordinatorP2pPeer({
      contact: {
        peerId: 'peer-id',
        customName: 'My peer',
        deviceAddress: 'OLD:ADDRESS',
      },
      discoveredPeer: {
        deviceAddress: 'AA:BB:CC:DD:EE:FF',
        deviceName: 'Current peer name',
        available: true,
      },
      registry,
    });

    expect(result.displayName).toBe('My peer');
    expect(result.peer.deviceId).toBe('peer-id');
    expect(result.peer.transports[TRANSPORTS.P2P]).toEqual(expect.objectContaining({
      deviceAddress: 'AA:BB:CC:DD:EE:FF',
      stale: false,
      isReachable: true,
    }));
  });

  test('connectP2pFromApp delegates logical ownership to coordinator and returns UI projection', async () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    const coordinator = {
      connectP2pPeer: jest.fn().mockResolvedValue({ isConnected: true }),
      getCoordinatorStatus: jest.fn(() => ({
        state: 'CONNECTED',
        transport: TRANSPORTS.P2P,
        peer: { deviceId: 'peer-id' },
        p2p: {
          activeRoute: {
            isGroupOwner: false,
            groupOwnerAddress: '192.168.49.1',
          },
        },
      })),
    };

    const result = await connectP2pFromApp({
      contact: { peerId: 'peer-id', name: 'Peer' },
      discoveredPeer: { deviceAddress: 'AA:BB:CC:DD:EE:FF' },
      incoming: true,
      timeoutMs: 25000,
      coordinator,
      registry,
    });

    expect(coordinator.connectP2pPeer).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'peer-id' }),
      25000,
      { incoming: true }
    );
    expect(result).toEqual(expect.objectContaining({
      displayName: 'Peer',
      controlOwner: 'COORDINATOR',
      transport: TRANSPORTS.P2P,
      route: expect.objectContaining({ groupOwnerAddress: '192.168.49.1' }),
    }));
  });

  test('does not report success when coordinator status diverges from requested peer', async () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    const coordinator = {
      connectP2pPeer: jest.fn().mockResolvedValue(undefined),
      getCoordinatorStatus: jest.fn(() => ({
        state: 'CONNECTED',
        transport: TRANSPORTS.P2P,
        peer: { deviceId: 'different-peer' },
      })),
    };

    await expect(connectP2pFromApp({
      contact: { peerId: 'peer-id' },
      discoveredPeer: { deviceAddress: 'AA:BB:CC:DD:EE:FF' },
      coordinator,
      registry,
    })).rejects.toThrow(/انتهت جلسة Wi-Fi Direct/);
  });

  test('recognizes only the exact coordinator-owned P2P peer', () => {
    const status = {
      state: 'CONNECTED',
      transport: TRANSPORTS.P2P,
      peer: { deviceId: 'peer-id' },
    };

    expect(isCoordinatorOwnedP2pSession(status, 'peer-id')).toBe(true);
    expect(isCoordinatorOwnedP2pSession(status, 'other')).toBe(false);
    expect(isCoordinatorOwnedP2pSession({ ...status, transport: TRANSPORTS.LAN }, 'peer-id')).toBe(false);
  });

  test('keeps a late native P2P event out of legacy signaling after fallback advances', () => {
    expect(shouldYieldNativeP2pEvent({
      coordinatorP2pAttemptActive: true,
      coordinatorStatus: {
        state: 'IDLE',
        transport: null,
        fallback: {
          pendingAttempt: { transport: TRANSPORTS.P2P },
        },
      },
    })).toBe(true);

    // The old P2P promise may still settle after AUTO has already started BT.
    // The global PEER_CONNECTED listener must remain owned by the selection,
    // rather than opening the legacy TCP signaling path over the new step.
    expect(shouldYieldNativeP2pEvent({
      coordinatorP2pAttemptActive: false,
      coordinatorStatus: {
        // The fallback record advances before the Bluetooth connector has to
        // mutate coordinator state, so ownership cannot rely on CONNECTING.
        state: 'IDLE',
        transport: null,
        fallback: {
          pendingAttempt: { transport: TRANSPORTS.BLUETOOTH },
        },
      },
    })).toBe(true);

    // A real legacy attempt has no coordinator/fallback owner. Its first
    // group event must still reach the epoch-pending queue.
    expect(shouldYieldNativeP2pEvent({
      coordinatorP2pAttemptActive: false,
      coordinatorStatus: {
        state: 'IDLE',
        transport: null,
        fallback: { pendingAttempt: null },
      },
    })).toBe(false);
  });
});
