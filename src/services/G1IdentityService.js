import { NativeModules } from 'react-native';
import { deriveG1Number, normalizeG1Number, normalizeUserId } from '../identity/G1Number';
import {
  createManualContactExpectation,
  createQrContactExpectation,
  encodeG1QrPayload,
  parseG1QrPayload,
} from '../identity/G1SharePayload';

const identityNative = NativeModules.G1IdentityModule;
const contactNative = NativeModules.G1ContactModule;
const qrNative = NativeModules.G1QrModule;

function requireMethod(module, method, label) {
  if (!module || typeof module[method] !== 'function') {
    throw new Error(`${label || method} is unavailable in this build`);
  }
  return module[method].bind(module);
}

export async function getOwnG1Identity() {
  const raw = await requireMethod(identityNative, 'getUserIdentity', 'G1 identity')();
  const userId = normalizeUserId(raw?.userId);
  if (!userId) throw new Error('Native G1 identity returned an invalid full userId');
  const g1Number = deriveG1Number(userId);
  if (raw?.g1Number && normalizeG1Number(raw.g1Number) !== g1Number) {
    throw new Error('Native G1 Number does not match the full user identity commitment');
  }
  return {
    ...raw,
    userId,
    g1Number,
    profileName: typeof raw?.profileName === 'string' ? raw.profileName : '',
  };
}

export async function setOwnProfileName(profileName) {
  const name = typeof profileName === 'string' ? profileName.trim().slice(0, 80) : '';
  await requireMethod(identityNative, 'setProfileName', 'G1 profile name')(name);
  return getOwnG1Identity();
}

export function buildOwnQrPayload(identity) {
  return encodeG1QrPayload({
    userId: identity?.userId,
    profileName: identity?.profileName || '',
  });
}

export async function renderG1QrDataUri(payload, size = 720) {
  return requireMethod(qrNative, 'renderQrDataUri', 'G1 QR renderer')(payload, size);
}

export async function copyG1Number(g1Number) {
  const normalized = normalizeG1Number(g1Number);
  if (!normalized) throw new Error('Invalid G1 Number');
  return requireMethod(qrNative, 'copyText', 'Clipboard')(normalized);
}

export async function shareG1Qr(payload, g1Number) {
  const normalized = normalizeG1Number(g1Number);
  if (!normalized) throw new Error('Invalid G1 Number');
  return requireMethod(qrNative, 'shareQrCode', 'G1 QR sharing')(payload, normalized);
}

export async function scanG1Qr() {
  const raw = await requireMethod(qrNative, 'scanQrCode', 'G1 QR scanner')();
  if (!raw) return null;
  return parseG1QrPayload(raw);
}

async function persistExpectation(expectation) {
  const save = requireMethod(contactNative, 'upsertContact', 'G1 contact storage');
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
  const list = await requireMethod(contactNative, 'listContacts', 'G1 contact storage')();
  return Array.isArray(list) ? list : [];
}

export async function deleteG1Contact(g1Number) {
  const normalized = normalizeG1Number(g1Number);
  if (!normalized) return false;
  return requireMethod(contactNative, 'deleteContact', 'G1 contact storage')(normalized);
}
