import {
  g1NumberMatchesUserId,
  normalizeG1Number,
  normalizeUserId,
} from './G1Number';
import {
  IDENTITY_SOURCE,
  IDENTITY_TRUST,
  buildAdditivePeerIdentity,
} from '../network/IdentityModel';
import {
  createG1AuthNonce,
  getOwnG1Identity,
  signG1SessionAuth,
  verifyG1SessionAuth,
} from '../services/G1IdentityService';

export const G1_AUTH_VERSION = 1;
export const G1_AUTH_PURPOSE = {
  PROOF: 'PROOF',
  CONFIRM: 'CONFIRM',
};
export const G1_AUTH_MESSAGE = {
  HELLO: 'g1-auth-hello',
  PROOF: 'g1-auth-proof',
  ACK: 'g1-auth-ack',
  CONFIRM: 'g1-auth-confirm',
  ERROR: 'g1-auth-error',
};

const AUTH_MESSAGE_TYPES = new Set(Object.values(G1_AUTH_MESSAGE));
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_PENDING_RESPONDERS = 8;

function text(value, max = 4096) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return '';
  return trimmed;
}

function normalizeClaim(raw) {
  const userId = normalizeUserId(raw?.userId);
  const g1Number = normalizeG1Number(raw?.g1Number);
  const deviceId = text(raw?.deviceId, 200);
  const rootPublicKeySpki = text(raw?.rootPublicKeySpki, 4096);
  const recoveryPublicKeySpki = text(raw?.recoveryPublicKeySpki, 4096);
  if (
    Number(raw?.genesisVersion) !== 1 ||
    !userId ||
    !g1Number ||
    !deviceId ||
    !rootPublicKeySpki ||
    !recoveryPublicKeySpki ||
    !g1NumberMatchesUserId(g1Number, userId)
  ) {
    return null;
  }
  return {
    genesisVersion: 1,
    userId,
    g1Number,
    deviceId,
    deviceName: text(raw?.deviceName, 120) || 'G1 Device',
    profileName: text(raw?.profileName, 80),
    rootPublicKeySpki,
    recoveryPublicKeySpki,
  };
}

function normalizeExpected(expected = {}) {
  const rawUserId = typeof expected?.userId === 'string' ? expected.userId.trim() : '';
  const rawG1Number = typeof expected?.g1Number === 'string' ? expected.g1Number.trim() : '';
  const rawDeviceId = typeof (expected?.deviceId || expected?.peerId) === 'string'
    ? (expected.deviceId || expected.peerId).trim()
    : '';
  const userId = normalizeUserId(rawUserId);
  const g1Number = normalizeG1Number(rawG1Number);
  const deviceId = text(rawDeviceId, 200);
  return {
    userId,
    g1Number,
    deviceId,
    invalidReason:
      rawUserId && !userId
        ? 'INVALID_EXPECTED_USER_ID'
        : rawG1Number && !g1Number
          ? 'INVALID_EXPECTED_G1_NUMBER'
          : rawDeviceId && !deviceId
            ? 'INVALID_EXPECTED_DEVICE_ID'
            : null,
  };
}

export function evaluateExpectedIdentity(expected, proven) {
  const normalized = normalizeExpected(expected);
  if (normalized.invalidReason) {
    return { matched: false, reason: normalized.invalidReason };
  }
  const provenUserId = normalizeUserId(proven?.userId);
  const provenNumber = normalizeG1Number(proven?.g1Number);
  const provenDeviceId = text(proven?.deviceId, 200);
  if (!provenUserId || !provenNumber || !provenDeviceId) {
    return { matched: false, reason: 'INVALID_PROVEN_IDENTITY' };
  }
  if (!g1NumberMatchesUserId(provenNumber, provenUserId)) {
    return { matched: false, reason: 'INVALID_PROVEN_G1_NUMBER' };
  }
  if (normalized.userId && normalized.userId !== provenUserId) {
    return { matched: false, reason: 'USER_ID_MISMATCH' };
  }
  if (normalized.g1Number && normalized.g1Number !== provenNumber) {
    return { matched: false, reason: 'G1_NUMBER_MISMATCH' };
  }
  if (normalized.deviceId && normalized.deviceId !== provenDeviceId) {
    return { matched: false, reason: 'DEVICE_ID_MISMATCH' };
  }
  return {
    matched: true,
    reason: normalized.userId
      ? 'FULL_USER_ID_MATCH'
      : normalized.g1Number
        ? 'G1_NUMBER_MATCH'
        : normalized.deviceId
          ? 'DEVICE_ID_TOFU_MATCH'
          : 'NEW_TOFU_IDENTITY',
  };
}

