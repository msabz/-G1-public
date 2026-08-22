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
  connectTimeoutMs: 3000,
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
    this.activePeer = null;
    this.activeRoute = null;
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
      if (normalizeAddress(this.activeRoute.address) === address) return { ...this.activeRoute, reused: true };
      throw new Error('Another Bluetooth peer is already connected');
    }

    this.startObserving();
    if (options.startListening !== false) await this.startListening();
    await this.stopDiscovery();

    const attempt = { peer, address, cancelled: false };
    this.pendingConnect = attempt;
    this.state = BLUETOOTH_TRANSPORT_STATE.CONNECTING;
    this._notify(BLUETOOTH_TRANSPORT_EVENT.STATE, { state: this.state, address });

    try {
      const nativeOptions = { ...this.defaultConnectOptions, ...options };
      delete nativeOptions.startListening;
      const result = typeof this.nativeModule.connect === 'function'
        ? await this.nativeModule.connect(address, nativeOptions)
        : await this.nativeModule.connectToDevice(address);
      if (attempt.cancelled) throw new Error('Bluetooth connection was cancelled');

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
      this.activePeer = peer;
      this.activeRoute = route;
      this.state = BLUETOOTH_TRANSPORT_STATE.CONNECTED;
      this._upsertConnectedPeer(peer, route);
      return route;
    } catch (error) {
      if (!attempt.cancelled) {
        this.state = BLUETOOTH_TRANSPORT_STATE.ERROR;
        this.lastError = error;
      }
      throw error;
    } finally {
      if (this.pendingConnect === attempt) this.pendingConnect = null;
    }
  }

  async cancelConnect(reason = 'Bluetooth connection cancelled') {
    if (this.pendingConnect) {
      this.pendingConnect.cancelled = true;
      this.pendingConnect.cancelReason = reason;
    }
    if (typeof this.nativeModule?.cancelConnect === 'function') {
      await this.nativeModule.cancelConnect();
    }
    this.pendingConnect = null;
    if (!this.activeRoute) {
      this.state = this.listening
        ? BLUETOOTH_TRANSPORT_STATE.LISTENING
        : BLUETOOTH_TRANSPORT_STATE.IDLE;
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
    const address = normalizeAddress(event.address || this.pendingConnect?.address);
    const peer = this.pendingConnect?.peer || this.activePeer;
    this.activePeer = peer || null;
    this.activeRoute = {
      transport: TRANSPORTS.BLUETOOTH,
      address,
      security: event.security || 'AUTHENTICATED_RFCOMM',
      protocolVersion: event.protocolVersion ?? null,
      remoteNodeId: event.remoteNodeId || null,
      sessionId: event.sessionId || null,
      deviceName: event.deviceName || peer?.deviceName || 'Bluetooth Device',
      bonded: event.bonded !== false,
    };
    this.state = BLUETOOTH_TRANSPORT_STATE.CONNECTED;
    this._upsertConnectedPeer(peer, this.activeRoute);
    this._notify(BLUETOOTH_TRANSPORT_EVENT.CONNECTED, { ...event, route: this.activeRoute });
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
