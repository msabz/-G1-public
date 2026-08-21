export const PEER_STATUS = {
  ONLINE: 'ONLINE',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  OFFLINE: 'OFFLINE',
};

export const TRANSPORTS = {
  LAN: 'LAN',
  P2P: 'P2P',
  BLUETOOTH: 'BLUETOOTH',
};

const IDENTITY_TRUST_RANK = {
  UNVERIFIED: 0,
  DISCOVERY_ASSERTED: 1,
  SESSION_PROVEN: 2,
  PINNED: 3,
};

function now() {
  return Date.now();
}

function identityTrustRank(value) {
  return IDENTITY_TRUST_RANK[value] ?? 0;
}

export class PeerRegistry {
  constructor(options = {}) {
    this.myDeviceId = options.myDeviceId || '';
    this.peers = new Map(); // deviceId -> Peer Object
    this.listeners = new Set();
    this.transportGenerations = {
      [TRANSPORTS.LAN]: 0,
      [TRANSPORTS.P2P]: 0,
      [TRANSPORTS.BLUETOOTH]: 0,
    };
  }

  setMyDeviceId(deviceId) {
    this.myDeviceId = deviceId;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _notify() {
    const list = this.getAllPeers();
    for (const listener of this.listeners) {
      try {
        listener(list);
      } catch (e) {
        console.warn('PeerRegistry listener error:', e);
      }
    }
  }

  _basePeer(deviceId, deviceName, attributes = {}) {
    return {
      deviceId,
      deviceName: deviceName || 'G1 Device',
      avatar: attributes.avatar || null,
      avatarHash: attributes.avatarHash || null,
      isTrusted: false,
      status: PEER_STATUS.ONLINE,
      transports: {},
      lastSeen: now(),
      connectedTransport: null,
      userId: null,
      g1Number: null,
      keyFingerprint: null,
      identityTrust: 'UNVERIFIED',
      identitySource: null,
      identityDisplayName: null,
    };
  }

  _refreshPeerStatus(peer) {
    if (peer.status === PEER_STATUS.CONNECTED || peer.status === PEER_STATUS.CONNECTING) return;
    const hasReachable = Object.values(peer.transports).some(t => t && t.isReachable === true);
    peer.status = hasReachable ? PEER_STATUS.ONLINE : PEER_STATUS.OFFLINE;
  }

  getTransportGeneration(transport) {
    return this.transportGenerations[transport] || 0;
  }

  /**
   * Invalidates only one transport family without touching peer identity or
   * other transports. A P2P group teardown must never make LAN/Bluetooth stale,
   * and a Wi-Fi network transition must never erase P2P/Bluetooth identity.
   */
  invalidateTransport(transport, reason = 'network-transition') {
    if (!Object.prototype.hasOwnProperty.call(this.transportGenerations, transport)) return 0;
    const generation = (this.transportGenerations[transport] || 0) + 1;
    this.transportGenerations[transport] = generation;
    const invalidatedAt = now();

    for (const peer of this.peers.values()) {
      const endpoint = peer.transports?.[transport];
      if (!endpoint) continue;
      endpoint.isReachable = false;
      endpoint.stale = true;
      endpoint.invalidatedAt = invalidatedAt;
      endpoint.invalidatedReason = reason;
      if (peer.connectedTransport === transport) {
        peer.connectedTransport = null;
      }
      this._refreshPeerStatus(peer);
    }

    this._notify();
    return generation;
  }

  isTransportEndpointCurrent(endpoint, transport) {
    if (!endpoint || endpoint.isReachable === false || endpoint.stale === true) return false;
    return endpoint.generation === this.getTransportGeneration(transport);
  }

  upsertLanPeer({
    deviceId,
    deviceName,
    host,
    port,
    interfaceName = null,
    networkId = null,
    attributes = {},
    isOnline = true,
  }) {
    if (!deviceId || (this.myDeviceId && deviceId === this.myDeviceId)) return null;

    const existing = this.peers.get(deviceId) || this._basePeer(deviceId, deviceName, attributes);
    const seenAt = now();

    existing.deviceName = deviceName || existing.deviceName || 'G1 Device';
    if (attributes.avatar) existing.avatar = attributes.avatar;
    if (attributes.avatarHash) existing.avatarHash = attributes.avatarHash;

    existing.transports.LAN = {
      host,
      port: port || 8089,
      interfaceName,
      networkId,
      generation: this.getTransportGeneration(TRANSPORTS.LAN),
      discoveredAt: seenAt,
      lastSeen: seenAt,
      isReachable: isOnline,
      stale: false,
    };

    existing.lastSeen = seenAt;
    if (isOnline && existing.status !== PEER_STATUS.CONNECTED) {
      existing.status = PEER_STATUS.ONLINE;
    } else if (!isOnline && existing.status !== PEER_STATUS.CONNECTED) {
      this._refreshPeerStatus(existing);
    }

    this.peers.set(deviceId, existing);
    this._notify();
    return existing;
  }

  upsertP2pPeer({
    deviceId,
    deviceName,
    deviceAddress,
    isGroupOwner,
    groupOwnerAddress = null,
    interfaceName = null,
    connectionEpoch = null,
    isOnline = true,
  }) {
    if (!deviceId || (this.myDeviceId && deviceId === this.myDeviceId)) return null;

    const existing = this.peers.get(deviceId) || this._basePeer(deviceId, deviceName);
    const seenAt = now();

    existing.deviceName = deviceName || existing.deviceName || 'G1 Device';
    existing.transports.P2P = {
      deviceAddress,
      isGroupOwner,
      groupOwnerAddress,
      interfaceName,
      connectionEpoch,
      generation: this.getTransportGeneration(TRANSPORTS.P2P),
      discoveredAt: seenAt,
      lastSeen: seenAt,
      isReachable: isOnline,
      stale: false,
    };

    existing.lastSeen = seenAt;
    if (isOnline && existing.status !== PEER_STATUS.CONNECTED) {
      existing.status = PEER_STATUS.ONLINE;
    } else if (!isOnline && existing.status !== PEER_STATUS.CONNECTED) {
      this._refreshPeerStatus(existing);
    }

    this.peers.set(deviceId, existing);
    this._notify();
    return existing;
  }

  upsertBluetoothPeer({ deviceId, deviceName, address, connectionEpoch = null, isOnline = true }) {
    if (!deviceId || (this.myDeviceId && deviceId === this.myDeviceId)) return null;

    const existing = this.peers.get(deviceId) || this._basePeer(deviceId, deviceName);
    const seenAt = now();

    existing.deviceName = deviceName || existing.deviceName || 'G1 Device';
    existing.transports.BLUETOOTH = {
      address,
      connectionEpoch,
      generation: this.getTransportGeneration(TRANSPORTS.BLUETOOTH),
      discoveredAt: seenAt,
      lastSeen: seenAt,
      isReachable: isOnline,
      stale: false,
    };

    existing.lastSeen = seenAt;
    if (isOnline && existing.status !== PEER_STATUS.CONNECTED) {
      existing.status = PEER_STATUS.ONLINE;
    } else if (!isOnline && existing.status !== PEER_STATUS.CONNECTED) {
      this._refreshPeerStatus(existing);
    }

    this.peers.set(deviceId, existing);
    this._notify();
    return existing;
  }

  /**
   * Adds cryptographic identity evidence without changing any route. Trust is
   * monotonic in-memory: a DNS-SD/persisted claim can never overwrite a
   * SESSION_PROVEN or PINNED identity for the same logical device.
   */
  upsertPeerIdentity(identity = {}) {
    const deviceId = typeof identity.deviceId === 'string' ? identity.deviceId.trim() : '';
    if (!deviceId || (this.myDeviceId && deviceId === this.myDeviceId)) return null;

    const existing = this.peers.get(deviceId) || this._basePeer(
      deviceId,
      identity.displayName || identity.deviceName || 'G1 Device'
    );
    const currentRank = identityTrustRank(existing.identityTrust);
    const incomingRank = identityTrustRank(identity.trust);
    const incomingUserId = typeof identity.userId === 'string' && identity.userId.trim()
      ? identity.userId.trim()
      : null;

    if (
      existing.userId &&
      incomingUserId &&
      existing.userId !== incomingUserId &&
      currentRank >= IDENTITY_TRUST_RANK.SESSION_PROVEN &&
      incomingRank >= IDENTITY_TRUST_RANK.SESSION_PROVEN
    ) {
      throw new Error('Conflicting cryptographically proven G1 user identity for peer');
    }

    if (incomingRank < currentRank) {
      this.peers.set(deviceId, existing);
      return existing;
    }

    if (incomingUserId) existing.userId = incomingUserId;
    if (typeof identity.g1Number === 'string' && identity.g1Number.trim()) {
      existing.g1Number = identity.g1Number.trim();
    }
    if (typeof identity.keyFingerprint === 'string' && identity.keyFingerprint.trim()) {
      existing.keyFingerprint = identity.keyFingerprint.trim();
    }
    if (typeof identity.displayName === 'string' && identity.displayName.trim()) {
      existing.identityDisplayName = identity.displayName.trim();
    }
    existing.identityTrust = Object.prototype.hasOwnProperty.call(IDENTITY_TRUST_RANK, identity.trust)
      ? identity.trust
      : existing.identityTrust;
    if (identity.source) existing.identitySource = identity.source;
    existing.lastSeen = now();

    this.peers.set(deviceId, existing);
    this._notify();
    return existing;
  }

  setPeerConnected(deviceId, transport) {
    const peer = this.peers.get(deviceId);
    if (!peer) return;
    peer.status = PEER_STATUS.CONNECTED;
    peer.connectedTransport = transport;
    peer.lastSeen = now();
    this._notify();
  }

  setPeerConnecting(deviceId) {
    const peer = this.peers.get(deviceId);
    if (!peer) return;
    peer.status = PEER_STATUS.CONNECTING;
    this._notify();
  }

  setPeerDisconnected(deviceId) {
    const peer = this.peers.get(deviceId);
    if (!peer) return;
    peer.connectedTransport = null;
    this._refreshPeerStatus(peer);
    this._notify();
  }

  setPeerTrusted(deviceId, isTrusted = true) {
    const peer = this.peers.get(deviceId);
    if (!peer) return;
    peer.isTrusted = isTrusted;
    this._notify();
  }

  getPeer(deviceId) {
    return this.peers.get(deviceId) || null;
  }

  getAllPeers() {
    const list = Array.from(this.peers.values());
    // Sorting:
    // 1. active connected peer
    // 2. connecting peer
    // 3. trusted online peers
    // 4. new online peers
    // 5. offline known peers
    return list.sort((a, b) => {
      const getPriority = p => {
        if (p.status === PEER_STATUS.CONNECTED) return 0;
        if (p.status === PEER_STATUS.CONNECTING) return 1;
        if (p.status === PEER_STATUS.ONLINE && p.isTrusted) return 2;
        if (p.status === PEER_STATUS.ONLINE) return 3;
        if (p.isTrusted) return 4;
        return 5;
      };
      const prioA = getPriority(a);
      const prioB = getPriority(b);
      if (prioA !== prioB) return prioA - prioB;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
  }

  clear() {
    this.peers.clear();
    this.transportGenerations = {
      [TRANSPORTS.LAN]: 0,
      [TRANSPORTS.P2P]: 0,
      [TRANSPORTS.BLUETOOTH]: 0,
    };
    this._notify();
  }
}

export const peerRegistry = new PeerRegistry();
export default peerRegistry;
