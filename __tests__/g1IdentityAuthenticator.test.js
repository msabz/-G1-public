jest.mock('../src/services/G1IdentityService', () => ({
  createG1AuthNonce: jest.fn(),
  getOwnG1Identity: jest.fn(),
  signG1SessionAuth: jest.fn(),
  verifyG1SessionAuth: jest.fn(),
}));

import { deriveG1Number } from '../src/identity/G1Number';
import {
  G1_AUTH_MESSAGE,
  IdentityAuthenticator,
  evaluateExpectedIdentity,
} from '../src/identity/IdentityAuthenticator';
import { IDENTITY_TRUST } from '../src/network/IdentityModel';

function makeIdentity(userHex, deviceId, name) {
  const userId = userHex.repeat(64).slice(0, 64);
  return {
    genesisVersion: 1,
    userId,
    g1Number: deriveG1Number(userId),
    profileName: name,
    rootPublicKeySpki: `root-${deviceId}`,
    recoveryPublicKeySpki: `recovery-${deviceId}`,
  };
}

function signatureFor({
  purpose,
  requestId,
  challenge,
  signerUserId,
  signerDeviceId,
  challengerUserId,
  challengerDeviceId,
}) {
  return [
    'sig', purpose, requestId, challenge, signerUserId, signerDeviceId,
    challengerUserId, challengerDeviceId,
  ].join('|');
}

function makeCrypto(identity) {
  return {
    getOwnIdentity: jest.fn().mockResolvedValue(identity),
    signAuth: jest.fn(async args => signatureFor(args)),
    verifyAuth: jest.fn(async args => {
      const expected = signatureFor({
        purpose: args.purpose,
        requestId: args.requestId,
        challenge: args.challenge,
        signerUserId: args.claimedUserId,
        signerDeviceId: args.signerDeviceId,
        challengerUserId: args.challengerUserId,
        challengerDeviceId: args.challengerDeviceId,
      });
      return {
        verified: args.signature === expected,
        reason: args.signature === expected ? 'SESSION_PROVEN' : 'SIGNATURE_INVALID',
        userId: args.claimedUserId,
        g1Number: args.claimedG1Number,
        rootKeyFingerprint: `fp-${args.claimedUserId.slice(0, 8)}`,
      };
    }),
  };
}

function makeNonceFactory(prefix) {
  let index = 0;
  return jest.fn(async () => `${prefix}-${++index}-${'x'.repeat(24)}`);
}

function makeLinkedOwners() {
  const makeOwner = () => {
    const messageObservers = new Set();
    const disconnectObservers = new Set();
    return {
      peer: null,
      transformOutbound: null,
      getActiveSession: jest.fn(() => ({ isConnected: true })),
      subscribeMessage: jest.fn(observer => {
        messageObservers.add(observer);
        return { remove: () => messageObservers.delete(observer) };
      }),
      subscribeDisconnect: jest.fn(observer => {
        disconnectObservers.add(observer);
        return { remove: () => disconnectObservers.delete(observer) };
      }),
      sendMessage: jest.fn(function sendMessage(message) {
        const outgoing = this.transformOutbound ? this.transformOutbound({ ...message }) : message;
        Promise.resolve().then(() => {
          for (const observer of this.peer._messageObservers) observer(outgoing);
        });
        return true;
      }),
      disconnect() {
        for (const observer of disconnectObservers) observer({ reason: 'test-disconnect' });
      },
      _messageObservers: messageObservers,
    };
  };

  const left = makeOwner();
  const right = makeOwner();
  left.peer = right;
  right.peer = left;
  return { left, right };
}

async function flush(count = 12) {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
}

