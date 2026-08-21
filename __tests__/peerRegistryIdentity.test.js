import { PeerRegistry } from '../src/network/PeerRegistry';
import { IDENTITY_SOURCE, IDENTITY_TRUST } from '../src/network/IdentityModel';

describe('PeerRegistry identity evidence', () => {
  test('stores SESSION_PROVEN evidence without changing route fields', () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    registry.upsertP2pPeer({
      deviceId: 'peer-1',
      deviceName: 'Peer phone',
      deviceAddress: 'AA:BB:CC:DD:EE:FF',
      isOnline: true,
    });

    const beforeRoute = { ...registry.getPeer('peer-1').transports.P2P };
    const result = registry.upsertPeerIdentity({
      deviceId: 'peer-1',
      userId: 'a'.repeat(64),
      g1Number: 'G1-PROVEN',
      keyFingerprint: 'fingerprint',
      displayName: 'Alice',
      trust: IDENTITY_TRUST.SESSION_PROVEN,
      source: IDENTITY_SOURCE.SESSION_PROOF,
    });

    expect(result).toEqual(expect.objectContaining({
      userId: 'a'.repeat(64),
      g1Number: 'G1-PROVEN',
      keyFingerprint: 'fingerprint',
      identityDisplayName: 'Alice',
      identityTrust: IDENTITY_TRUST.SESSION_PROVEN,
      identitySource: IDENTITY_SOURCE.SESSION_PROOF,
    }));
    expect(result.transports.P2P).toEqual(beforeRoute);
  });

  test('does not downgrade SESSION_PROVEN identity with a later discovery claim', () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    registry.upsertPeerIdentity({
      deviceId: 'peer-1',
      userId: 'a'.repeat(64),
      g1Number: 'G1-PROVEN',
      keyFingerprint: 'proven-fp',
      trust: IDENTITY_TRUST.SESSION_PROVEN,
      source: IDENTITY_SOURCE.SESSION_PROOF,
    });

    registry.upsertPeerIdentity({
      deviceId: 'peer-1',
      userId: 'b'.repeat(64),
      g1Number: 'G1-CLAIMED',
      keyFingerprint: 'claimed-fp',
      trust: IDENTITY_TRUST.DISCOVERY_ASSERTED,
      source: IDENTITY_SOURCE.DNS_SD_TXT,
    });

    expect(registry.getPeer('peer-1')).toEqual(expect.objectContaining({
      userId: 'a'.repeat(64),
      g1Number: 'G1-PROVEN',
      keyFingerprint: 'proven-fp',
      identityTrust: IDENTITY_TRUST.SESSION_PROVEN,
      identitySource: IDENTITY_SOURCE.SESSION_PROOF,
    }));
  });

  test('rejects conflicting cryptographically proven identities for one DeviceId', () => {
    const registry = new PeerRegistry({ myDeviceId: 'self' });
    registry.upsertPeerIdentity({
      deviceId: 'peer-1',
      userId: 'a'.repeat(64),
      trust: IDENTITY_TRUST.SESSION_PROVEN,
      source: IDENTITY_SOURCE.SESSION_PROOF,
    });

    expect(() => registry.upsertPeerIdentity({
      deviceId: 'peer-1',
      userId: 'b'.repeat(64),
      trust: IDENTITY_TRUST.SESSION_PROVEN,
      source: IDENTITY_SOURCE.SESSION_PROOF,
    })).toThrow(/Conflicting cryptographically proven/);
  });
});