function provenIdentityFromClaim(claim, verification, expectation) {
  return {
    ...buildAdditivePeerIdentity({
      deviceId: claim.deviceId,
      userId: verification.userId,
      g1Number: verification.g1Number,
      displayName: claim.profileName || claim.deviceName,
      deviceName: claim.deviceName,
      keyFingerprint: verification.rootKeyFingerprint,
      trust: IDENTITY_TRUST.SESSION_PROVEN,
      source: IDENTITY_SOURCE.SESSION_PROOF,
    }),
    g1Number: verification.g1Number,
    profileName: claim.profileName || '',
    genesisVersion: claim.genesisVersion,
    rootPublicKeySpki: claim.rootPublicKeySpki,
    recoveryPublicKeySpki: claim.recoveryPublicKeySpki,
    continuity: expectation?.reason || 'NEW_TOFU_IDENTITY',
  };
}

function asError(reason) {
  const error = new Error(`G1 identity authentication failed: ${reason}`);
  error.code = reason;
  return error;
}

export class IdentityAuthenticator {
  constructor(options = {}) {
    this.signalingOwner = options.signalingOwner || null;
    this.getOwnIdentity = options.getOwnIdentity || getOwnG1Identity;
    this.createNonce = options.createNonce || createG1AuthNonce;
    this.signAuth = options.signAuth || signG1SessionAuth;
    this.verifyAuth = options.verifyAuth || verifyG1SessionAuth;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.localDeviceIdentity = null;
    this.messageSubscription = null;
    this.disconnectSubscription = null;
    this.pendingInitiators = new Map();
    this.pendingResponders = new Map();
    this.proofObservers = new Set();
  }

  setSignalingOwner(owner) {
    if (owner === this.signalingOwner) return;
    this.stop();
    this.signalingOwner = owner || null;
  }

  setLocalDeviceIdentity({ deviceId, deviceName } = {}) {
    const stableDeviceId = text(deviceId, 200);
    this.localDeviceIdentity = stableDeviceId
      ? {
          deviceId: stableDeviceId,
          deviceName: text(deviceName, 120) || 'G1 Device',
        }
      : null;
  }

  start() {
    if (this.messageSubscription) return this.messageSubscription;
    if (!this.signalingOwner || typeof this.signalingOwner.subscribeMessage !== 'function') {
      throw new Error('IdentityAuthenticator requires signaling message subscription');
    }
    this.messageSubscription = this.signalingOwner.subscribeMessage(msg => {
      if (!AUTH_MESSAGE_TYPES.has(msg?.type)) return false;
      Promise.resolve(this._handleAuthMessage(msg)).catch(error => {
        console.warn('[G1/AUTH] control message failed:', error?.message || error);
      });
      return true;
    });
    if (typeof this.signalingOwner.subscribeDisconnect === 'function') {
      this.disconnectSubscription = this.signalingOwner.subscribeDisconnect(() => {
        this._rejectAll('SIGNALING_DISCONNECTED');
      });
    }
    return this.messageSubscription;
  }

  stop() {
    try {
      if (typeof this.messageSubscription === 'function') this.messageSubscription();
      else this.messageSubscription?.remove?.();
    } catch (e) {}
    try {
      if (typeof this.disconnectSubscription === 'function') this.disconnectSubscription();
      else this.disconnectSubscription?.remove?.();
    } catch (e) {}
    this.messageSubscription = null;
    this.disconnectSubscription = null;
    this._rejectAll('AUTHENTICATOR_STOPPED');
  }

  cancelAuthentication(reason = 'AUTH_CANCELLED') {
    for (const requestId of Array.from(this.pendingInitiators.keys())) {
      const state = this._clearInitiator(requestId);
      this._sendError(requestId, reason);
      state?.reject?.(asError(reason));
    }
    for (const requestId of Array.from(this.pendingResponders.keys())) {
      this._clearResponder(requestId);
      this._sendError(requestId, reason);
    }
  }