describe('G1 IdentityAuthenticator', () => {
  test('rejects malformed saved expectations instead of downgrading to TOFU', () => {
    const proven = {
      userId: 'a'.repeat(64),
      g1Number: deriveG1Number('a'.repeat(64)),
      deviceId: 'peer-device',
    };
    expect(evaluateExpectedIdentity({ userId: 'not-a-user-id' }, proven)).toEqual({
      matched: false,
      reason: 'INVALID_EXPECTED_USER_ID',
    });
    expect(evaluateExpectedIdentity({ g1Number: 'G1-bad' }, proven)).toEqual({
      matched: false,
      reason: 'INVALID_EXPECTED_G1_NUMBER',
    });
  });

  test('completes mutual nonce proof and returns SESSION_PROVEN identity', async () => {
    const alice = makeIdentity('a', 'alice-device', 'Alice');
    const bob = makeIdentity('b', 'bob-device', 'Bob');
    const owners = makeLinkedOwners();
    const aliceCrypto = makeCrypto(alice);
    const bobCrypto = makeCrypto(bob);
    const aliceAuth = new IdentityAuthenticator({
      signalingOwner: owners.left,
      createNonce: makeNonceFactory('alice'),
      ...aliceCrypto,
    });
    const bobAuth = new IdentityAuthenticator({
      signalingOwner: owners.right,
      createNonce: makeNonceFactory('bob'),
      ...bobCrypto,
    });
    aliceAuth.setLocalDeviceIdentity({ deviceId: 'alice-device', deviceName: 'Alice phone' });
    bobAuth.setLocalDeviceIdentity({ deviceId: 'bob-device', deviceName: 'Bob phone' });
    aliceAuth.start();
    bobAuth.start();

    const responderProof = jest.fn();
    bobAuth.subscribeProvenIdentity(responderProof);
    const result = await aliceAuth.authenticatePeer({
      expectedIdentity: {
        userId: bob.userId,
        g1Number: bob.g1Number,
        deviceId: 'bob-device',
      },
    });
    await flush();

    expect(result).toEqual(expect.objectContaining({
      userId: bob.userId,
      g1Number: bob.g1Number,
      deviceId: 'bob-device',
      trust: IDENTITY_TRUST.SESSION_PROVEN,
      continuity: 'FULL_USER_ID_MATCH',
    }));
    expect(aliceCrypto.verifyAuth).toHaveBeenCalledTimes(2);
    expect(bobCrypto.verifyAuth).toHaveBeenCalledTimes(1);
    expect(responderProof).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'alice-device', trust: IDENTITY_TRUST.SESSION_PROVEN }),
      expect.objectContaining({ role: 'responder' })
    );
  });

  test('rejects a cryptographically valid but unexpected pinned UserId', async () => {
    const alice = makeIdentity('a', 'alice-device', 'Alice');
    const bob = makeIdentity('b', 'bob-device', 'Bob');
    const other = makeIdentity('c', 'other-device', 'Other');
    const owners = makeLinkedOwners();
    const aliceAuth = new IdentityAuthenticator({
      signalingOwner: owners.left,
      createNonce: makeNonceFactory('alice'),
      ...makeCrypto(alice),
    });
    const bobAuth = new IdentityAuthenticator({
      signalingOwner: owners.right,
      createNonce: makeNonceFactory('bob'),
      ...makeCrypto(bob),
    });
    aliceAuth.setLocalDeviceIdentity({ deviceId: 'alice-device' });
    bobAuth.setLocalDeviceIdentity({ deviceId: 'bob-device' });
    aliceAuth.start();
    bobAuth.start();

    await expect(aliceAuth.authenticatePeer({
      expectedIdentity: {
        userId: other.userId,
        g1Number: other.g1Number,
        deviceId: 'bob-device',
      },
    })).rejects.toMatchObject({ code: 'USER_ID_MISMATCH' });
  });

  test('rejects tampered proof signatures and never returns a proven identity', async () => {
    const alice = makeIdentity('a', 'alice-device', 'Alice');
    const bob = makeIdentity('b', 'bob-device', 'Bob');
    const owners = makeLinkedOwners();
    owners.right.transformOutbound = message => (
      message.type === G1_AUTH_MESSAGE.PROOF
        ? { ...message, signature: `${message.signature}-tampered` }
        : message
    );
    const aliceAuth = new IdentityAuthenticator({
      signalingOwner: owners.left,
      createNonce: makeNonceFactory('alice'),
      ...makeCrypto(alice),
    });
    const bobAuth = new IdentityAuthenticator({
      signalingOwner: owners.right,
      createNonce: makeNonceFactory('bob'),
      ...makeCrypto(bob),
    });
    aliceAuth.setLocalDeviceIdentity({ deviceId: 'alice-device' });
    bobAuth.setLocalDeviceIdentity({ deviceId: 'bob-device' });
    aliceAuth.start();
    bobAuth.start();

    await expect(aliceAuth.authenticatePeer({
      expectedIdentity: { deviceId: 'bob-device' },
    })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });
});
