import { NativeModules, NativeEventEmitter } from 'react-native';
import { peerRegistry, TRANSPORTS } from './PeerRegistry';

export const WIFI_DIRECT_ADAPTER_STATE = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  READY: 'READY',
  DISCONNECTING: 'DISCONNECTING',
  ERROR: 'ERROR',
};

export const WIFI_P2P_AVAILABLE_STATUS = 3;

const defaultDelay = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeAddress(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function createDefaultEmitter(nativeModule) {
  if (!nativeModule) return null;
  try {
    return new NativeEventEmitter(nativeModule);
  } catch (e) {
    return null;
  }
}

/**
 * Android Wi-Fi Direct transport adapter.
 *
 * Ownership boundary:
 * - owns P2P discovery observations, group negotiation, process bind/unbind and
 *   group cleanup;
 * - never owns G1 peer identity semantics, signaling messages, heartbeat,
 *   signaling recovery, chat/call state or UI state;
 * - returns a prepared route to ConnectionCoordinator, which then asks the
 *   signaling owner to establish the control session over that route.
 */
export class WifiDirectTransportAdapter {
  constructor(options = {}) {
    this.nativeModule = options.nativeModule || NativeModules?.DirectConnectionModule || null;
    this.registry = options.registry || peerRegistry;
    this.emitter = options.emitter || createDefaultEmitter(this.nativeModule);
    this.delay = options.delay || defaultDelay;
    this.defaultConnectTimeoutMs = options.connectTimeoutMs || 30000;
    this.defaultCleanupTimeoutMs = options.cleanupTimeoutMs || 10000;

    this.state = WIFI_DIRECT_ADAPTER_STATE.IDLE;
    this.identity = null;
    this.activePeer = null;
    this.activeRoute = null;
    this.pendingConnect = null;
    this.cleanupPromise = null;
    this.subscriptions = [];
    this.observing = false;
    this.knownIdentityByAddress = new Map();
  }

  setIdentity(identity) {
    this.identity = identity?.deviceId
      ? {
          deviceId: identity.deviceId,
          deviceName: identity.deviceName || 'G1 Device',
        }
      : null;
  }

  isSupported() {
    return !!(
      this.nativeModule &&
      typeof this.nativeModule.connectToPeer === 'function' &&
      typeof this.nativeModule.getConnectionInfo === 'function'
    );
  }

  getStatus() {
    return {
      state: this.state,
      observing: this.observing,
      activePeerId: this.activePeer?.deviceId || null,
      activeRoute: this.activeRoute ? { ...this.activeRoute } : null,
      pendingPeerId: this.pendingConnect?.peer?.deviceId || null,
    };
  }

  startObserving() {
    if (this.observing || !this.emitter?.addListener) return false;
    this.observing = true;
    this.subscriptions = [
      this.emitter.addListener('MUSAB_PEER_FOUND', event => this._onMusabPeerFound(event)),
      this.emitter.addListener('PEERS_UPDATED', event => this._onPeersUpdated(event)),
      this.emitter.addListener('PEER_CONNECTED', event => this._onPeerConnected(event)),
      this.emitter.addListener('PEER_DISCONNECTED', event => this._onPeerDisconnected(event)),
      this.emitter.addListener('PEER_ADDRESS_RESOLVED', event => this._onPeerAddressResolved(event)),
    ];
    return true;
  }

  stopObserving() {
    this.subscriptions.forEach(subscription => {
      try { subscription?.remove?.(); } catch (e) {}
    });
    this.subscriptions = [];
    this.observing = false;
  }

  _rememberStablePeer({ deviceAddress, deviceId, deviceName, status }) {
    const address = normalizeAddress(deviceAddress);
    if (!address || !deviceId) return null;
    const record = {
      deviceId,
      deviceName: deviceName || 'G1 Device',
      deviceAddress,
      status: Number(status),
    };
    this.knownIdentityByAddress.set(address, record);
    return record;
  }

  _upsertKnownP2pPeer(record, overrides = {}) {
    if (!record?.deviceId || !record?.deviceAddress) return null;
    const status = Number(overrides.status ?? record.status);
    const isOnline = overrides.isOnline ?? (Number.isFinite(status)
      ? status === WIFI_P2P_AVAILABLE_STATUS
      : true);
    return this.registry.upsertP2pPeer({
      deviceId: record.deviceId,
      deviceName: overrides.deviceName || record.deviceName,
      deviceAddress: overrides.deviceAddress || record.deviceAddress,
      isGroupOwner: overrides.isGroupOwner ?? null,
      groupOwnerAddress: overrides.groupOwnerAddress ?? null,
      interfaceName: overrides.interfaceName ?? null,
      connectionEpoch: overrides.connectionEpoch ?? null,
      isOnline,
    });
  }

  _onMusabPeerFound(event = {}) {
    const record = this._rememberStablePeer({
      deviceAddress: event.deviceAddress,
      deviceId: event.peerId || event.deviceId,
      deviceName: event.label || event.deviceName,
      status: event.status,
    });
    if (record) this._upsertKnownP2pPeer(record);
  }

  _onPeersUpdated(event = {}) {
    const peers = Array.isArray(event.peers) ? event.peers : [];
    for (const peer of peers) {
      const address = normalizeAddress(peer.deviceAddress);
      if (!address) continue;
      const record = this.knownIdentityByAddress.get(address);
      // Raw Wi-Fi Direct discovery is a route observation, not stable G1
      // identity. Only merge into PeerRegistry once DNS-SD supplied deviceId.
      if (!record?.deviceId) continue;
      this._upsertKnownP2pPeer(record, {
        deviceAddress: peer.deviceAddress,
        deviceName: peer.deviceName || record.deviceName,
        status: peer.status,
      });
    }
  }

  _ownsPendingActivation(pending) {
    return !!pending && this.pendingConnect === pending && !pending.settled;
  }

  async _resolveConnectedRoute(
    initialInfo = {},
    expectedConnectionEpoch = null,
    expectedPending = null
  ) {
    let info = initialInfo || {};
    const initialConnectionEpoch = initialInfo?.connectionEpoch == null
      ? Number.NaN
      : Number(initialInfo.connectionEpoch);
    const pendingConnectionEpoch = expectedConnectionEpoch == null
      ? Number.NaN
      : Number(expectedConnectionEpoch);
    const preservedConnectionEpoch = Number.isFinite(pendingConnectionEpoch)
      ? pendingConnectionEpoch
      : Number.isFinite(initialConnectionEpoch)
        ? initialConnectionEpoch
        : null;
    for (
      let retry = 0;
      !info.isGroupOwner && !info.groupOwnerAddress && retry < 6;
      retry += 1
    ) {
      await this.delay(500);
      if (!this._ownsPendingActivation(expectedPending)) {
        throw new Error('Wi-Fi Direct route activation was superseded');
      }
      info = await this.nativeModule.getConnectionInfo();
      if (!this._ownsPendingActivation(expectedPending)) {
        throw new Error('Wi-Fi Direct route activation was superseded');
      }
    }

    const isGroupOwner = !!info.isGroupOwner;
    const groupOwnerAddress = info.groupOwnerAddress || null;
    if (!isGroupOwner && !groupOwnerAddress) {
      throw new Error('Wi-Fi Direct group formed without a group-owner address');
    }

    let bound = true;
    if (typeof this.nativeModule.bindToWifiDirectNetwork === 'function') {
      if (!this._ownsPendingActivation(expectedPending)) {
        throw new Error('Wi-Fi Direct route activation was superseded');
      }
      let bindAttempted = false;
      try {
        bindAttempted = true;
        bound = (await this.nativeModule.bindToWifiDirectNetwork()) !== false;
      } catch (e) {
        bound = false;
      }
      if (!this._ownsPendingActivation(expectedPending)) {
        // A native bind may complete after cancel/timeout cleanup. Undo that
        // late process-wide side effect instead of resurrecting a stale route.
        if (bindAttempted && typeof this.nativeModule.unbindNetwork === 'function') {
          try { await this.nativeModule.unbindNetwork(); } catch (e) {}
        }
        throw new Error('Wi-Fi Direct route activation was superseded');
      }
    }

    const refreshedConnectionEpoch = info.connectionEpoch == null
      ? Number.NaN
      : Number(info.connectionEpoch);
    return {
      transport: TRANSPORTS.P2P,
      isGroupOwner,
      groupOwnerAddress,
      // getConnectionInfo() does not expose our native attempt generation.
      // Preserve the epoch already validated from PEER_CONNECTED/pending so
      // activeRoute can still reject a delayed disconnect from an old group.
      connectionEpoch: Number.isFinite(refreshedConnectionEpoch)
        ? refreshedConnectionEpoch
        : preservedConnectionEpoch,
      interfaceName: info.interfaceName || null,
      bound,
    };
  }

  _settlePending(expectedPending, error, route = null) {
    const pending = expectedPending;
    if (!pending || this.pendingConnect !== pending || pending.settled) return false;
    pending.settled = true;
    this.pendingConnect = null;
    if (pending.timer) clearTimeout(pending.timer);

    if (error) {
      this.state = WIFI_DIRECT_ADAPTER_STATE.ERROR;
      pending.reject(error);
      return true;
    }

    this.state = WIFI_DIRECT_ADAPTER_STATE.READY;
    this.activePeer = pending.peer;
    this.activeRoute = route;
    pending.resolve(route);
    return true;
  }

  _onPeerConnected(info = {}) {
    if (!info?.groupFormed) return;

    const pending = this.pendingConnect;
    if (!pending) return;

    // Native returns the epoch allocated by connectToPeer(). A PEER_CONNECTED
    // callback already queued on the RN bridge can outlive cleanup and arrive
    // during the next JS attempt, so phase alone is not sufficient isolation.
    if (pending.phase === 'PREPARING') return;
    const eventEpoch = Number(info.connectionEpoch);
    if (!Number.isFinite(pending.connectionEpoch)) {
      if (pending.phase === 'NATIVE_CONNECTING' && Number.isFinite(eventEpoch)) {
        pending.earlyConnectedInfo = info;
      }
      return;
    }
    if (!Number.isFinite(eventEpoch) || eventEpoch !== pending.connectionEpoch) return;

    // A disconnect after this point belongs to the observed group. Earlier
    // disconnect broadcasts can still belong to the cleanup preceding this
    // attempt, especially on Samsung devices.
    pending.phase = 'ACTIVATING';

    this._resolveConnectedRoute(info, pending.connectionEpoch, pending)
      .then(route => {
        if (this.pendingConnect !== pending || pending.settled) return;
        if (
          Number.isFinite(route.connectionEpoch) &&
          route.connectionEpoch !== pending.connectionEpoch
        ) {
          this._settlePending(
            pending,
            new Error('Wi-Fi Direct route belongs to an obsolete connection attempt')
          );
          return;
        }
        const p2p = pending.peer?.transports?.[TRANSPORTS.P2P] || pending.peer || {};
        const record = {
          deviceId: pending.peer.deviceId,
          deviceName: pending.peer.deviceName || pending.peer.name || 'G1 Device',
          deviceAddress: p2p.deviceAddress || pending.peer.deviceAddress,
          status: WIFI_P2P_AVAILABLE_STATUS,
        };
        this._rememberStablePeer(record);
        this._upsertKnownP2pPeer(record, {
          isGroupOwner: route.isGroupOwner,
          groupOwnerAddress: route.groupOwnerAddress,
          interfaceName: route.interfaceName,
          connectionEpoch: route.connectionEpoch,
          isOnline: true,
        });
        this._settlePending(pending, null, route);
      })
      .catch(error => this._settlePending(pending, error));
  }

  _onPeerDisconnected(event = {}) {
    const pending = this.pendingConnect;
    const eventEpoch = Number(event.connectionEpoch);
    if (
      pending &&
      Number.isFinite(eventEpoch) &&
      Number.isFinite(pending.connectionEpoch) &&
      eventEpoch !== pending.connectionEpoch
    ) {
      return;
    }
    if (
      !pending &&
      Number.isFinite(eventEpoch) &&
      Number.isFinite(this.activeRoute?.connectionEpoch) &&
      eventEpoch !== this.activeRoute.connectionEpoch
    ) {
      return;
    }
    if (pending && pending.phase !== 'ACTIVATING') {
      // The bounded route timeout/native connect failure remains authoritative
      // until Android has reported a real group for this attempt.
      return;
    }
    const error = new Error('Wi-Fi Direct group disconnected before route activation');
    if (pending) this._settlePending(pending, error);
    this.activePeer = null;
    this.activeRoute = null;
    if (this.state !== WIFI_DIRECT_ADAPTER_STATE.DISCONNECTING) {
      this.state = WIFI_DIRECT_ADAPTER_STATE.IDLE;
    }
    this.registry.invalidateTransport(TRANSPORTS.P2P, 'p2p-group-disconnected');
  }

  _onPeerAddressResolved(event = {}) {
    if (!this.activePeer?.deviceId || !event.peerDeviceAddress) return;
    const current = this.registry.getPeer(this.activePeer.deviceId);
    const endpoint = current?.transports?.[TRANSPORTS.P2P];
    if (!endpoint) return;
    this.registry.upsertP2pPeer({
      deviceId: this.activePeer.deviceId,
      deviceName: this.activePeer.deviceName || current.deviceName,
      deviceAddress: event.peerDeviceAddress,
      isGroupOwner: endpoint.isGroupOwner,
      groupOwnerAddress: endpoint.groupOwnerAddress,
      interfaceName: endpoint.interfaceName,
      connectionEpoch: event.connectionEpoch ?? endpoint.connectionEpoch,
      isOnline: true,
    });
  }

  async connectPeer(peer, options = {}) {
    if (!this.isSupported()) {
      throw new Error('Wi-Fi Direct transport is unavailable');
    }
    if (!peer?.deviceId) {
      throw new Error('Stable peer deviceId is required for Wi-Fi Direct');
    }

    const p2p = peer.transports?.[TRANSPORTS.P2P] || peer;
    const deviceAddress = p2p.deviceAddress || peer.deviceAddress;
    if (!deviceAddress) {
      throw new Error('Wi-Fi Direct deviceAddress is missing for peer');
    }

    // Timeout cancellation is intentionally fire-and-forget at coordinator
    // level. Serialize a following attempt behind native cleanup so an old
    // removeGroup()/cancelConnect() cannot tear down the new negotiation.
    if (this.cleanupPromise) {
      const cleanup = await this.cleanupPromise;
      if (cleanup?.clean === false) {
        throw new Error(cleanup.error || 'Previous Wi-Fi Direct cleanup did not complete');
      }
    }
    if (this.pendingConnect) {
      throw new Error('Another Wi-Fi Direct connection attempt is already active');
    }

    this.startObserving();
    this.state = WIFI_DIRECT_ADAPTER_STATE.CONNECTING;
    this.activePeer = null;
    this.activeRoute = null;

    const timeoutMs = options.timeoutMs || this.defaultConnectTimeoutMs;
    const incoming = options.incoming === true;

    let pending = null;
    const routePromise = new Promise((resolve, reject) => {
      pending = {
        peer,
        incoming,
        phase: 'PREPARING',
        resolve,
        reject,
        settled: false,
        timer: null,
        connectionEpoch: null,
        earlyConnectedInfo: null,
      };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          const timedOut = this._settlePending(
            pending,
            new Error(`Wi-Fi Direct group negotiation timed out after ${timeoutMs}ms`)
          );
          if (timedOut) this._cleanupNativeRoute().catch(() => {});
        }, timeoutMs);
      }
      this.pendingConnect = pending;
    });
    routePromise.catch(() => {});

    // Android may lose the WifiP2pManager channel without ever invoking an
    // outstanding ActionListener. Run those native calls as an operation that
    // feeds routePromise instead of awaiting them in front of routePromise, so
    // the bounded JS deadline always remains authoritative.
    (async () => {
      if (typeof this.nativeModule.stopServiceDiscovery === 'function') {
        await this.nativeModule.stopServiceDiscovery().catch(() => false);
      }
      if (this.pendingConnect !== pending || pending.settled) {
        return;
      }
      pending.phase = 'NATIVE_CONNECTING';
      const nativeAttempt = await this.nativeModule.connectToPeer(deviceAddress);
      if (this.pendingConnect !== pending || pending.settled) return;
      if (nativeAttempt?.started !== true) {
        throw new Error('Android invalidated the Wi-Fi Direct connection attempt before it started');
      }
      const connectionEpoch = Number(nativeAttempt?.connectionEpoch);
      if (!Number.isFinite(connectionEpoch)) {
        throw new Error('Android did not identify the Wi-Fi Direct connection attempt');
      }
      pending.connectionEpoch = connectionEpoch;
      pending.phase = 'AWAITING_GROUP';
      const earlyConnectedInfo = pending.earlyConnectedInfo;
      pending.earlyConnectedInfo = null;
      if (earlyConnectedInfo) this._onPeerConnected(earlyConnectedInfo);
    })().catch(error => this._settlePending(pending, error));

    return await routePromise;
  }

  _cleanupNativeRoute(timeoutMs = this.defaultCleanupTimeoutMs) {
    if (this.cleanupPromise) return this.cleanupPromise;

    this.state = WIFI_DIRECT_ADAPTER_STATE.DISCONNECTING;
    let cleanupTask = null;
    cleanupTask = (async () => {
      let result = null;
      try {
        result = await this.nativeModule?.cleanupConnection?.(timeoutMs);
      } catch (error) {
        result = { clean: false, error: error?.message || String(error) };
      }
      try {
        await this.nativeModule?.unbindNetwork?.();
      } catch (e) {}

      const clean = result?.clean === true || result == null;
      if (clean) {
        if (this.identity?.deviceId && typeof this.nativeModule?.startAdvertising === 'function') {
          try {
            await this.nativeModule.startAdvertising(
              this.identity.deviceName || 'G1 Device',
              this.identity.deviceId
            );
          } catch (e) {}
        }
        try { await this.nativeModule?.startPassiveListening?.(); } catch (e) {}
      }

      // connectPeer waits for cleanupTask before it can create a new pending
      // attempt. The identity guard additionally prevents an obsolete tail
      // from overwriting state if this lifecycle changes later.
      if (this.cleanupPromise === cleanupTask) {
        this.activePeer = null;
        this.activeRoute = null;
        this.state = clean ? WIFI_DIRECT_ADAPTER_STATE.IDLE : WIFI_DIRECT_ADAPTER_STATE.ERROR;
      }
      return result || { clean };
    })();

    this.cleanupPromise = cleanupTask;
    cleanupTask.finally(() => {
      if (this.cleanupPromise === cleanupTask) this.cleanupPromise = null;
    }).catch(() => {});
    return cleanupTask;
  }

  async cancelConnect(reason = 'Wi-Fi Direct connection cancelled') {
    const pending = this.pendingConnect;
    if (pending && !pending.settled) {
      this._settlePending(pending, new Error(reason));
    }
    return await this._cleanupNativeRoute();
  }

  async disconnect(options = {}) {
    if (!this.nativeModule) return { clean: true };
    this.state = WIFI_DIRECT_ADAPTER_STATE.DISCONNECTING;

    if (this.pendingConnect && !this.pendingConnect.settled) {
      this._settlePending(
        this.pendingConnect,
        new Error('Wi-Fi Direct disconnected')
      );
    }

    this.registry.invalidateTransport(TRANSPORTS.P2P, 'p2p-group-cleanup');
    return await this._cleanupNativeRoute(
      options.timeoutMs || this.defaultCleanupTimeoutMs
    );
  }
}

export const wifiDirectTransportAdapter = new WifiDirectTransportAdapter();
export default wifiDirectTransportAdapter;
