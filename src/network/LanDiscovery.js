import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import { peerRegistry, TRANSPORTS } from './PeerRegistry';

function getNativeModule() {
  return NativeModules?.LanDiscoveryModule || null;
}

class LanDiscoveryManager {
  constructor() {
    this.isAdvertising = false;
    this.isDiscovering = false;
    this.discoveredPeers = new Map(); // deviceId -> peer info
    this.onPeerFoundCallback = null;
    this.onPeerLostCallback = null;
    this.onStatusCallback = null;
    this.onNetworkRefreshCallback = null;
    this.subscriptions = [];
  }

  isSupported() {
    return Platform.OS === 'android' && !!getNativeModule();
  }

  async startAdvertising({ deviceId, deviceName, port = 8089, attributes = {} }) {
    const nativeMod = getNativeModule();
    if (!this.isSupported() || !nativeMod) return false;
    try {
      await nativeMod.startAdvertising(deviceId, deviceName, port, attributes);
      this.isAdvertising = true;
      return true;
    } catch (e) {
      console.warn('LanDiscovery: startAdvertising error:', e?.message || e);
      this.isAdvertising = false;
      return false;
    }
  }

  async stopAdvertising() {
    const nativeMod = getNativeModule();
    if (!this.isSupported() || !nativeMod) return;
    try {
      await nativeMod.stopAdvertising();
    } catch (e) {
      console.warn('LanDiscovery: stopAdvertising error:', e?.message || e);
    } finally {
      this.isAdvertising = false;
    }
  }

  async startDiscovery({ onPeerFound, onPeerLost, onStatus, onNetworkRefresh } = {}) {
    if (onPeerFound) this.onPeerFoundCallback = onPeerFound;
    if (onPeerLost) this.onPeerLostCallback = onPeerLost;
    if (onStatus) this.onStatusCallback = onStatus;
    if (onNetworkRefresh) this.onNetworkRefreshCallback = onNetworkRefresh;

    const nativeMod = getNativeModule();
    if (!this.isSupported() || !nativeMod) return false;

    this._cleanupSubscriptions();

    try {
      const emitter = new NativeEventEmitter(nativeMod);
      this.subscriptions.push(
        emitter.addListener('LAN_PEER_FOUND', event => this._handlePeerFound(event))
      );
      this.subscriptions.push(
        emitter.addListener('LAN_PEER_LOST', event => this._handlePeerLost(event))
      );
      this.subscriptions.push(
        emitter.addListener('LAN_DISCOVERY_STATUS', event => {
          if (event) {
            if (typeof event.isAdvertising === 'boolean') this.isAdvertising = event.isAdvertising;
            if (typeof event.isDiscovering === 'boolean') this.isDiscovering = event.isDiscovering;
          }
          if (this.onStatusCallback) this.onStatusCallback(event);
        })
      );
      this.subscriptions.push(
        emitter.addListener('LAN_NETWORK_REFRESH', event => this._handleNetworkRefresh(event))
      );
    } catch (e) {
      console.warn('LanDiscovery: event emitter error:', e?.message || e);
    }

    try {
      await nativeMod.startDiscovery();
      this.isDiscovering = true;
      return true;
    } catch (e) {
      console.warn('LanDiscovery: startDiscovery error:', e?.message || e);
      this.isDiscovering = false;
      return false;
    }
  }

  _handlePeerFound(event) {
    if (!event || !event.deviceId) return;
    const peerInfo = {
      deviceId: event.deviceId,
      deviceName: event.deviceName || 'G1 Device',
      host: event.host,
      port: event.port || 8089,
      serviceName: event.serviceName,
      interfaceName: event.interfaceName || null,
      attributes: event.attributes || {},
      transport: 'LAN',
      lastSeen: Date.now(),
      isOnline: true,
    };

    this.discoveredPeers.set(event.deviceId, peerInfo);
    if (this.onPeerFoundCallback) this.onPeerFoundCallback(peerInfo);
  }

  _handlePeerLost(event) {
    if (!event) return;
    const devId = event.deviceId;
    if (devId && this.discoveredPeers.has(devId)) {
      const lostPeer = this.discoveredPeers.get(devId);
      this.discoveredPeers.delete(devId);
      if (this.onPeerLostCallback) {
        this.onPeerLostCallback({ ...lostPeer, isOnline: false });
      }
    }
  }

  _handleNetworkRefresh(event = {}) {
    const reason = event.reason || 'network-transition';
    const stalePeers = Array.from(this.discoveredPeers.values());
    this.discoveredPeers.clear();

    // Invalidate LAN only. Peer identity, P2P and Bluetooth remain untouched.
    const generation = peerRegistry.invalidateTransport(TRANSPORTS.LAN, reason);
    console.log(`[G1/LAN] NETWORK_REFRESH reason=${reason} generation=${generation}`);

    // Keep consumers that maintain their own view in sync immediately instead
    // of waiting for Android NSD to emit individual service-lost callbacks.
    if (this.onPeerLostCallback) {
      for (const peer of stalePeers) {
        this.onPeerLostCallback({ ...peer, isOnline: false, stale: true, invalidatedReason: reason });
      }
    }

    if (this.onNetworkRefreshCallback) {
      this.onNetworkRefreshCallback({ ...event, reason, generation });
    }
  }

  async stopDiscovery() {
    const nativeMod = getNativeModule();
    this._cleanupSubscriptions();
    if (!this.isSupported() || !nativeMod) return;
    try {
      await nativeMod.stopDiscovery();
    } catch (e) {
      console.warn('LanDiscovery: stopDiscovery error:', e?.message || e);
    } finally {
      this.isDiscovering = false;
    }
  }

  async getStatus() {
    const nativeMod = getNativeModule();
    if (!this.isSupported() || !nativeMod?.getStatus) {
      return {
        isAdvertising: this.isAdvertising,
        isDiscovering: this.isDiscovering,
      };
    }
    try {
      const status = await nativeMod.getStatus();
      if (status) {
        if (typeof status.isAdvertising === 'boolean') this.isAdvertising = status.isAdvertising;
        if (typeof status.isDiscovering === 'boolean') this.isDiscovering = status.isDiscovering;
      }
      return status || {
        isAdvertising: this.isAdvertising,
        isDiscovering: this.isDiscovering,
      };
    } catch (e) {
      return {
        isAdvertising: this.isAdvertising,
        isDiscovering: this.isDiscovering,
      };
    }
  }

  _cleanupSubscriptions() {
    for (const sub of this.subscriptions) {
      try { sub.remove(); } catch (e) {}
    }
    this.subscriptions = [];
  }

  getDiscoveredPeers() {
    return Array.from(this.discoveredPeers.values());
  }

  clear() {
    this.discoveredPeers.clear();
  }
}

export const lanDiscovery = new LanDiscoveryManager();
export default lanDiscovery;