  subscribeProvenIdentity(observer) {
    if (typeof observer !== 'function') return { remove() {} };
    this.proofObservers.add(observer);
    return { remove: () => this.proofObservers.delete(observer) };
  }

  _notifyProven(identity, details = {}) {
    this.proofObservers.forEach(observer => {
      try { observer(identity, details); } catch (e) {}
    });
  }

  _rejectAll(reason) {
    for (const [requestId, state] of this.pendingInitiators) {
      this._clearInitiator(requestId);
      state.reject?.(asError(reason));
    }
    for (const requestId of Array.from(this.pendingResponders.keys())) {
      this._clearResponder(requestId);
    }
  }

  _clearInitiator(requestId) {
    const state = this.pendingInitiators.get(requestId);
    if (state?.timer) clearTimeout(state.timer);
    this.pendingInitiators.delete(requestId);
    return state || null;
  }

  _clearResponder(requestId) {
    const state = this.pendingResponders.get(requestId);
    if (state?.timer) clearTimeout(state.timer);
    this.pendingResponders.delete(requestId);
    return state || null;
  }

  _send(message) {
    return !!this.signalingOwner?.sendMessage?.(message);
  }

  _sendError(requestId, reason) {
    if (!requestId) return;
    this._send({
      type: G1_AUTH_MESSAGE.ERROR,
      v: G1_AUTH_VERSION,
      requestId,
      reason,
    });
  }

  async _localClaim() {
    if (!this.localDeviceIdentity?.deviceId) {
      throw asError('LOCAL_DEVICE_ID_UNAVAILABLE');
    }
    const identity = await this.getOwnIdentity();
    const claim = normalizeClaim({
      ...identity,
      deviceId: this.localDeviceIdentity.deviceId,
      deviceName: this.localDeviceIdentity.deviceName,
    });
    if (!claim) throw asError('LOCAL_USER_IDENTITY_INVALID');
    return claim;
  }

  _activeSessionReady() {
    const session = this.signalingOwner?.getActiveSession?.();
    return !!(session && session.isConnected !== false);
  }

  async authenticatePeer({ expectedIdentity = {}, timeoutMs = this.timeoutMs } = {}) {
    this.start();
    if (!this._activeSessionReady()) {
      throw asError('SIGNALING_SESSION_UNAVAILABLE');
    }
    if (this.pendingInitiators.size > 0) {
      throw asError('AUTHENTICATION_ALREADY_IN_PROGRESS');
    }

    const localClaim = await this._localClaim();
    const requestId = await this.createNonce();
    const challenge = await this.createNonce();
    if (!text(requestId, 256) || !text(challenge, 256) || requestId === challenge) {
      throw asError('NONCE_GENERATION_FAILED');
    }

    return new Promise((resolve, reject) => {
      const state = {
        requestId,
        challenge,
        localClaim,
        expectedIdentity,
        resolve,
        reject,
        stage: 'WAIT_PROOF',
        remoteClaim: null,
        responderChallenge: null,
        provenIdentity: null,
        timer: null,
      };
      state.timer = setTimeout(() => {
        if (!this.pendingInitiators.has(requestId)) return;
        this._clearInitiator(requestId);
        this._sendError(requestId, 'AUTH_TIMEOUT');
        reject(asError('AUTH_TIMEOUT'));
      }, Math.max(1000, Number(timeoutMs) || this.timeoutMs));
      this.pendingInitiators.set(requestId, state);

      const sent = this._send({
        type: G1_AUTH_MESSAGE.HELLO,
        v: G1_AUTH_VERSION,
        requestId,
        challenge,
        claim: localClaim,
      });
      if (!sent) {
        this._clearInitiator(requestId);
        reject(asError('AUTH_HELLO_SEND_FAILED'));
      }
    });
  }

  async _handleAuthMessage(msg) {
    if (Number(msg?.v) !== G1_AUTH_VERSION) return;
    const requestId = text(msg?.requestId, 256);
    if (!requestId) return;
    switch (msg.type) {
      case G1_AUTH_MESSAGE.HELLO:
        await this._handleHello(requestId, msg);
        break;
      case G1_AUTH_MESSAGE.PROOF:
        await this._handleProof(requestId, msg);
        break;
      case G1_AUTH_MESSAGE.ACK:
        await this._handleAck(requestId, msg);
        break;
      case G1_AUTH_MESSAGE.CONFIRM:
        await this._handleConfirm(requestId, msg);
        break;
      case G1_AUTH_MESSAGE.ERROR:
        this._handleRemoteError(requestId, msg);
        break;
      default:
        break;
    }
  }

