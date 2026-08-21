import {
  deriveG1Number,
  g1NumberMatchesUserId,
  normalizeG1Number,
  normalizeUserId,
} from './G1Number';

export const G1_QR_SCHEME = 'g1://contact/v1';
export const G1_CONTACT_SOURCE = {
  MANUAL_NUMBER: 'MANUAL_NUMBER',
  QR_FULL_ID: 'QR_FULL_ID',
};

function cleanProfileName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 80);
}

function parseQuery(query) {
  const result = {};
  query.split('&').forEach(part => {
    if (!part) return;
    const separator = part.indexOf('=');
    const rawKey = separator >= 0 ? part.slice(0, separator) : part;
    const rawValue = separator >= 0 ? part.slice(separator + 1) : '';
    try {
      result[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch (error) {
      throw new Error('Malformed G1 QR payload encoding');
    }
  });
  return result;
}

export function encodeG1QrPayload({ userId, profileName = '' } = {}) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) throw new Error('Cannot create G1 QR without a valid full userId');
  const g1Number = deriveG1Number(normalizedUserId);
  const params = [
    `u=${encodeURIComponent(normalizedUserId)}`,
    `g=${encodeURIComponent(g1Number)}`,
  ];
  const profile = cleanProfileName(profileName);
  if (profile) params.push(`n=${encodeURIComponent(profile)}`);
  return `${G1_QR_SCHEME}?${params.join('&')}`;
}

export function parseG1QrPayload(value) {
  if (typeof value !== 'string' || !value.startsWith(`${G1_QR_SCHEME}?`)) {
    throw new Error('This QR code is not a G1 contact payload');
  }
  const params = parseQuery(value.slice(G1_QR_SCHEME.length + 1));
  const userId = normalizeUserId(params.u);
  const g1Number = normalizeG1Number(params.g);
  if (!userId || !g1Number) throw new Error('G1 QR is missing a valid identity');
  if (!g1NumberMatchesUserId(g1Number, userId)) {
    throw new Error('G1 QR number does not match its full identity commitment');
  }
  return {
    version: 1,
    userId,
    g1Number,
    profileName: cleanProfileName(params.n),
    source: G1_CONTACT_SOURCE.QR_FULL_ID,
  };
}

export function createManualContactExpectation(g1Number, localAlias = '') {
  const normalized = normalizeG1Number(g1Number);
  if (!normalized) throw new Error('Invalid G1 Number');
  return {
    g1Number: normalized,
    userId: null,
    profileName: '',
    localAlias: typeof localAlias === 'string' ? localAlias.trim().slice(0, 80) : '',
    source: G1_CONTACT_SOURCE.MANUAL_NUMBER,
  };
}

export function createQrContactExpectation(qrPayload, localAlias = '') {
  const parsed = typeof qrPayload === 'string' ? parseG1QrPayload(qrPayload) : qrPayload;
  const userId = normalizeUserId(parsed?.userId);
  const g1Number = normalizeG1Number(parsed?.g1Number);
  if (!userId || !g1Number || !g1NumberMatchesUserId(g1Number, userId)) {
    throw new Error('Invalid G1 QR contact expectation');
  }
  return {
    g1Number,
    userId,
    profileName: cleanProfileName(parsed.profileName),
    localAlias: typeof localAlias === 'string' ? localAlias.trim().slice(0, 80) : '',
    source: G1_CONTACT_SOURCE.QR_FULL_ID,
  };
}

/**
 * Contact data expresses expectation, never current-session proof.
 * A number-only contact matches any full userId whose derived public handle is
 * the same. A QR contact additionally pins the full 256-bit identity commitment.
 */
export function evaluateProvenUserId(contact, provenUserId) {
  const normalizedProof = normalizeUserId(provenUserId);
  const expectedNumber = normalizeG1Number(contact?.g1Number);
  const expectedFull = normalizeUserId(contact?.userId);
  if (!normalizedProof || !expectedNumber) {
    return { matched: false, reason: 'INVALID_IDENTITY_INPUT' };
  }
  if (!g1NumberMatchesUserId(expectedNumber, normalizedProof)) {
    return { matched: false, reason: 'G1_NUMBER_MISMATCH' };
  }
  if (expectedFull && expectedFull !== normalizedProof) {
    return { matched: false, reason: 'FULL_USER_ID_MISMATCH' };
  }
  return {
    matched: true,
    reason: expectedFull ? 'FULL_USER_ID_MATCH' : 'NUMBER_PREFIX_MATCH',
  };
}
