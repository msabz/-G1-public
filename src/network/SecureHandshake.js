export const PROTOCOL_VERSION = 1;
export const APP_IDENTIFIER = 'G1';
export const HANDSHAKE_TIMEOUT_MS = 4000;
export const MAX_CLOCK_DRIFT_MS = 60000; // 1 minute max clock skew

export class SecureHandshakeManager {
  constructor(options = {}) {
    this.myDeviceId = options.myDeviceId || '';
    this.myDeviceName = options.myDeviceName || 'G1 Device';
    this.avatarHash = options.avatarHash || null;
  }

  setIdentity({ deviceId, deviceName, avatarHash }) {
    if (deviceId) this.myDeviceId = deviceId;
    if (deviceName) this.myDeviceName = deviceName;
    if (avatarHash !== undefined) this.avatarHash = avatarHash;
  }

  createHelloPayload() {
    return {
      type: 'handshake-hello',
      protoVer: PROTOCOL_VERSION,
      app: APP_IDENTIFIER,
      deviceId: this.myDeviceId,
      deviceName: this.myDeviceName,
      avatarHash: this.avatarHash,
      timestamp: Date.now(),
    };
  }

  createWelcomePayload() {
    return {
      type: 'handshake-welcome',
      protoVer: PROTOCOL_VERSION,
      app: APP_IDENTIFIER,
      deviceId: this.myDeviceId,
      deviceName: this.myDeviceName,
      avatarHash: this.avatarHash,
      accepted: true,
      timestamp: Date.now(),
    };
  }

  validateHello(msg) {
    if (!msg || typeof msg !== 'object') {
      return { valid: false, reason: 'Invalid payload structure' };
    }
    if (msg.type !== 'handshake-hello') {
      return { valid: false, reason: 'Expected handshake-hello message' };
    }
    if (msg.app !== APP_IDENTIFIER) {
      return { valid: false, reason: `Incompatible app: ${msg.app}` };
    }
    if (Number(msg.protoVer) !== PROTOCOL_VERSION) {
      return { valid: false, reason: `Incompatible protocol version: ${msg.protoVer}` };
    }
    if (!msg.deviceId || typeof msg.deviceId !== 'string') {
      return { valid: false, reason: 'Missing or invalid deviceId' };
    }
    if (this.myDeviceId && msg.deviceId === this.myDeviceId) {
      return { valid: false, reason: 'Self connection rejected' };
    }
    if (msg.timestamp && Math.abs(Date.now() - msg.timestamp) > MAX_CLOCK_DRIFT_MS) {
      return { valid: false, reason: 'Timestamp drift too large / possible replay' };
    }

    return {
      valid: true,
      peerInfo: {
        deviceId: msg.deviceId,
        deviceName: msg.deviceName || 'G1 Device',
        avatarHash: msg.avatarHash || null,
        protoVer: msg.protoVer,
      },
    };
  }

  validateWelcome(msg) {
    if (!msg || typeof msg !== 'object') {
      return { valid: false, reason: 'Invalid payload structure' };
    }
    if (msg.type !== 'handshake-welcome') {
      return { valid: false, reason: 'Expected handshake-welcome message' };
    }
    if (msg.app !== APP_IDENTIFIER) {
      return { valid: false, reason: `Incompatible app: ${msg.app}` };
    }
    if (!msg.accepted) {
      return { valid: false, reason: 'Connection rejected by remote peer' };
    }
    if (!msg.deviceId || typeof msg.deviceId !== 'string') {
      return { valid: false, reason: 'Missing or invalid deviceId in welcome' };
    }

    return {
      valid: true,
      peerInfo: {
        deviceId: msg.deviceId,
        deviceName: msg.deviceName || 'G1 Device',
        avatarHash: msg.avatarHash || null,
        protoVer: msg.protoVer,
      },
    };
  }
}

export const secureHandshake = new SecureHandshakeManager();
export default secureHandshake;