  async _handleHello(requestId, msg) {
    if (this.pendingResponders.has(requestId)) return;
    if (this.pendingResponders.size >= MAX_PENDING_RESPONDERS) {
      this._sendError(requestId, 'AUTH_BUSY');
      return;
    }
    const remoteClaim = normalizeClaim(msg.claim);
    const remoteChallenge = text(msg.challenge, 256);
    if (!remoteClaim || !remoteChallenge) {
      this._sendError(requestId, 'INVALID_HELLO');
      return;
    }

    const localClaim = await this._localClaim();
    const localChallenge = await this.createNonce();
    const signature = await this.signAuth({
      purpose: G1_AUTH_PURPOSE.PROOF,
      requestId,
      challenge: remoteChallenge,
      signerUserId: localClaim.userId,
      signerDeviceId: localClaim.deviceId,
      challengerUserId: remoteClaim.userId,
      challengerDeviceId: remoteClaim.deviceId,
    });

    const state = {
      requestId,
      localClaim,
      remoteClaim,
      remoteChallenge,
      localChallenge,
      stage: 'WAIT_ACK',
      timer: setTimeout(() => this._clearResponder(requestId), this.timeoutMs),
    };
    this.pendingResponders.set(requestId, state);

    if (!this._send({
      type: G1_AUTH_MESSAGE.PROOF,
      v: G1_AUTH_VERSION,
      requestId,
      challenge: localChallenge,
      claim: localClaim,
      signature,
    })) {
      this._clearResponder(requestId);
    }
  }

  async _handleProof(requestId, msg) {
    const state = this.pendingInitiators.get(requestId);
    if (!state || state.stage !== 'WAIT_PROOF') return;
    state.stage = 'VERIFYING_PROOF';

    const remoteClaim = normalizeClaim(msg.claim);
    const responderChallenge = text(msg.challenge, 256);
    const signature = text(msg.signature, 8192);
    if (!remoteClaim || !responderChallenge || !signature) {
      this._failInitiator(requestId, 'INVALID_PROOF');
      return;
    }

    try {
      const verification = await this.verifyAuth({
        rootPublicKeySpki: remoteClaim.rootPublicKeySpki,
        recoveryPublicKeySpki: remoteClaim.recoveryPublicKeySpki,
        claimedUserId: remoteClaim.userId,
        claimedG1Number: remoteClaim.g1Number,
        purpose: G1_AUTH_PURPOSE.PROOF,
        requestId,
        challenge: state.challenge,
        signerDeviceId: remoteClaim.deviceId,
        challengerUserId: state.localClaim.userId,
        challengerDeviceId: state.localClaim.deviceId,
        signature,
      });
      if (verification?.verified !== true) {
        this._failInitiator(requestId, verification?.reason || 'REMOTE_PROOF_INVALID');
        return;
      }

      const expectation = evaluateExpectedIdentity(state.expectedIdentity, {
        userId: verification.userId,
        g1Number: verification.g1Number,
        deviceId: remoteClaim.deviceId,
      });
      if (!expectation.matched) {
        this._failInitiator(requestId, expectation.reason);
        return;
      }

      const ackSignature = await this.signAuth({
        purpose: G1_AUTH_PURPOSE.PROOF,
        requestId,
        challenge: responderChallenge,
        signerUserId: state.localClaim.userId,
        signerDeviceId: state.localClaim.deviceId,
        challengerUserId: verification.userId,
        challengerDeviceId: remoteClaim.deviceId,
      });

      state.remoteClaim = remoteClaim;
      state.responderChallenge = responderChallenge;
      state.provenIdentity = provenIdentityFromClaim(remoteClaim, verification, expectation);
      state.stage = 'WAIT_CONFIRM';
      if (!this._send({
        type: G1_AUTH_MESSAGE.ACK,
        v: G1_AUTH_VERSION,
        requestId,
        signature: ackSignature,
      })) {
        this._failInitiator(requestId, 'AUTH_ACK_SEND_FAILED');
      }
    } catch (error) {
      this._failInitiator(requestId, error?.code || 'REMOTE_PROOF_ERROR');
    }
  }

