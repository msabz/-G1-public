import { NativeEventEmitter, NativeModules } from 'react-native';
import { peerRegistry, TRANSPORTS } from '../network/PeerRegistry';

export const BLUETOOTH_TRANSPORT_STATE = Object.freeze({
  IDLE: 'IDLE',
  DISCOVERING: 'DISCOVERING',
  LISTENING: 'LISTENING',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  DISCONNECTING: 'DISCONNECTING',
  ERROR: 'ERROR',
});

export const BLUETOOTH_TRANSPORT_EVENT = Object.freeze({
  STATE: 'state',
  DEVICE: 'device',
  DISCOVERY_FINISHED: 'discoveryFinished',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
  MESSAGE: 'message',
  ERROR: 'error',
});

const DEFAULT_CONNECT_OPTIONS = Object.freeze({
  maxAttempts: 2,
  // A first secure RFCOMM connection can include Android's pairing dialog.
  // Three seconds closed the socket before a person could confirm it.
  connectTimeoutMs: 15000,
  retryDelayMs: 400,
  autoReconnect: true,
  maxReconnectAttempts: 3,
  reconnectBaseDelayMs: 700,
});

function createDefaultEmitter(nativeModule) {
  if (!nativeModule) return null;
  try {
    return new NativeEventEmitter(nativeModule);
  } catch (e) {
    return null;
  }
}

function normalizeAddress(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function normalizeNodeId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isProvisionalBluetoothPeerId(value) {
  return normalizeNodeId(value).toLowerCase().startsWith('bluetooth:');
}

function createIdentityError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'BluetoothIdentityError';
  error.code = code;
  Object.assign(error, details);
  return error;
}

function getBluetoothEndpoint(peer) {
  return peer?.transports?.[TRANSPORTS.BLUETOOTH] || peer?.transports?.BLUETOOTH || peer || {};
}

/**
 * Standalone/fallback seam for the native authenticated RFCOMM transport.
 *
 * Ownership boundary:
 * - owns Bluetooth discovery, secure socket lifecycle, bounded native retries,
 *   text frames and Bluetooth events;
 * - does not own LAN/P2P selection, signaling, calls, persistence or UI state;
 * - exposes `createFallbackHooks()` in the exact shape expected by
 *   TransportFallbackEngine without importing or mutating that engine.
 */
export class BluetoothTransportAdapter {
  constructor(options = {}) {
    this.nativeModule = options.nativeModule || NativeModules?.BluetoothConnectionModule || null;
    this.emitter = options.emitter || createDefaultEmitter(this.nativeModule);
    this.registry = options.registry || peerRegistry;
    this.defaultConnectOptions = {
      ...DEFAULT_CONNECT_OPTIONS,
      ...(options.connectOptions || {}),
    };

    this.state = BLUETOOTH_TRANSPORT_STATE.IDLE;
    this.listening = false;
    this.observing = false;
    this.subscriptions = [];
    this.listeners = new Set();
    this.devices = new Map();
    this.pendingConnect = null;
    this.connectGeneration = 0;
    this.activePeer = null;
    this.activeRoute = null;
    this.activeRouteOwnership = null;
    this.lastError = null;
  }

  isSupported() {
    return !!(
      this.nativeModule &&
      typeof this.nativeModule.startDiscovery === 'function' &&
      typeof this.nativeModule.startListening === 'function' &&
      (typeof this.nativeModule.connect === 'function' ||
        typeof this.nativeModule.connectToDevice === 'function') &&
      typeof this.nativeModule.sendMessage === 'function'
    );
  }

