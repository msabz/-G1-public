import {
  deriveG1Number,
  g1NumberMatchesUserId,
  normalizeG1Number,
} from '../src/identity/G1Number';
import {
  G1_CONTACT_SOURCE,
  createManualContactExpectation,
  createQrContactExpectation,
  encodeG1QrPayload,
  evaluateProvenUserId,
  parseG1QrPayload,
} from '../src/identity/G1SharePayload';

describe('G1 Number and QR identity sharing', () => {
  const userId = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  const otherUserId = '100102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  const number = 'G1-000G-40R4-0M30-E209-185G-8VY';

  test('derives stable 100-bit handles plus checksum from the full 256-bit user identity', () => {
    expect(deriveG1Number('0'.repeat(64))).toBe('G1-0000-0000-0000-0000-0000-WBT');
    expect(deriveG1Number('f'.repeat(64))).toBe('G1-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-CZE');
    expect(deriveG1Number(userId)).toBe(number);
  });

  test('normalizes human input while rejecting checksum errors', () => {
    expect(normalizeG1Number('g1 000g 40r4 0m30 e209 185g 8vy')).toBe(number);
    expect(normalizeG1Number('G1-OOOG-4OR4-OM3O-E2O9-185G-8VY')).toBe(number);
    expect(normalizeG1Number(number.replace(/8VY$/, '8VZ'))).toBeNull();
  });

  test('QR carries the full identity and rejects an inconsistent visible number', () => {
    const payload = encodeG1QrPayload({ userId, profileName: 'Musab' });
    expect(parseG1QrPayload(payload)).toEqual(expect.objectContaining({
      version: 1,
      userId,
      g1Number: number,
      profileName: 'Musab',
      source: G1_CONTACT_SOURCE.QR_FULL_ID,
    }));

    const tampered = payload.replace(encodeURIComponent(number), encodeURIComponent(deriveG1Number(otherUserId)));
    expect(() => parseG1QrPayload(tampered)).toThrow(/does not match/i);
  });

  test('manual number is an expectation only while QR pins the full user identity', () => {
    const manual = createManualContactExpectation(number, 'صديقي');
    expect(manual).toEqual(expect.objectContaining({
      g1Number: number,
      userId: null,
      localAlias: 'صديقي',
      source: G1_CONTACT_SOURCE.MANUAL_NUMBER,
    }));

    const qr = createQrContactExpectation(encodeG1QrPayload({ userId, profileName: 'Musab' }), 'العمل');
    expect(qr).toEqual(expect.objectContaining({
      g1Number: number,
      userId,
      profileName: 'Musab',
      localAlias: 'العمل',
      source: G1_CONTACT_SOURCE.QR_FULL_ID,
    }));
  });

  test('proven identity must match the number and, when available, the QR-pinned full userId', () => {
    const manual = createManualContactExpectation(number);
    expect(evaluateProvenUserId(manual, userId)).toEqual({
      matched: true,
      reason: 'NUMBER_PREFIX_MATCH',
    });

    const qr = createQrContactExpectation(encodeG1QrPayload({ userId }));
    expect(evaluateProvenUserId(qr, userId)).toEqual({
      matched: true,
      reason: 'FULL_USER_ID_MATCH',
    });
    expect(evaluateProvenUserId(qr, otherUserId).matched).toBe(false);
    expect(g1NumberMatchesUserId(number, userId)).toBe(true);
  });
});
