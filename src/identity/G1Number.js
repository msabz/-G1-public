export const G1_NUMBER_PREFIX = 'G1';
export const G1_NUMBER_PAYLOAD_CHARS = 20; // 100 bits in Crockford Base32
export const G1_NUMBER_CHECK_CHARS = 3; // 15-bit typo checksum
export const G1_NUMBER_COMPACT_CHARS = G1_NUMBER_PAYLOAD_CHARS + G1_NUMBER_CHECK_CHARS;
export const G1_USER_ID_HEX_CHARS = 64; // 256-bit full hidden identity commitment

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_SET = new Set(CROCKFORD_ALPHABET.split(''));

export function normalizeUserId(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function userIdToBytes(userId) {
  const normalized = normalizeUserId(userId);
  if (!normalized) throw new Error('Invalid G1 userId; expected 256-bit lowercase/uppercase hex');
  const bytes = [];
  for (let i = 0; i < normalized.length; i += 2) {
    bytes.push(parseInt(normalized.slice(i, i + 2), 16));
  }
  return bytes;
}

function encodeBits(bytes, bitLength) {
  let result = '';
  const chars = Math.ceil(bitLength / 5);
  for (let i = 0; i < chars; i += 1) {
    let value = 0;
    for (let j = 0; j < 5; j += 1) {
      const bitIndex = i * 5 + j;
      value <<= 1;
      if (bitIndex < bitLength) {
        const byteIndex = Math.floor(bitIndex / 8);
        const shift = 7 - (bitIndex % 8);
        value |= (bytes[byteIndex] >> shift) & 1;
      }
    }
    result += CROCKFORD_ALPHABET[value];
  }
  return result;
}

function crc16CcittAscii(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= (text.charCodeAt(i) & 0xff) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0
        ? ((crc << 1) ^ 0x1021) & 0xffff
        : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function encodeFixedBase32(value, chars) {
  let remaining = value;
  const out = new Array(chars).fill('0');
  for (let i = chars - 1; i >= 0; i -= 1) {
    out[i] = CROCKFORD_ALPHABET[remaining & 31];
    remaining >>>= 5;
  }
  return out.join('');
}

function checksumForPayload(payload) {
  return encodeFixedBase32(crc16CcittAscii(payload) & 0x7fff, G1_NUMBER_CHECK_CHARS);
}

function formatCompact(compact) {
  const payload = compact.slice(0, G1_NUMBER_PAYLOAD_CHARS);
  const check = compact.slice(G1_NUMBER_PAYLOAD_CHARS);
  const groups = [];
  for (let i = 0; i < payload.length; i += 4) groups.push(payload.slice(i, i + 4));
  groups.push(check);
  return `${G1_NUMBER_PREFIX}-${groups.join('-')}`;
}

function normalizeCrockfordInput(text) {
  return text
    .split('')
    .map(char => {
      if (char === 'O') return '0';
      if (char === 'I' || char === 'L') return '1';
      return char;
    })
    .join('');
}

export function deriveG1Number(userId) {
  const bytes = userIdToBytes(userId);
  const payload = encodeBits(bytes, G1_NUMBER_PAYLOAD_CHARS * 5);
  const compact = `${payload}${checksumForPayload(payload)}`;
  return formatCompact(compact);
}

export function normalizeG1Number(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim().toUpperCase();
  text = text.replace(/^G1(?:[\s:_-]+)?/, '');
  text = text.replace(/[\s-]/g, '');
  text = normalizeCrockfordInput(text);
  if (text.length !== G1_NUMBER_COMPACT_CHARS) return null;
  if (![...text].every(char => CROCKFORD_SET.has(char))) return null;

  const payload = text.slice(0, G1_NUMBER_PAYLOAD_CHARS);
  const suppliedCheck = text.slice(G1_NUMBER_PAYLOAD_CHARS);
  if (suppliedCheck !== checksumForPayload(payload)) return null;
  return formatCompact(text);
}

export function isValidG1Number(value) {
  return normalizeG1Number(value) !== null;
}

export function compactG1Number(value) {
  const normalized = normalizeG1Number(value);
  return normalized ? normalized.slice(3).replace(/-/g, '') : null;
}

export function g1NumberMatchesUserId(g1Number, userId) {
  const normalizedNumber = normalizeG1Number(g1Number);
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedNumber || !normalizedUserId) return false;
  return normalizedNumber === deriveG1Number(normalizedUserId);
}

export const __g1NumberInternals = {
  CROCKFORD_ALPHABET,
  crc16CcittAscii,
  checksumForPayload,
  encodeBits,
};