  getStatus() {
    return {
      state: this.state,
      listening: this.listening,
      observing: this.observing,
      pendingPeerId: this.pendingConnect?.peer?.deviceId || null,
      activePeerId: this.activePeer?.deviceId || null,
      activeRoute: this.activeRoute ? { ...this.activeRoute } : null,
      devices: [...this.devices.values()],
      lastError: this.lastError,
    };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _notify(type, payload = {}) {
    const event = { type, ...payload, status: this.getStatus() };
    this.listeners.forEach(listener => {
      try { listener(event); } catch (e) {}
    });
  }

  startObserving() {
    if (this.observing || !this.emitter?.addListener) return false;
    this.observing = true;
    this.subscriptions = [
      this.emitter.addListener('BT_STATE_CHANGED', event => this._onState(event)),
      this.emitter.addListener('BT_LISTENING', event => this._onListening(event)),
      this.emitter.addListener('BT_DISCOVERY_STARTED', event => this._onDiscoveryStarted(event)),
      this.emitter.addListener('BT_DEVICE_FOUND', event => this._onDevice(event)),
      this.emitter.addListener('BT_DISCOVERY_FINISHED', event => this._onDiscoveryFinished(event)),
      this.emitter.addListener('BT_CONNECTED', event => this._onConnected(event)),
      this.emitter.addListener('BT_RECONNECTING', event => this._onReconnecting(event)),
      this.emitter.addListener('BT_DISCONNECTED', event => this._onDisconnected(event)),
      this.emitter.addListener('BT_MESSAGE', event => this._onMessage(event)),
      this.emitter.addListener('BT_ERROR', event => this._onError(event)),
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

  async startListening() {
    if (!this.isSupported()) throw new Error('Bluetooth transport is unavailable');
    this.startObserving();
    await this.nativeModule.startListening();
    this.listening = true;
    if (this.state === BLUETOOTH_TRANSPORT_STATE.IDLE) {
      this.state = BLUETOOTH_TRANSPORT_STATE.LISTENING;
    }
    return true;
  }

  async discover(options = {}) {
    if (!this.isSupported()) throw new Error('Bluetooth transport is unavailable');
    this.startObserving();
    this.devices.clear();

    if (options.startListening !== false) await this.startListening();
    if (options.requestDiscoverable === true && typeof this.nativeModule.requestDiscoverable === 'function') {
      await this.nativeModule.requestDiscoverable(options.discoverableSeconds || 120);
    }

    this.state = BLUETOOTH_TRANSPORT_STATE.DISCOVERING;
    const timeoutMs = options.timeoutMs || 12000;
    if (typeof this.nativeModule.startDiscoveryWithTimeout === 'function') {
      await this.nativeModule.startDiscoveryWithTimeout(timeoutMs);
    } else {
      await this.nativeModule.startDiscovery();
    }
    return true;
  }

  async stopDiscovery() {
    if (typeof this.nativeModule?.stopDiscovery === 'function') {
      await this.nativeModule.stopDiscovery();
    }
    if (this.state === BLUETOOTH_TRANSPORT_STATE.DISCOVERING) {
      this.state = this.listening
        ? BLUETOOTH_TRANSPORT_STATE.LISTENING
        : BLUETOOTH_TRANSPORT_STATE.IDLE;
    }
    return true;
  }

  async connectPeer(peer, options = {}) {
    if (!this.isSupported()) throw new Error('Bluetooth transport is unavailable');
    const endpoint = getBluetoothEndpoint(peer);
    const address = normalizeAddress(endpoint.address || peer?.btAddress || peer?.address);
    if (!address) throw new Error('Bluetooth address is missing for peer');
    if (this.pendingConnect) throw new Error('Another Bluetooth connection attempt is already active');
    if (this.activeRoute) {
      if (normalizeAddress(this.activeRoute.address) === address) {
        try {
          const authenticatedPeer = this._bindAuthenticatedPeer(peer, this.activeRoute);
          this.activePeer = authenticatedPeer;
          const route = {
            ...this.activeRoute,
            deviceId: authenticatedPeer.deviceId,
            peer: authenticatedPeer,
            reused: true,
          };
          this.activeRoute = route;
          this._upsertConnectedPeer(authenticatedPeer, route);
          return route;
        } catch (error) {
          await this._rejectAuthenticatedConnection(null, error, peer);
          throw error;
        }
      }
      throw new Error('Another Bluetooth peer is already connected');
    }

    const attempt = {
      generation: ++this.connectGeneration,
      peer,
      address,
      cancelled: false,
      nativeStarted: false,
      identityError: null,
      identityDisconnectPromise: null,
    };
    this.pendingConnect = attempt;
    this.state = BLUETOOTH_TRANSPORT_STATE.CONNECTING;
    this._notify(BLUETOOTH_TRANSPORT_EVENT.STATE, { state: this.state, address });

    try {
      this.startObserving();
      if (options.startListening !== false) {
        await this.startListening();
        this._throwIfConnectAttemptCancelled(attempt);
      }
      await this.stopDiscovery();
      this._throwIfConnectAttemptCancelled(attempt);

      const nativeOptions = { ...this.defaultConnectOptions, ...options };
      delete nativeOptions.startListening;
      attempt.nativeStarted = true;
      const result = typeof this.nativeModule.connect === 'function'
        ? await this.nativeModule.connect(address, nativeOptions)
        : await this.nativeModule.connectToDevice(address);
      this._throwIfConnectAttemptCancelled(attempt);

      if (attempt.identityError) {
        await this._rejectAuthenticatedConnection(attempt, attempt.identityError, peer);
        throw attempt.identityError;
      }

      const route = {
        transport: TRANSPORTS.BLUETOOTH,
        address,
        security: result?.security || 'AUTHENTICATED_RFCOMM',
        protocolVersion: result?.protocolVersion ?? null,
        remoteNodeId: result?.remoteNodeId || null,
        sessionId: result?.sessionId || null,
        deviceName: result?.deviceName || peer?.deviceName || peer?.name || 'Bluetooth Device',
        bonded: result?.bonded !== false,
      };
      const authenticatedPeer = this._bindAuthenticatedPeer(peer, route);
      const authenticatedRoute = {
        ...route,
        deviceId: authenticatedPeer.deviceId,
        peer: authenticatedPeer,
      };
      this.activePeer = authenticatedPeer;
      this.activeRoute = authenticatedRoute;
      this.activeRouteOwnership = result?.incoming === true
        ? null
        : this._routeOwnership(attempt, authenticatedRoute);
      this.state = BLUETOOTH_TRANSPORT_STATE.CONNECTED;
      this._upsertConnectedPeer(authenticatedPeer, authenticatedRoute);
      return authenticatedRoute;
    } catch (error) {
      if (attempt.cancelled || attempt.generation !== this.connectGeneration) {
        throw this._connectCancellationError(attempt);
      }
      const failure = attempt.identityError || error;
      if (failure?.name === 'BluetoothIdentityError') {
        await this._rejectAuthenticatedConnection(attempt, failure, peer);
      }
      if (!attempt.cancelled) {
        this.state = BLUETOOTH_TRANSPORT_STATE.ERROR;
        this.lastError = failure;
      }
      throw failure;
    } finally {
      if (this.pendingConnect === attempt) this.pendingConnect = null;
    }
  }

  async cancelConnect(reason = 'Bluetooth connection cancelled') {
    const cancellationReason = typeof reason === 'string'
      ? reason
      : reason?.reason || 'Bluetooth connection cancelled';
    const attempt = this.pendingConnect;
    const ownsActivatedRoute = this._isRouteOwnedByAttempt(attempt);
    const activatedPeer = ownsActivatedRoute ? this.activePeer : null;
    if (attempt) {
      attempt.cancelled = true;
      attempt.cancelReason = cancellationReason;
      if (attempt.generation === this.connectGeneration) this.connectGeneration += 1;
      if (this.pendingConnect === attempt) this.pendingConnect = null;
    }
    if (ownsActivatedRoute) {
      this.activePeer = null;
      this.activeRoute = null;
      this.activeRouteOwnership = null;
      if (activatedPeer?.deviceId) this.registry?.setPeerDisconnected?.(activatedPeer.deviceId);
    }
    if (!this.activeRoute) {
      this.state = this.listening
        ? BLUETOOTH_TRANSPORT_STATE.LISTENING
        : BLUETOOTH_TRANSPORT_STATE.IDLE;
    }
    try {
      if (typeof this.nativeModule?.cancelConnect === 'function') {
        await this.nativeModule.cancelConnect();
      }
    } finally {
      if (ownsActivatedRoute && typeof this.nativeModule?.disconnect === 'function') {
        await this.nativeModule.disconnect();
      }
    }
    return true;
  }

  async sendMessage(message, session = null) {
    if (!this.activeRoute) throw new Error('Bluetooth transport is not connected');
    let payload;
    if (typeof message === 'string') {
      payload = message;
    } else {
      try {
        payload = JSON.stringify(message);
      } catch (error) {
        throw new TypeError(`Bluetooth message is not JSON serializable: ${error?.message || error}`);
      }
      if (typeof payload !== 'string') {
        throw new TypeError('Bluetooth message must be a string or JSON-serializable value');
      }
    }
    await this.nativeModule.sendMessage(payload);
    return true;
  }

  subscribeDisconnect(observer) {
    if (typeof observer !== 'function') return () => {};
    return this.subscribe(event => {
      if (event.type === BLUETOOTH_TRANSPORT_EVENT.DISCONNECTED) observer(event);
    });
  }

  async disconnect() {
    this.state = BLUETOOTH_TRANSPORT_STATE.DISCONNECTING;
    await this.cancelConnect('Bluetooth transport disconnecting');
    if (typeof this.nativeModule?.disconnect === 'function') {
      await this.nativeModule.disconnect();
    }
    const previousPeer = this.activePeer;
    this.activePeer = null;
    this.activeRoute = null;
    this.activeRouteOwnership = null;
    this.state = this.listening
      ? BLUETOOTH_TRANSPORT_STATE.LISTENING
      : BLUETOOTH_TRANSPORT_STATE.IDLE;
    if (previousPeer?.deviceId) this.registry?.setPeerDisconnected?.(previousPeer.deviceId);
    this._notify(BLUETOOTH_TRANSPORT_EVENT.STATE, { state: this.state, intentional: true });
    return true;
  }

  createFallbackHooks() {
    return {
      connectBluetooth: peer => this.connectPeer(peer),
      cancelBluetooth: () => this.cancelConnect('Bluetooth fallback deadline reached'),
    };
  }

  _onState(event = {}) {
    if (Object.values(BLUETOOTH_TRANSPORT_STATE).includes(event.state)) {
      this.state = event.state;
    }
    if (typeof event.listening === 'boolean') this.listening = event.listening;
    this._notify(BLUETOOTH_TRANSPORT_EVENT.STATE, event);
  }

  _onListening(event = {}) {
    this.listening = event.active === true;
    if (!this.activeRoute && this.state !== BLUETOOTH_TRANSPORT_STATE.DISCOVERING) {
      this.state = this.listening
        ? BLUETOOTH_TRANSPORT_STATE.LISTENING
        : BLUETOOTH_TRANSPORT_STATE.IDLE;
    }
    this._notify(BLUETOOTH_TRANSPORT_EVENT.STATE, { state: this.state, listening: this.listening });
  }

  _onDiscoveryStarted(event = {}) {
    this.state = BLUETOOTH_TRANSPORT_STATE.DISCOVERING;
    this._notify(BLUETOOTH_TRANSPORT_EVENT.STATE, { ...event, state: this.state });
  }

  _onDevice(event = {}) {
    const address = normalizeAddress(event.address);
    if (!address) return;
    const device = { ...(this.devices.get(address) || {}), ...event, address };
    this.devices.set(address, device);
    this._notify(BLUETOOTH_TRANSPORT_EVENT.DEVICE, { device });
  }

  _onDiscoveryFinished(event = {}) {
    if (this.state === BLUETOOTH_TRANSPORT_STATE.DISCOVERING) {
      this.state = this.listening
        ? BLUETOOTH_TRANSPORT_STATE.LISTENING
        : BLUETOOTH_TRANSPORT_STATE.IDLE;
    }
    this._notify(BLUETOOTH_TRANSPORT_EVENT.DISCOVERY_FINISHED, event);
  }

  _onConnected(event = {}) {
    const attempt = this.pendingConnect;
    const address = normalizeAddress(event.address || attempt?.address);
    const isIncoming = event.incoming === true;
    const ownsNativeReconnect = !!(
      !isIncoming &&
      event.reconnected === true &&
      !attempt &&
      this.activeRoute &&
      this.activePeer &&
      address === normalizeAddress(this.activeRoute.address) &&
      normalizeNodeId(event.remoteNodeId) === normalizeNodeId(this.activePeer.deviceId)
    );
    const ownsOutboundConnection = !!(
      !isIncoming &&
      attempt &&
      !attempt.cancelled &&
      attempt.nativeStarted &&
      attempt.generation === this.connectGeneration &&
      (!address || address === attempt.address)
    );
    if (!isIncoming && !ownsOutboundConnection && !ownsNativeReconnect) {
      this._disconnectUnownedOutboundConnection(event);
      return;
    }
    const peer = attempt?.peer || this.activePeer;
    const route = {
      transport: TRANSPORTS.BLUETOOTH,
      address,
      security: event.security || 'AUTHENTICATED_RFCOMM',
      protocolVersion: event.protocolVersion ?? null,
      remoteNodeId: event.remoteNodeId || null,
      sessionId: event.sessionId || null,
      deviceName: event.deviceName || peer?.deviceName || 'Bluetooth Device',
      bonded: event.bonded !== false,
    };
    let authenticatedPeer;
    try {
      authenticatedPeer = this._bindAuthenticatedPeer(peer, route);
    } catch (error) {
      if (this.pendingConnect) this.pendingConnect.identityError = error;
      this._rejectAuthenticatedConnection(this.pendingConnect, error, peer).catch(() => false);
      return;
    }
    const authenticatedRoute = {
      ...route,
      deviceId: authenticatedPeer.deviceId,
      peer: authenticatedPeer,
    };
    this.activePeer = authenticatedPeer;
    this.activeRoute = authenticatedRoute;
    this.activeRouteOwnership = ownsOutboundConnection
      ? this._routeOwnership(attempt, authenticatedRoute)
      : null;
    this.state = BLUETOOTH_TRANSPORT_STATE.CONNECTED;
    this._upsertConnectedPeer(authenticatedPeer, authenticatedRoute);
    this._notify(BLUETOOTH_TRANSPORT_EVENT.CONNECTED, {
      ...event,
      deviceId: authenticatedPeer.deviceId,
      peer: authenticatedPeer,
      route: authenticatedRoute,
    });
  }

  _onReconnecting(event = {}) {
    this.state = BLUETOOTH_TRANSPORT_STATE.RECONNECTING;
    this._notify(BLUETOOTH_TRANSPORT_EVENT.RECONNECTING, event);
  }

  _onMessage(event = {}) {
    let message = event.text;
    if (typeof event.text === 'string') {
      try { message = JSON.parse(event.text); } catch (e) {}
    }
    this._notify(BLUETOOTH_TRANSPORT_EVENT.MESSAGE, { ...event, message });
  }

  _onDisconnected(event = {}) {
    const peer = this.activePeer;
    this.activePeer = null;
    this.activeRoute = null;
    this.activeRouteOwnership = null;
    this.state = this.listening
      ? BLUETOOTH_TRANSPORT_STATE.LISTENING
      : BLUETOOTH_TRANSPORT_STATE.IDLE;
    if (peer?.deviceId) this.registry?.setPeerDisconnected?.(peer.deviceId);
    this._notify(BLUETOOTH_TRANSPORT_EVENT.DISCONNECTED, event);
  }

  _onError(event = {}) {
    const error = new Error(event.message || 'Bluetooth transport error');
    error.code = event.code || 'BT_ERROR';
    error.recoverable = event.recoverable !== false;
    this.lastError = error;
    if (!error.recoverable && !this.activeRoute) this.state = BLUETOOTH_TRANSPORT_STATE.ERROR;
    this._notify(BLUETOOTH_TRANSPORT_EVENT.ERROR, { ...event, error });
  }

  _connectCancellationError(attempt) {
    return new Error(attempt?.cancelReason || 'Bluetooth connection was cancelled');
  }

  _throwIfConnectAttemptCancelled(attempt) {
    if (
      attempt?.cancelled ||
      this.pendingConnect !== attempt ||
      attempt?.generation !== this.connectGeneration
    ) {
      throw this._connectCancellationError(attempt);
    }
  }

  _routeOwnership(attempt, route) {
    if (!attempt) return null;
    return {
      generation: attempt.generation,
      sessionId: route?.sessionId || null,
      address: normalizeAddress(route?.address),
    };
  }

  _isRouteOwnedByAttempt(attempt) {
    const ownership = this.activeRouteOwnership;
    if (!attempt || !ownership || !this.activeRoute) return false;
    if (ownership.generation !== attempt.generation) return false;
    const activeAddress = normalizeAddress(this.activeRoute.address);
    if (ownership.address && activeAddress !== ownership.address) return false;
    if (
      ownership.sessionId &&
      this.activeRoute.sessionId &&
      ownership.sessionId !== this.activeRoute.sessionId
    ) {
      return false;
    }
    return activeAddress === attempt.address;
  }

  _disconnectUnownedOutboundConnection(event = {}) {
    const activeSessionId = this.activeRoute?.sessionId || null;
    const eventSessionId = event.sessionId || null;
    if (this.activeRoute && activeSessionId && eventSessionId !== activeSessionId) {
      // The rejected notification belongs to an obsolete socket. Never tear
      // down a newer authenticated incoming route that already owns native.
      return;
    }
    const previousPeer = this.activePeer;
    this.activePeer = null;
    this.activeRoute = null;
    this.activeRouteOwnership = null;
    this.state = this.listening
      ? BLUETOOTH_TRANSPORT_STATE.LISTENING
      : BLUETOOTH_TRANSPORT_STATE.IDLE;
    if (previousPeer?.deviceId) this.registry?.setPeerDisconnected?.(previousPeer.deviceId);
    Promise.resolve()
      .then(() => this.nativeModule?.disconnect?.())
      .catch(() => false);
  }

  _bindAuthenticatedPeer(peer, route) {
    const remoteNodeId = normalizeNodeId(route?.remoteNodeId);
    const expectedDeviceId = normalizeNodeId(peer?.deviceId);
    if (!remoteNodeId) {
      throw createIdentityError(
        'BT_IDENTITY_MISSING',
        'Authenticated Bluetooth handshake did not provide a stable remote node ID',
        { expectedDeviceId: expectedDeviceId || null },
      );
    }
    if (
      expectedDeviceId &&
      !isProvisionalBluetoothPeerId(expectedDeviceId) &&
      expectedDeviceId !== remoteNodeId
    ) {
      throw createIdentityError(
        'BT_IDENTITY_MISMATCH',
        `Bluetooth peer identity mismatch: expected ${expectedDeviceId}, received ${remoteNodeId}`,
        { expectedDeviceId, remoteNodeId },
      );
    }

    const endpoint = getBluetoothEndpoint(peer);
    return {
      ...(peer || {}),
      deviceId: remoteNodeId,
      deviceName: route?.deviceName || peer?.deviceName || peer?.name || 'Bluetooth Device',
      transports: {
        ...(peer?.transports || {}),
        [TRANSPORTS.BLUETOOTH]: {
          ...endpoint,
          address: normalizeAddress(route?.address || endpoint?.address),
          isReachable: true,
        },
      },
    };
  }

  async _rejectAuthenticatedConnection(attempt, error, peer) {
    if (attempt?.identityDisconnectPromise) {
      await attempt.identityDisconnectPromise;
      return;
    }
    if (attempt) attempt.identityError = error;
    const previousPeer = this.activePeer || peer;
    this.activePeer = null;
    this.activeRoute = null;
    this.activeRouteOwnership = null;
    this.state = BLUETOOTH_TRANSPORT_STATE.ERROR;
    this.lastError = error;
    if (previousPeer?.deviceId) this.registry?.setPeerDisconnected?.(previousPeer.deviceId);
    this._notify(BLUETOOTH_TRANSPORT_EVENT.ERROR, {
      code: error.code,
      message: error.message,
      recoverable: false,
      error,
    });
    const disconnectPromise = Promise.resolve()
      .then(() => this.nativeModule?.disconnect?.())
      .catch(() => false);
    if (attempt) attempt.identityDisconnectPromise = disconnectPromise;
    await disconnectPromise;
  }

  _upsertConnectedPeer(peer, route) {
    if (!peer?.deviceId || !route?.address || !this.registry) return;
    this.registry.upsertBluetoothPeer({
      deviceId: peer.deviceId,
      deviceName: peer.deviceName || peer.name || route.deviceName,
      address: route.address,
      connectionEpoch: route.sessionId,
      isOnline: true,
    });
    this.registry.setPeerConnected(peer.deviceId, TRANSPORTS.BLUETOOTH);
  }
}

export function createBluetoothFallbackHooks(adapter) {
  if (!adapter || typeof adapter.createFallbackHooks !== 'function') {
    throw new TypeError('BluetoothTransportAdapter instance is required');
  }
  return adapter.createFallbackHooks();
}

export default BluetoothTransportAdapter;