  async _handleAck(requestId, msg) {
    const state = this.pendingResponders.get(requestId);
    if (!state || state.stage !== 'WAIT_ACK') return;
    state.stage = 'VERIFYING_ACK';
    const signature = text(msg.signature, 8192);
    if (!signature) {
      this._clearResponder(requestId);
      this._sendError(requestId, 'INVALID_ACK');
      return;
    }

    try {
      const verification = await this.verifyAuth({
        rootPublicKeySpki: state.remoteClaim.rootPublicKeySpki,
        recoveryPublicKeySpki: state.remoteClaim.recoveryPublicKeySpki,
        claimedUserId: state.remoteClaim.userId,
        claimedG1Number: state.remoteClaim.g1Number,
        purpose: G1_AUTH_PURPOSE.PROOF,
        requestId,
        challenge: state.localChallenge,
        signerDeviceId: state.remoteClaim.deviceId,
        challengerUserId: state.localClaim.userId,
        challengerDeviceId: state.localClaim.deviceId,
        signature,
      });
      if (verification?.verified !== true) {
        this._clearResponder(requestId);
        this._sendError(requestId, verification?.reason || 'ACK_PROOF_INVALID');
        return;
      }

      const confirmSignature = await this.signAuth({
        purpose: G1_AUTH_PURPOSE.CONFIRM,
        requestId,
        challenge: state.localChallenge,
        signerUserId: state.localClaim.userId,
        signerDeviceId: state.localClaim.deviceId,
        challengerUserId: verification.userId,
        challengerDeviceId: state.remoteClaim.deviceId,
      });
      const proven = provenIdentityFromClaim(
        state.remoteClaim,
        verification,
        { reason: 'RESPONDER_SESSION_PROOF' }
      );
      this._clearResponder(requestId);
      if (this._send({
        type: G1_AUTH_MESSAGE.CONFIRM,
        v: G1_AUTH_VERSION,
        requestId,
        signature: confirmSignature,
      })) {
        this._notifyProven(proven, { role: 'responder', requestId });
      }
    } catch (error) {
      this._clearResponder(requestId);
      this._sendError(requestId, error?.code || 'ACK_PROOF_ERROR');
    }
  }

  async _handleConfirm(requestId, msg) {
    const state = this.pendingInitiators.get(requestId);
    if (!state || state.stage !== 'WAIT_CONFIRM' || !state.remoteClaim || !state.provenIdentity) return;
    state.stage = 'VERIFYING_CONFIRM';
    const signature = text(msg.signature, 8192);
    if (!signature) {
      this._failInitiator(requestId, 'INVALID_CONFIRM');
      return;
    }

    try {
      const verification = await this.verifyAuth({
        rootPublicKeySpki: state.remoteClaim.rootPublicKeySpki,
        recoveryPublicKeySpki: state.remoteClaim.recoveryPublicKeySpki,
        claimedUserId: state.remoteClaim.userId,
        claimedG1Number: state.remoteClaim.g1Number,
        purpose: G1_AUTH_PURPOSE.CONFIRM,
        requestId,
        challenge: state.responderChallenge,
        signerDeviceId: state.remoteClaim.deviceId,
        challengerUserId: state.localClaim.userId,
        challengerDeviceId: state.localClaim.deviceId,
        signature,
      });
      if (verification?.verified !== true) {
        this._failInitiator(requestId, verification?.reason || 'CONFIRM_PROOF_INVALID');
        return;
      }

      const completed = this._clearInitiator(requestId);
      if (!completed) return;
      this._notifyProven(completed.provenIdentity, { role: 'initiator', requestId });
      completed.resolve(completed.provenIdentity);
    } catch (error) {
      this._failInitiator(requestId, error?.code || 'CONFIRM_PROOF_ERROR');
    }
  }

  _handleRemoteError(requestId, msg) {
    const state = this._clearInitiator(requestId);
    if (state) state.reject(asError(text(msg.reason, 120) || 'REMOTE_AUTH_ERROR'));
    this._clearResponder(requestId);
  }

  _failInitiator(requestId, reason) {
    const state = this._clearInitiator(requestId);
    this._sendError(requestId, reason);
    if (state) state.reject(asError(reason));
  }
}

export default IdentityAuthenticator;
