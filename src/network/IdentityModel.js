export const IDENTITY_TRUST = {
  UNVERIFIED: 'UNVERIFIED',
  DISCOVERY_ASSERTED: 'DISCOVERY_ASSERTED',
  SESSION_PROVEN: 'SESSION_PROVEN',
  PINNED: 'PINNED',
};

export const IDENTITY_SOURCE = {
  PERSISTED: 'PERSISTED',
  DNS_SD_TXT: 'DNS_SD_TXT',
  SESSION_PROOF: 'SESSION_PROOF',
};

export function normalizeIdentityValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeRouteValue(value) {
  return normalizeIdentityValue(value).toLowerCase();
}

export function looksLikeWifiMac(value) {
  const normalized = normalizeRouteValue(value);
  return /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalized);
}

export function looksLikeIpv4(value) {
  const text = normalizeIdentityValue(value);
  const parts = text.split('.');
  if (parts.length !== 4) return false;
  return parts.every(part => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

export function isRouteDerivedIdentity(value, routeValues = []) {
  const candidate = normalizeRouteValue(value);
  if (!candidate) return false;
  if (looksLikeWifiMac(candidate) || looksLikeIpv4(candidate)) return true;
  return routeValues
    .map(normalizeRouteValue)
    .filter(Boolean)
    .includes(candidate);
}

/**
 * Stable logical IDs are application identity, never transport addresses.
 *
 * The current product uses UUID-like IDs, but this validator intentionally
 * does not hard-code UUID syntax because the future user identity may be a
 * key-derived identifier. The hard rule is provenance/separation from known
 * route values, not one textual ID format.
 */
export function isStableIdentityValue(value, routeValues = []) {
  const candidate = normalizeIdentityValue(value);
  if (!candidate) return false;
  return !isRouteDerivedIdentity(candidate, routeValues);
}

export function buildAdditivePeerIdentity({
  deviceId,
  userId = null,
  g1Number = null,
  displayName = null,
  deviceName = null,
  keyFingerprint = null,
  trust = IDENTITY_TRUST.UNVERIFIED,
  source = null,
} = {}) {
  const stableDeviceId = normalizeIdentityValue(deviceId);
  if (!stableDeviceId) {
    throw new Error('deviceId is required for peer identity');
  }

  return {
    deviceId: stableDeviceId,
    // userId/G1 Number are deliberately additive. Existing conversation and
    // route persistence still key by deviceId until a later explicit schema
    // migration is designed and physically verified.
    userId: normalizeIdentityValue(userId) || null,
    g1Number: normalizeIdentityValue(g1Number) || null,
    displayName:
      normalizeIdentityValue(displayName) ||
      normalizeIdentityValue(deviceName) ||
      'G1 Device',
    keyFingerprint: normalizeIdentityValue(keyFingerprint) || null,
    trust: Object.values(IDENTITY_TRUST).includes(trust)
      ? trust
      : IDENTITY_TRUST.UNVERIFIED,
    source: Object.values(IDENTITY_SOURCE).includes(source) ? source : null,
  };
}

/**
 * Discovery can suggest identity, but it cannot prove it. A DNS-SD TXT ID is
 * therefore only DISCOVERY_ASSERTED until the control-channel proof succeeds.
 */
export function discoveryIdentityFromPeer(peer = {}, routeValues = []) {
  const candidate = normalizeIdentityValue(peer.peerId || peer.deviceId);
  if (!isStableIdentityValue(candidate, routeValues)) return null;

  const explicitlyFromTxt = peer.identitySource === IDENTITY_SOURCE.DNS_SD_TXT;
  const legacyConfirmedDnsSd = peer.isMusab === true && !peer.identitySource;
  if (!explicitlyFromTxt && !legacyConfirmedDnsSd) return null;

  return buildAdditivePeerIdentity({
    deviceId: candidate,
    userId: peer.userId,
    g1Number: peer.g1Number,
    displayName: peer.displayName || peer.label || peer.name || peer.deviceName,
    deviceName: peer.deviceName,
    keyFingerprint: peer.keyFingerprint || peer.identityKeyFingerprint,
    trust: IDENTITY_TRUST.DISCOVERY_ASSERTED,
    source: IDENTITY_SOURCE.DNS_SD_TXT,
  });
}
