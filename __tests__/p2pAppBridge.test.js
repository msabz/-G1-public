jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import { PeerRegistry, TRANSPORTS } from '../src/network/PeerRegistry';
import { IDENTITY_SOURCE, IDENTITY_TRUST } from '../src/network/IdentityModel';
import {
  buildCoordinatorP2pPeer,
  connectP2pFromApp,
  isCoordinatorOwnedP2pSession,
  resolveStableP2pDeviceId,
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

  test('prefers DNS-SD stable peerId only as a discovery-time expectation', () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    const result = buildCoordinatorP2pPeer({
      contact: { peerId: 'saved-id' },
      discoveredPeer: {
        isMusab: true,
        peerId: 'dns-id',
        deviceAddress: 'AA:BB:CC:DD:EE:FF',
      },
      registry,
    });

    expect(result.identity.deviceId).toBe('dns-id');
    expect(result.identity.trust).toBe(IDENTITY_TRUST.DISCOVERY_ASSERTED);
    expect(result.identity.source).toBe(IDENTITY_SOURCE.DNS_SD_TXT);
    expect(registry.getPeer('dns-id').identityTrust).toBe(IDENTITY_TRUST.DISCOVERY_ASSERTED);
  });

  test('builds a current P2P registry endpoint from saved expectation plus fresh route', () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    const result = buildCoordinatorP2pPeer({
      contact: {
        peerId: 'peer-id',
        userId: 'a'.repeat(64),
        g1Number: 'G1-EXPECTED',
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
    expect(result.identity).toEqual(expect.objectContaining({
      deviceId: 'peer-id',
      userId: 'a'.repeat(64),
      g1Number: 'G1-EXPECTED',
      trust: IDENTITY_TRUST.UNVERIFIED,
    }));
    expect(result.peer.deviceId).toBe('peer-id');
    expect(result.peer.transports[TRANSPORTS.P2P]).toEqual(expect.objectContaining({
      deviceAddress: 'AA:BB:CC:DD:EE:FF',
      stale: false,
      isReachable: true,
    }));
  });

  test('connectP2pFromApp passes ExpectedIdentity and returns only SESSION_PROVEN identity', async () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    const provenIdentity = {
      deviceId: 'peer-id',
      userId: 'b'.repeat(64),
      g1Number: 'G1-PROVEN',
      keyFingerprint: 'fp',
      trust: IDENTITY_TRUST.SESSION_PROVEN,
      source: IDENTITY_SOURCE.SESSION_PROOF,
    };
    const coordinator = {
      connectP2pPeer: jest.fn().mockResolvedValue({ isConnected: true }),
      getCoordinatorStatus: jest.fn(() => ({
        state: 'CONNECTED',
        transport: TRANSPORTS.P2P,
        peer: { deviceId: 'peer-id' },
        provenIdentity,
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
      {
        incoming: true,
        expectedIdentity: expect.objectContaining({
          deviceId: 'peer-id',
          trust: IDENTITY_TRUST.UNVERIFIED,
        }),
      }
    );
    expect(result).toEqual(expect.objectContaining({
      displayName: 'Peer',
      identity: provenIdentity,
      expectedIdentity: expect.objectContaining({ deviceId: 'peer-id' }),
      controlOwner: 'COORDINATOR',
      transport: TRANSPORTS.P2P,
      route: expect.objectContaining({ groupOwnerAddress: '192.168.49.1' }),
    }));
    expect(registry.getPeer('peer-id')).toEqual(expect.objectContaining({
      userId: 'b'.repeat(64),
      identityTrust: IDENTITY_TRUST.SESSION_PROVEN,
    }));
  });

  test('does not report success while coordinator is still AUTHENTICATING', async () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    const coordinator = {
      connectP2pPeer: jest.fn().mockResolvedValue(undefined),
      getCoordinatorStatus: jest.fn(() => ({
        state: 'AUTHENTICATING',
        transport: TRANSPORTS.P2P,
        peer: { deviceId: 'peer-id' },
        provenIdentity: null,
      })),
    };

    await expect(connectP2pFromApp({
      contact: { peerId: 'peer-id' },
      discoveredPeer: { deviceAddress: 'AA:BB:CC:DD:EE:FF' },
      coordinator,
      registry,
    })).rejects.toThrow(/إثبات هوية G1/);
  });

  test('does not report success for CONNECTED P2P without matching session proof', async () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    const coordinator = {
      connectP2pPeer: jest.fn().mockResolvedValue(undefined),
      getCoordinatorStatus: jest.fn(() => ({
        state: 'CONNECTED',
        transport: TRANSPORTS.P2P,
        peer: { deviceId: 'peer-id' },
        provenIdentity: {
          deviceId: 'different-peer',
          trust: IDENTITY_TRUST.SESSION_PROVEN,
        },
      })),
    };

    await expect(connectP2pFromApp({
      contact: { peerId: 'peer-id' },
      discoveredPeer: { deviceAddress: 'AA:BB:CC:DD:EE:FF' },
      coordinator,
      registry,
    })).rejects.toThrow(/إثبات هوية G1/);
  });

  test('recognizes only the exact cryptographically proven coordinator-owned P2P peer', () => {
    const status = {
      state: 'CONNECTED',
      transport: TRANSPORTS.P2P,
      peer: { deviceId: 'peer-id' },
      provenIdentity: {
        deviceId: 'peer-id',
        trust: IDENTITY_TRUST.SESSION_PROVEN,
      },
    };

    expect(isCoordinatorOwnedP2pSession(status, 'peer-id')).toBe(true);
    expect(isCoordinatorOwnedP2pSession(status, 'other')).toBe(false);
    expect(isCoordinatorOwnedP2pSession({ ...status, transport: TRANSPORTS.LAN }, 'peer-id')).toBe(false);
    expect(isCoordinatorOwnedP2pSession({ ...status, provenIdentity: null }, 'peer-id')).toBe(false);
  });
});
