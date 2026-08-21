import { NativeModules } from 'react-native';
import { deriveG1Number, normalizeG1Number, normalizeUserId } from '../identity/G1Number';
import {
  createManualContactExpectation,
  createQrContactExpectation,
  encodeG1QrPayload,
  parseG1QrPayload,
} from '../identity/G1SharePayload';

function nativeModule(name) {
  return NativeModules?.[name] || null;
}

function requireMethod(module, method, label) {
  if (!module || typeof module[method] !== 'function') {
    throw new Error(`${label || method} is unavailable in this build`);
  }
  return module[method].bind(module);
}

function requiredText(value, label, max = 8192) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}

export async function getOwnG1Identity() {
  const raw = await requireMethod(nativeModule('G1IdentityModule'), 'getUserIdentity', 'G1 identity')();
  const userId = normalizeUserId(raw?.userId);
  if (!userId) throw new Error('Native G1 identity returned an invalid full userId');
  const g1Number = deriveG1Number(userId);
  if (raw?.g1Number && normalizeG1Number(raw.g1Number) !== g1Number) {
    throw new Error('Native G1 Number does not match the full user identity commitment');
  }
  return {
    ...raw,
    genesisVersion: Number(raw?.genesisVersion) || 1,
    userId,
    g1Number,
    profileName: typeof raw?.profileName === 'string' ? raw.profileName : '',
    rootPublicKeySpki: requiredText(raw?.rootPublicKeySpki, 'G1 root public key'),
    recoveryPublicKeySpki: requiredText(raw?.recoveryPublicKeySpki, 'G1 recovery public key'),
  };
}

export async function setOwnProfileName(profileName) {
  const name = typeof profileName === 'string' ? profileName.trim().slice(0, 80) : '';
  await requireMethod(nativeModule('G1IdentityModule'), 'setProfileName', 'G1 profile name')(name);
  return getOwnG1Identity();
}

export async function createG1AuthNonce() {
  return requiredText(
    await requireMethod(nativeModule('G1IdentityModule'), 'createAuthNonce', 'G1 auth nonce')(),
    'G1 auth nonce',
    256
  );
}

export async function signG1SessionAuth({
  purpose,
  requestId,
  challenge,
  signerUserId,
  signerDeviceId,
  challengerUserId,
  challengerDeviceId,
} = {}) {
  const signature = await requireMethod(nativeModule('G1IdentityModule'), 'signSessionAuth', 'G1 session signer')(
    requiredText(purpose, 'G1 auth purpose', 32),
    requiredText(requestId, 'G1 auth requestId', 256),
    requiredText(challenge, 'G1 auth challenge', 256),
    normalizeUserId(signerUserId) || '',
    requiredText(signerDeviceId, 'signer deviceId', 200),
    normalizeUserId(challengerUserId) || '',
    requiredText(challengerDeviceId, 'challenger deviceId', 200)
  );
  return requiredText(signature, 'G1 auth signature', 8192);
}

export async function verifyG1SessionAuth({
  rootPublicKeySpki,
  recoveryPublicKeySpki,
  claimedUserId,
  claimedG1Number,
  purpose,
  requestId,
  challenge,
  signerDeviceId,
  challengerUserId,
  challengerDeviceId,
  signature,
} = {}) {
  const result = await requireMethod(nativeModule('G1IdentityModule'), 'verifySessionAuth', 'G1 session verifier')(
    requiredText(rootPublicKeySpki, 'G1 root public key'),
    requiredText(recoveryPublicKeySpki, 'G1 recovery public key'),
    normalizeUserId(claimedUserId) || '',
    normalizeG1Number(claimedG1Number) || '',
    requiredText(purpose, 'G1 auth purpose', 32),
    requiredText(requestId, 'G1 auth requestId', 256),
    requiredText(challenge, 'G1 auth challenge', 256),
    requiredText(signerDeviceId, 'signer deviceId', 200),
    normalizeUserId(challengerUserId) || '',
    requiredText(challengerDeviceId, 'challenger deviceId', 200),
    requiredText(signature, 'G1 auth signature', 8192)
  );
  const userId = normalizeUserId(result?.userId);
  const g1Number = normalizeG1Number(result?.g1Number);
  return {
    verified: result?.verified === true && !!userId && !!g1Number,
    reason: typeof result?.reason === 'string' ? result.reason : 'VERIFY_RESULT_INVALID',
    userId,
    g1Number,
    rootKeyFingerprint:
      typeof result?.rootKeyFingerprint === 'string' && result.rootKeyFingerprint.trim()
        ? result.rootKeyFingerprint.trim().toLowerCase()
        : null,
  };
}

export function buildOwnQrPayload(identity) {
  return encodeG1QrPayload({
    userId: identity?.userId,
    profileName: identity?.profileName || '',
  });
}

export async function renderG1QrDataUri(payload, size = 720) {
  return requireMethod(nativeModule('G1QrModule'), 'renderQrDataUri', 'G1 QR renderer')(payload, size);
}

export async function copyG1Number(g1Number) {
  const normalized = normalizeG1Number(g1Number);
  if (!normalized) throw new Error('Invalid G1 Number');
  return requireMethod(nativeModule('G1QrModule'), 'copyText', 'Clipboard')(normalized);
}

export async function shareG1Qr(payload, g1Number) {
  const normalized = normalizeG1Number(g1Number);
  if (!normalized) throw new Error('Invalid G1 Number');
  return requireMethod(nativeModule('G1QrModule'), 'shareQrCode', 'G1 QR sharing')(payload, normalized);
}

export async function scanG1Qr() {
  const raw = await requireMethod(nativeModule('G1QrModule'), 'scanQrCode', 'G1 QR scanner')();
  if (!raw) return null;
  return parseG1QrPayload(raw);
}

async function persistExpectation(expectation) {
  const save = requireMethod(nativeModule('G1ContactModule'), 'upsertContact', 'G1 contact storage');
  return save(
    expectation.g1Number,
    expectation.userId || null,
    expectation.profileName || '',
    expectation.localAlias || '',
    expectation.source
  );
}

export async function saveManualG1Contact(g1Number, localAlias = '') {
  return persistExpectation(createManualContactExpectation(g1Number, localAlias));
}

export async function saveQrG1Contact(qrOrParsedPayload, localAlias = '') {
  return persistExpectation(createQrContactExpectation(qrOrParsedPayload, localAlias));
}

export async function listG1Contacts() {
  const list = await requireMethod(nativeModule('G1ContactModule'), 'listContacts', 'G1 contact storage')();
  return Array.isArray(list) ? list : [];
}

export async function deleteG1Contact(g1Number) {
  const normalized = normalizeG1Number(g1Number);
  if (!normalized) return false;
  return requireMethod(nativeModule('G1ContactModule'), 'deleteContact', 'G1 contact storage')(normalized);
}
