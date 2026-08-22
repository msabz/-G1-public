import { SignalingSession, connectOutboundSocket } from './SignalingSession';
import { getDefaultSignalingListener } from './SignalingListener';
import { peerRegistry, PEER_STATUS, TRANSPORTS } from './PeerRegistry';

export const COORDINATOR_STATE = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  DISCONNECTING: 'DISCONNECTING',
  ERROR: 'ERROR',
};

export const HEARTBEAT_INTERVAL_MS = 6000;
export const HEARTBEAT_TIMEOUT_MS = 18000;

/**
 * Bluetooth adapter boundary (no native module import in this coordinator):
 *
 * connectPeer(peer, { address, timeoutMs, attemptToken }) -> session | { session }
 * cancelConnect({ attemptToken, reason })
 * sendMessage(message, session) -> boolean (or expose session.sendMessage)
 * disconnect(session, { reason }) (or expose session.disconnect/destroy)
 * subscribeDisconnect(observer, session) -> removable subscription
 *
 * Make-before-break additionally uses prepareConnection, commitConnection and
 * discardConnection. Every callback receives the immutable attempt token.
 */
export const BLUETOOTH_ADAPTER_CONTRACT = Object.freeze({
  required: Object.freeze(['connectPeer']),
  optional: Object.freeze([
    'cancelConnect',
    'disconnect',
    'discardConnection',
    'prepareConnection',
    'commitConnection',
    'sendMessage',
    'subscribeDisconnect',
    'setIdentity',
    'getStatus',
  ]),
});

export class CoordinatorConnectionBusyError extends Error {
  constructor(activePeerId, requestedPeerId) {
    super(`ConnectionCoordinator already owns a session for ${activePeerId}; cannot connect ${requestedPeerId}`);
    this.name = 'CoordinatorConnectionBusyError';
    this.activePeerId = activePeerId;
    this.requestedPeerId = requestedPeerId;
  }
}

export class TransportTransitionLimitError extends Error {
  constructor(limit) {
    super(`Transport transition limit reached (${limit})`);
    this.name = 'TransportTransitionLimitError';
    this.limit = limit;
  }
}

export class TransportHandoverTimeoutError extends Error {
  constructor(transport, timeoutMs) {
    super(`Transport handover to ${transport} timed out after ${timeoutMs}ms`);
    this.name = 'TransportHandoverTimeoutError';
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }
}

export class ConnectionCoordinator {
  constructor(options = {}) {
    this.myDeviceId = options.myDeviceId || '';
    this.myDeviceName = options.myDeviceName || 'G1 Device';
    this.state = COORDINATOR_STATE.IDLE;
    this.activeSession = null;
    this.currentPeer = null;
    this.currentTransport = null;
    this.preferredTransport = null;
    this.generation = 0;
    this.attemptSequence = 0;
    this.pendingAttempt = null;
    this.pendingHandover = null;
    this.transitionCount = 0;
    this.maxTransportTransitions = Number.isFinite(options.maxTransportTransitions)
      ? Math.max(0, Math.floor(options.maxTransportTransitions))
      : 2;

    this.onStateChange = options.onStateChange || null;
    this.onMessage = options.onMessage || null;
    this.onConnected = options.onConnected || null;
    this.onDisconnected = options.onDisconnected || null;
    this.onTransportChanged = options.onTransportChanged || null;
    this.onError = options.onError || null;

    this.heartbeatInterval = null;
    this.lastReceivedHeartbeat = 0;
    this.pendingConnectAbort = null;

    // Optional high-level signaling owner. When present, the coordinator owns
    // logical connection state while the injected owner owns the socket/session,
    // heartbeat and same-route signaling recovery. Keeping this dependency
    // injectable lets the live runtime adopt src/webrtc/signaling.js gradually
    // without importing React Native runtime code into this pure coordinator.
    this.signalingOwner = options.signalingOwner || null;
    this.activeSessionManagedExternally = false;
    this.signalingDisconnectSubscription = null;
    this.transportDisconnectSubscription = null;
    this.activeTransportAdapter = null;

    // Wi-Fi Direct transport adapter owns only Android P2P route lifecycle:
    // discovery observations, group negotiation, bind/unbind and cleanup. It
    // never owns signaling, heartbeat, peer identity semantics or UI state.
    this.p2pAdapter = options.p2pAdapter || null;

    // Bluetooth is injected behind a transport adapter. The coordinator never
    // imports the React Native module directly, which keeps discovery/native
    // details out of policy and makes ownership testable.
    this.bluetoothAdapter = null;
    this.transportHandoverAdapters = new Map();
    this.fallbackEngine = options.fallbackEngine || null;
    if (options.bluetoothAdapter) {
      this._validateBluetoothAdapter(options.bluetoothAdapter);
      this.bluetoothAdapter = options.bluetoothAdapter;
      this.transportHandoverAdapters.set(TRANSPORTS.BLUETOOTH, options.bluetoothAdapter);
    }
    for (const [transport, adapter] of Object.entries(options.transportAdapters || {})) {
      if (adapter) this.transportHandoverAdapters.set(transport, adapter);
    }
  }

  setIdentity({ deviceId, deviceName }) {
    this.myDeviceId = deviceId;
    this.myDeviceName = deviceName;
    peerRegistry.setMyDeviceId(deviceId);
    try {
      this.p2pAdapter?.setIdentity?.({ deviceId, deviceName });
    } catch (e) {}
    try {
      this.bluetoothAdapter?.setIdentity?.({ deviceId, deviceName });
    } catch (e) {}
  }

  _validateBluetoothAdapter(adapter) {
    if (!adapter || typeof adapter.connectPeer !== 'function') {
      throw new TypeError('Bluetooth adapter must implement connectPeer(peer, options)');
    }
    return adapter;
  }

  setFallbackEngine(engine) {
    if (engine === this.fallbackEngine) return;
    if (this.pendingAttempt || this.pendingHandover) {
      throw new Error('Cannot replace fallback engine while a transport attempt is active');
    }
    this.fallbackEngine = engine || null;
  }

  setBluetoothAdapter(adapter) {
    if (adapter === this.bluetoothAdapter) return;
    if (this.state === COORDINATOR_STATE.CONNECTING || this.state === COORDINATOR_STATE.CONNECTED) {
      throw new Error('Cannot replace Bluetooth adapter while a connection is active');
    }
    if (adapter) this._validateBluetoothAdapter(adapter);
    this.bluetoothAdapter = adapter || null;
    if (adapter) this.transportHandoverAdapters.set(TRANSPORTS.BLUETOOTH, adapter);
    else this.transportHandoverAdapters.delete(TRANSPORTS.BLUETOOTH);
    if (adapter && this.myDeviceId) {
      try {
        adapter.setIdentity?.({
          deviceId: this.myDeviceId,
          deviceName: this.myDeviceName,
        });
      } catch (e) {}
    }
  }

  setTransportHandoverAdapter(transport, adapter) {
    if (!Object.values(TRANSPORTS).includes(transport)) {
      throw new Error(`Unsupported transport: ${transport}`);
    }
    if (this.pendingHandover || (this.state === COORDINATOR_STATE.CONNECTED && transport === this.currentTransport)) {
      throw new Error('Cannot replace an active transport adapter');
    }
    if (transport === TRANSPORTS.BLUETOOTH) {
      this.setBluetoothAdapter(adapter);
      return;
    }
    if (adapter && typeof adapter.prepareConnection !== 'function') {
      throw new TypeError('Handover adapter must implement prepareConnection(peer, options)');
    }
    if (adapter) this.transportHandoverAdapters.set(transport, adapter);
    else this.transportHandoverAdapters.delete(transport);
  }

  setSignalingOwner(owner) {
    if (owner === this.signalingOwner) return;
    if (this.state === COORDINATOR_STATE.CONNECTING || this.state === COORDINATOR_STATE.CONNECTED) {
      throw new Error('Cannot replace signaling owner while a connection is active');
    }
    this._clearSignalingOwnerDisconnectSubscription();
    this.signalingOwner = owner || null;
  }

  setP2pAdapter(adapter) {
    if (adapter === this.p2pAdapter) return;
    if (this.state === COORDINATOR_STATE.CONNECTING || this.state === COORDINATOR_STATE.CONNECTED) {
      throw new Error('Cannot replace P2P adapter while a connection is active');
    }
    this.p2pAdapter = adapter || null;
    if (this.p2pAdapter && this.myDeviceId) {
      try {
        this.p2pAdapter.setIdentity?.({
          deviceId: this.myDeviceId,
          deviceName: this.myDeviceName,
        });
      } catch (e) {}
    }
  }

  connectPeer(peer, options = {}) {
    if (!this.fallbackEngine || typeof this.fallbackEngine.connect !== 'function') {
      return Promise.reject(new Error('Transport fallback engine is not configured'));
    }
    return this.fallbackEngine.connect(peer, options.handlers || {}, options);
  }

  _connectionKey(peer, transport) {
    return `${peer?.deviceId || ''}:${transport}`;
  }

  _getReusableConnection(peer, transport) {
    const key = this._connectionKey(peer, transport);
    if (this.pendingAttempt?.key === key) {
      return this.pendingAttempt.promise;
    }

    if (this.pendingHandover) {
      return Promise.reject(new CoordinatorConnectionBusyError(
        this.currentPeer?.deviceId || this.pendingHandover.token.peerId,
        peer?.deviceId || '',
      ));
    }

    if (this.state !== COORDINATOR_STATE.CONNECTED) return null;
    if (this.activeSession?.isConnected === false) {
      this._handleSessionTermination({ releaseTransport: true });
      return null;
    }
    const samePeer = this.currentPeer?.deviceId === peer?.deviceId;
    const sameTransport = this.currentTransport === transport;
    if (samePeer && sameTransport && this.activeSession) {
      return Promise.resolve(this.activeSession);
    }
    return Promise.reject(new CoordinatorConnectionBusyError(
      this.currentPeer?.deviceId || '',
      peer?.deviceId || '',
    ));
  }

  _createAttemptToken(peer, transport) {
    const generation = ++this.generation;
    const attemptId = ++this.attemptSequence;
    return Object.freeze({
      generation,
      attemptId,
      peerId: peer?.deviceId || '',
      transport,
    });
  }

  _trackPendingAttempt(peer, transport, token, promise) {
    const record = {
      key: this._connectionKey(peer, transport),
      token,
      promise: null,
    };
    const tracked = Promise.resolve(promise).finally(() => {
      if (this.pendingAttempt === record) {
        this.pendingAttempt = null;
      }
    });
    record.promise = tracked;
    this.pendingAttempt = record;
    return tracked;
  }

  _isAttemptCurrent(token) {
    return this.generation === token?.generation &&
      this.pendingAttempt?.token === token;
  }

  _clearTransportDisconnectSubscription() {
    const subscription = this.transportDisconnectSubscription;
    this.transportDisconnectSubscription = null;
    if (!subscription) return;
    try {
      if (typeof subscription === 'function') subscription();
      else subscription.remove?.();
    } catch (e) {}
  }

  _subscribeToTransportDisconnect(adapter, session, generation) {
    this._clearTransportDisconnectSubscription();
    if (typeof adapter?.subscribeDisconnect !== 'function') return;
    const observer = () => {
      if (
        this.generation !== generation ||
        this.activeTransportAdapter !== adapter ||
        this.activeSession !== session ||
        this.state !== COORDINATOR_STATE.CONNECTED
      ) {
        return;
      }
      this._handleSessionTermination();
    };

    try {
      const subscription = adapter.subscribeDisconnect(observer, session) || null;
      if (
        this.generation !== generation ||
        this.activeTransportAdapter !== adapter ||
        this.activeSession !== session ||
        this.state !== COORDINATOR_STATE.CONNECTED
      ) {
        try {
          if (typeof subscription === 'function') subscription();
          else subscription?.remove?.();
        } catch (e) {}
        return;
      }
      this.transportDisconnectSubscription = subscription;
    } catch (error) {
      console.warn('Coordinator transport disconnect subscription failed:', error?.message || error);
    }
  }

  _setState(newState, payload = {}) {
    this.state = newState;
    if (this.onStateChange) {
      try {
        this.onStateChange(newState, payload);
      } catch (error) {
        console.warn('Coordinator state observer failed:', error?.message || error);
      }
    }
  }

  _clearSignalingOwnerDisconnectSubscription() {
    const subscription = this.signalingDisconnectSubscription;
    this.signalingDisconnectSubscription = null;
    if (!subscription) return;
    try {
      if (typeof subscription === 'function') subscription();
      else subscription.remove?.();
    } catch (e) {}
  }

  _releaseTransportAfterTermination(transport, session = null, transportAdapter = null) {
    if (transport === TRANSPORTS.BLUETOOTH && transportAdapter?.disconnect) {
      try {
        const result = transportAdapter.disconnect(session, { reason: 'session-terminated' });
        result?.catch?.(error => {
          console.warn('Coordinator Bluetooth cleanup after termination failed:', error?.message || error);
        });
      } catch (error) {
        console.warn('Coordinator Bluetooth cleanup after termination failed:', error?.message || error);
      }
      return;
    }
    if (transport !== TRANSPORTS.P2P || !this.p2pAdapter?.disconnect) return;
    try {
      const result = this.p2pAdapter.disconnect();
      if (result?.catch) {
        result.catch(error => {
          console.warn('Coordinator P2P cleanup after termination failed:', error?.message || error);
        });
      }
    } catch (error) {
      console.warn('Coordinator P2P cleanup after termination failed:', error?.message || error);
    }
  }

  _subscribeToSignalingOwnerDisconnect(owner, generation) {
    this._clearSignalingOwnerDisconnectSubscription();
    if (typeof owner?.subscribeDisconnect !== 'function') return;

    const observer = () => {
      if (
        this.generation !== generation ||
        !this.activeSessionManagedExternally ||
        this.state !== COORDINATOR_STATE.CONNECTED
      ) {
        return;
      }
      this._handleSessionTermination({ releaseTransport: true });
    };

    let subscription = null;
    try {
      subscription = owner.subscribeDisconnect(observer) || null;
    } catch (e) {
      console.warn('Coordinator signaling-owner disconnect subscription failed:', e?.message || e);
      return;
    }

    // A defensive owner may invoke the callback synchronously while subscribing.
    // If that already terminated/replaced this generation, do not retain a stale
    // subscription after the callback returns.
    if (
      this.generation !== generation ||
      !this.activeSessionManagedExternally ||
      this.state !== COORDINATOR_STATE.CONNECTED
    ) {
      try {
        if (typeof subscription === 'function') subscription();
        else subscription?.remove?.();
      } catch (e) {}
      return;
    }

    this.signalingDisconnectSubscription = subscription;
  }

  /**
   * Deterministic tie-breaking for simultaneous connections (Point 14)
   * The device with higher deviceId is the designated Initiator.
   * Lower deviceId yields and closes outbound attempt in favor of inbound.
   */
  shouldYieldToInbound(remoteDeviceId) {
    if (!this.myDeviceId || !remoteDeviceId) return false;
    return this.myDeviceId.localeCompare(remoteDeviceId) < 0;
  }

  handleIncomingSession(socket, peerInfo = {}) {
    const remoteDevId = peerInfo.deviceId || '';

    // If already connected or connecting to this peer, resolve race
    if (this.state === COORDINATOR_STATE.CONNECTING) {
      if (this.currentPeer?.deviceId !== remoteDevId) {
        try { socket.destroy(); } catch (e) {}
        return false;
      }
      if (this.shouldYieldToInbound(remoteDevId)) {
        console.log(`[Coordinator] Yielding outbound connect to inbound from ${remoteDevId}`);
        this.cancelConnecting();
      } else {
        console.log(`[Coordinator] Retaining outbound connect, rejecting inbound from ${remoteDevId}`);
        try { socket.destroy(); } catch (e) {}
        return false;
      }
    } else if (this.state === COORDINATOR_STATE.CONNECTED) {
      // The coordinator has one logical application session. A second inbound
      // socket (same or different peer) must not silently replace it.
      try { socket.destroy(); } catch (e) {}
      return false;
    }

    const session = new SignalingSession({
      isOutbound: false,
      peerInfo,
    });

    this._bindSessionEvents(session, ++this.generation);
    session.attachSocket(socket, this.generation);
    this.activeSession = session;
    this.activeSessionManagedExternally = false;
    this.activeTransportAdapter = null;
    this.currentPeer = peerInfo;
    this.currentTransport = peerInfo.transport || TRANSPORTS.LAN;
    this.preferredTransport = this.currentTransport;
    this.transitionCount = 0;

    this._startHeartbeat();
    this._setState(COORDINATOR_STATE.CONNECTED, { peer: peerInfo, transport: this.currentTransport });
    if (remoteDevId) {
      peerRegistry.setPeerConnected(remoteDevId, this.currentTransport);
    }
    if (this.onConnected) this.onConnected(peerInfo, this.currentTransport);

    return true;
  }

  /**
   * Adopt a session that is already owned by the injected signaling runtime.
   * This is intentionally transport-neutral: the coordinator only takes logical
   * peer/transport ownership and never opens a second socket or heartbeat.
   */
  adoptSignalingOwnerSession(peer, transport = TRANSPORTS.LAN, options = {}) {
    if (!peer?.deviceId) {
      throw new Error('Peer deviceId is required to adopt a signaling owner session');
    }

    const owner = this.signalingOwner;
    if (!owner || typeof owner.getActiveSession !== 'function') {
      throw new Error('Configured signaling owner is missing getActiveSession()');
    }

    const session = owner.getActiveSession();
    if (!session || session.isConnected === false) {
      throw new Error('Signaling owner has no connected session to adopt');
    }
    if (options?.requireInbound && session.isOutbound !== false) {
      throw new Error('Active signaling owner session is not inbound');
    }

    const samePeer = this.currentPeer?.deviceId === peer.deviceId;
    const sameTransport = this.currentTransport === transport;

    if (this.state === COORDINATOR_STATE.CONNECTED) {
      if (!samePeer || !sameTransport || !this.activeSessionManagedExternally) {
        throw new Error('Cannot adopt signaling owner session while a different connection is active');
      }

      // Same logical route may receive a replacement SignalingSession after the
      // owner's same-route recovery. Refresh the snapshot without creating a
      // second onConnected callback, generation or disconnect subscription.
      this.activeSession = session;
      return session;
    }

    if (this.state === COORDINATOR_STATE.DISCONNECTING) {
      throw new Error('Cannot adopt signaling owner session while disconnecting');
    }

    if (this.state === COORDINATOR_STATE.CONNECTING) {
      if (!samePeer) {
        throw new Error('Cannot adopt signaling owner session for a different peer while connecting');
      }
      // cancelConnecting() delegates to owner.cancelConnect(), which is the
      // connect-only cancellation primitive. It must not destroy a healthy
      // inbound session that has already won the race.
      this.cancelConnecting();
    }

    const currentGen = ++this.generation;
    this._clearSignalingOwnerDisconnectSubscription();
    this.pendingConnectAbort = null;
    this.activeSession = session;
    this.activeSessionManagedExternally = true;
    this.activeTransportAdapter = null;
    this.currentPeer = peer;
    this.currentTransport = transport;
    this.preferredTransport = transport;
    this.transitionCount = 0;

    this._stopHeartbeat();
    this._setState(COORDINATOR_STATE.CONNECTED, {
      peer,
      transport,
      adopted: true,
    });
    peerRegistry.setPeerConnected(peer.deviceId, transport);
    if (this.onConnected) this.onConnected(peer, transport);
    this._subscribeToSignalingOwnerDisconnect(owner, currentGen);

    return session;
  }

  connectLanPeer(peer, timeoutMs = 8000, connectOptions = {}) {
    const reusable = this._getReusableConnection(peer, TRANSPORTS.LAN);
    if (reusable) return reusable;
    const lanInfo = peer.transports?.[TRANSPORTS.LAN] || peer;
    if (!lanInfo.host) {
      return Promise.reject(new Error('LAN host is missing for peer'));
    }
    if (this.signalingOwner && typeof this.signalingOwner.connectOutbound !== 'function') {
      return Promise.reject(new Error('Configured signaling owner is missing connectOutbound()'));
    }

    const connectionPolicy = {
      maxRetries: connectOptions?.maxRetries ?? 3,
      retryDelayMs: connectOptions?.retryDelayMs ?? 600,
    };
    this.cancelConnecting();
    const attemptToken = this._createAttemptToken(peer, TRANSPORTS.LAN);
    const currentGen = attemptToken.generation;

    this._setState(COORDINATOR_STATE.CONNECTING, { peer, transport: TRANSPORTS.LAN });
    peerRegistry.setPeerConnecting(peer.deviceId);
    this.currentPeer = peer;
    this.currentTransport = TRANSPORTS.LAN;

    const attempt = this.signalingOwner
      ? this._connectLanWithSignalingOwner(peer, lanInfo, currentGen, timeoutMs, connectionPolicy)
      : this._connectLanLegacy(peer, lanInfo, currentGen, connectionPolicy);
    return this._trackPendingAttempt(peer, TRANSPORTS.LAN, attemptToken, attempt);
  }

  async _connectLanWithSignalingOwner(peer, lanInfo, currentGen, timeoutMs, connectionPolicy) {
    const owner = this.signalingOwner;
    let settled = false;
    let cancelled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      cancelled = true;
      try { owner.cancelConnect?.(); } catch (e) {}
    };
    this.pendingConnectAbort = abort;

    try {
      await owner.connectOutbound({
        host: lanInfo.host,
        port: lanInfo.port || 8089,
        maxRetries: connectionPolicy.maxRetries,
        retryDelayMs: connectionPolicy.retryDelayMs,
        timeoutMs,
      });

      if (cancelled || this.generation !== currentGen) {
        return;
      }

      settled = true;
      if (this.pendingConnectAbort === abort) this.pendingConnectAbort = null;

      const session = typeof owner.getActiveSession === 'function'
        ? owner.getActiveSession()
        : null;
      if (!session || session.isConnected === false) {
        throw new Error('Signaling owner completed LAN connect without an active session');
      }

      // Passive LAN admission requires stable identity within a short bounded
      // window. Announce it as soon as the socket exists; waiting for App UI
      // hydration/storage can otherwise make a healthy LAN socket look like an
      // unauthenticated intermittent failure on the receiving phone.
      if (this.myDeviceId && typeof owner.sendMessage === 'function') {
        const identitySent = owner.sendMessage({
          type: 'identity',
          deviceId: this.myDeviceId,
          deviceName: this.myDeviceName || 'G1 Device',
        });
        if (!identitySent) {
          throw new Error('Failed to announce stable G1 identity over LAN');
        }
      }

      this.activeSession = session;
      this.activeSessionManagedExternally = true;
      this.activeTransportAdapter = null;
      this.preferredTransport = TRANSPORTS.LAN;
      this.transitionCount = 0;
      // Heartbeat/recovery remain exclusively owned by the injected signaling
      // runtime. Starting the coordinator heartbeat here would create two
      // control-plane liveness owners for the same socket.
      this._stopHeartbeat();
      this._setState(COORDINATOR_STATE.CONNECTED, { peer, transport: TRANSPORTS.LAN });
      peerRegistry.setPeerConnected(peer.deviceId, TRANSPORTS.LAN);
      if (this.onConnected) this.onConnected(peer, TRANSPORTS.LAN);
      this._subscribeToSignalingOwnerDisconnect(owner, currentGen);

      return session;
    } catch (err) {
      if (cancelled || this.generation !== currentGen) {
        return;
      }
      if (this.pendingConnectAbort === abort) this.pendingConnectAbort = null;
      try { owner.disconnect?.(); } catch (e) {}
      if (this.generation === currentGen) {
        this._setState(COORDINATOR_STATE.ERROR, { error: err.message });
        peerRegistry.setPeerDisconnected(peer.deviceId);
      }
      throw err;
    }
  }

  connectP2pPeer(peer, timeoutMs = 30000, connectOptions = {}) {
    const reusable = this._getReusableConnection(peer, TRANSPORTS.P2P);
    if (reusable) return reusable;
    const p2pInfo = peer?.transports?.[TRANSPORTS.P2P] || peer || {};
    const deviceAddress = p2pInfo.deviceAddress || peer?.deviceAddress;
    if (!peer?.deviceId) {
      return Promise.reject(new Error('Stable peer deviceId is required for Wi-Fi Direct'));
    }
    if (!deviceAddress) {
      return Promise.reject(new Error('Wi-Fi Direct deviceAddress is missing for peer'));
    }
    if (!this.p2pAdapter || typeof this.p2pAdapter.connectPeer !== 'function') {
      return Promise.reject(new Error('Configured Wi-Fi Direct transport adapter is unavailable'));
    }
    const owner = this.signalingOwner;
    if (!owner || typeof owner.getActiveSession !== 'function') {
      return Promise.reject(new Error('Configured signaling owner is required for Wi-Fi Direct'));
    }
    if (!this.myDeviceId) {
      return Promise.reject(new Error('Local stable G1 identity is required before Wi-Fi Direct connect'));
    }

    this.cancelConnecting();
    const attemptToken = this._createAttemptToken(peer, TRANSPORTS.P2P);
    const currentGen = attemptToken.generation;
    this._setState(COORDINATOR_STATE.CONNECTING, { peer, transport: TRANSPORTS.P2P });
    peerRegistry.setPeerConnecting(peer.deviceId);
    this.currentPeer = peer;
    this.currentTransport = TRANSPORTS.P2P;

    const attempt = this._connectP2pWithOwners(peer, timeoutMs, connectOptions, currentGen);
    return this._trackPendingAttempt(peer, TRANSPORTS.P2P, attemptToken, attempt);
  }

  async _connectP2pWithOwners(peer, timeoutMs, connectOptions, currentGen) {
    const owner = this.signalingOwner;
    let settled = false;
    let cancelled = false;
    let route = null;
    const abort = () => {
      if (settled) return;
      settled = true;
      cancelled = true;
      try { owner.cancelConnect?.(); } catch (e) {}
      try {
        const disconnected = owner.disconnect?.();
        disconnected?.catch?.(() => {});
      } catch (e) {}
      try {
        const cancelledRoute = this.p2pAdapter.cancelConnect?.('Coordinator cancelled Wi-Fi Direct connect');
        cancelledRoute?.catch?.(() => {});
      } catch (e) {}
    };
    this.pendingConnectAbort = abort;

    try {
      route = await this.p2pAdapter.connectPeer(peer, {
        timeoutMs,
        incoming: connectOptions.incoming === true,
      });

      if (cancelled || this.generation !== currentGen) {
        return;
      }

      const signalingTimeoutMs = connectOptions.signalingTimeoutMs || timeoutMs;
      const port = connectOptions.port || 8089;
      if (route?.isGroupOwner) {
        if (typeof owner.acceptInbound !== 'function') {
          throw new Error('Configured signaling owner is missing acceptInbound()');
        }
        await owner.acceptInbound({ port, timeoutMs: signalingTimeoutMs });
      } else {
        if (!route?.groupOwnerAddress) {
          throw new Error('Wi-Fi Direct client route is missing group-owner address');
        }
        if (typeof owner.connectOutbound !== 'function') {
          throw new Error('Configured signaling owner is missing connectOutbound()');
        }
        await owner.connectOutbound({
          host: route.groupOwnerAddress,
          port,
          maxRetries: connectOptions.maxRetries ?? 8,
          retryDelayMs: connectOptions.retryDelayMs ?? 1200,
          timeoutMs: signalingTimeoutMs,
        });
      }

      if (cancelled || this.generation !== currentGen) {
        try { owner.disconnect?.(); } catch (e) {}
        try { await this.p2pAdapter.disconnect?.(); } catch (e) {}
        return;
      }

      const session = owner.getActiveSession();
      if (!session || session.isConnected === false) {
        throw new Error('Signaling owner completed Wi-Fi Direct connect without an active session');
      }

      const identitySent = typeof owner.sendMessage === 'function'
        ? owner.sendMessage({
            type: 'identity',
            deviceId: this.myDeviceId,
            deviceName: this.myDeviceName || 'G1 Device',
          })
        : false;
      if (!identitySent) {
        throw new Error('Failed to announce stable G1 identity over Wi-Fi Direct');
      }

      settled = true;
      if (this.pendingConnectAbort === abort) this.pendingConnectAbort = null;
      this.activeSession = session;
      this.activeSessionManagedExternally = true;
      this.activeTransportAdapter = null;
      this.preferredTransport = TRANSPORTS.P2P;
      this.transitionCount = 0;
      this._stopHeartbeat();
      this._setState(COORDINATOR_STATE.CONNECTED, {
        peer,
        transport: TRANSPORTS.P2P,
        route,
      });
      peerRegistry.setPeerConnected(peer.deviceId, TRANSPORTS.P2P);
      if (this.onConnected) this.onConnected(peer, TRANSPORTS.P2P);
      this._subscribeToSignalingOwnerDisconnect(owner, currentGen);
      return session;
    } catch (err) {
      if (cancelled || this.generation !== currentGen) {
        return;
      }
      settled = true;
      if (this.pendingConnectAbort === abort) this.pendingConnectAbort = null;
      try { owner.disconnect?.(); } catch (e) {}
      try { await this.p2pAdapter.disconnect?.(); } catch (e) {}
      if (this.generation === currentGen) {
        this._setState(COORDINATOR_STATE.ERROR, { error: err.message, transport: TRANSPORTS.P2P });
        peerRegistry.setPeerDisconnected(peer.deviceId);
      }
      throw err;
    }
  }

  connectBluetoothPeer(peer, timeoutMs = 25000, connectOptions = {}) {
    const reusable = this._getReusableConnection(peer, TRANSPORTS.BLUETOOTH);
    if (reusable) return reusable;

    const bluetoothInfo = peer?.transports?.[TRANSPORTS.BLUETOOTH] || peer || {};
    const address = bluetoothInfo.address || peer?.btAddress;
    if (!peer?.deviceId) {
      return Promise.reject(new Error('Stable peer deviceId is required for Bluetooth'));
    }
    if (!address) {
      return Promise.reject(new Error('Bluetooth address is missing for peer'));
    }
    if (!this.bluetoothAdapter) {
      return Promise.reject(new Error('Configured Bluetooth transport adapter is unavailable'));
    }

    this.cancelConnecting();
    const attemptToken = this._createAttemptToken(peer, TRANSPORTS.BLUETOOTH);
    this._setState(COORDINATOR_STATE.CONNECTING, { peer, transport: TRANSPORTS.BLUETOOTH });
    peerRegistry.setPeerConnecting(peer.deviceId);
    this.currentPeer = peer;
    this.currentTransport = TRANSPORTS.BLUETOOTH;

    const attempt = this._connectBluetoothWithAdapter(
      peer,
      address,
      timeoutMs,
      connectOptions,
      attemptToken,
    );
    return this._trackPendingAttempt(
      peer,
      TRANSPORTS.BLUETOOTH,
      attemptToken,
      attempt,
    );
  }

  async _connectBluetoothWithAdapter(peer, address, timeoutMs, connectOptions, attemptToken) {
    const adapter = this.bluetoothAdapter;
    let settled = false;
    let cancelled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      cancelled = true;
      try {
        const result = adapter.cancelConnect?.({
          attemptToken,
          reason: 'Coordinator cancelled Bluetooth connect',
        });
        result?.catch?.(() => {});
      } catch (e) {}
    };
    this.pendingConnectAbort = abort;

    try {
      const result = await adapter.connectPeer(peer, {
        ...connectOptions.adapterOptions,
        address,
        timeoutMs,
        attemptToken,
      });
      const session = result?.session || result;
      // The authenticated RFCOMM hello can replace a discovery-only
      // `bluetooth:MAC` identity with the peer's stable G1 node ID. Promote
      // that verified identity at the coordinator boundary so observers,
      // registry ownership and subsequent fallback steps never retain the
      // provisional peer after the physical socket is already authenticated.
      const connectedPeer = result?.peer?.deviceId ? result.peer : peer;

      if (cancelled || !this._isAttemptCurrent(attemptToken)) {
        try {
          await adapter.discardConnection?.(session, {
            attemptToken,
            reason: 'stale-attempt',
          });
        } catch (e) {}
        return;
      }
      if (!session || session.isConnected === false) {
        throw new Error('Bluetooth adapter completed connect without an active session');
      }

      settled = true;
      if (this.pendingConnectAbort === abort) this.pendingConnectAbort = null;
      this.activeSession = session;
      this.activeSessionManagedExternally = true;
      this.activeTransportAdapter = adapter;
      this.currentPeer = connectedPeer;
      this.preferredTransport = TRANSPORTS.BLUETOOTH;
      this.transitionCount = 0;
      this._stopHeartbeat();
      this._setState(COORDINATOR_STATE.CONNECTED, {
        peer: connectedPeer,
        transport: TRANSPORTS.BLUETOOTH,
      });
      if (connectedPeer.deviceId !== peer.deviceId) {
        peerRegistry.setPeerDisconnected(peer.deviceId);
      }
      peerRegistry.setPeerConnected(connectedPeer.deviceId, TRANSPORTS.BLUETOOTH);
      if (this.onConnected) this.onConnected(connectedPeer, TRANSPORTS.BLUETOOTH);
      this._subscribeToTransportDisconnect(adapter, session, attemptToken.generation);
      return session;
    } catch (error) {
      if (cancelled || this.generation !== attemptToken.generation) {
        return;
      }
      settled = true;
      if (this.pendingConnectAbort === abort) this.pendingConnectAbort = null;
      this.activeSession = null;
      this.activeSessionManagedExternally = false;
      this.activeTransportAdapter = null;
      this._setState(COORDINATOR_STATE.ERROR, {
        error: error?.message || String(error),
        transport: TRANSPORTS.BLUETOOTH,
      });
      peerRegistry.setPeerDisconnected(peer.deviceId);
      throw error;
    }
  }

  handoverPeer(peer, targetTransport, options = {}) {
    if (!peer?.deviceId) {
      return Promise.reject(new Error('Stable peer deviceId is required for transport handover'));
    }
    if (!Object.values(TRANSPORTS).includes(targetTransport)) {
      return Promise.reject(new Error(`Unsupported handover transport: ${targetTransport}`));
    }
    if (
      this.state !== COORDINATOR_STATE.CONNECTED ||
      !this.activeSession ||
      this.currentPeer?.deviceId !== peer.deviceId
    ) {
      return Promise.reject(new Error('A healthy active session for this peer is required for handover'));
    }

    this.preferredTransport = targetTransport;
    if (targetTransport === this.currentTransport) {
      return Promise.resolve(this.activeSession);
    }
    if (this.transitionCount >= this.maxTransportTransitions) {
      return Promise.reject(new TransportTransitionLimitError(this.maxTransportTransitions));
    }

    const handoverKey = `${peer.deviceId}:${targetTransport}`;
    if (this.pendingHandover?.key === handoverKey) {
      return this.pendingHandover.promise;
    }
    if (this.pendingHandover || this.pendingAttempt) {
      return Promise.reject(new CoordinatorConnectionBusyError(
        this.currentPeer?.deviceId || '',
        peer.deviceId,
      ));
    }

    const adapter = options.adapter || this.transportHandoverAdapters.get(targetTransport);
    const canPrepare = typeof adapter?.prepareConnection === 'function' ||
      (targetTransport === TRANSPORTS.BLUETOOTH && typeof adapter?.connectPeer === 'function');
    if (!canPrepare) {
      return Promise.reject(new Error(
        `No make-before-break adapter is configured for ${targetTransport}`,
      ));
    }

    const token = Object.freeze({
      attemptId: ++this.attemptSequence,
      peerId: peer.deviceId,
      fromTransport: this.currentTransport,
      transport: targetTransport,
      baseGeneration: this.generation,
    });
    const record = {
      key: handoverKey,
      token,
      adapter,
      baseSession: this.activeSession,
      cancelled: false,
      promise: null,
    };
    this.pendingHandover = record;
    const attempt = this._performHandover(peer, targetTransport, adapter, options, record)
      .finally(() => {
        if (this.pendingHandover === record) {
          this.pendingHandover = null;
        }
      });
    record.promise = attempt;
    return attempt;
  }

  /**
   * Replaces a provisional route identity (for example bluetooth:MAC) with
   * the stable G1 device identity announced on the already-authenticated
   * session. The physical session and generation stay untouched.
   */
  rebindConnectedPeer(peer, { expectedDeviceId = null } = {}) {
    if (!peer?.deviceId) throw new Error('Stable peer deviceId is required for identity rebind');
    if (this.state !== COORDINATOR_STATE.CONNECTED || !this.activeSession || !this.currentPeer) {
      throw new Error('A connected session is required for identity rebind');
    }
    const previous = this.currentPeer;
    if (expectedDeviceId && previous.deviceId !== expectedDeviceId) {
      throw new Error('Connected peer changed before identity rebind');
    }
    if (previous.deviceId === peer.deviceId) return this.currentPeer;

    this.currentPeer = {
      ...previous,
      ...peer,
      transports: {
        ...(previous.transports || {}),
        ...(peer.transports || {}),
      },
    };
    peerRegistry.setPeerDisconnected(previous.deviceId);
    peerRegistry.setPeerConnected(peer.deviceId, this.currentTransport);
    return this.currentPeer;
  }

  _isHandoverCurrent(record) {
    return this.pendingHandover === record &&
      !record.cancelled &&
      this.generation === record.token.baseGeneration &&
      this.state === COORDINATOR_STATE.CONNECTED &&
      this.activeSession === record.baseSession &&
      this.currentPeer?.deviceId === record.token.peerId &&
      this.currentTransport === record.token.fromTransport;
  }

  cancelHandover(reason = 'Transport handover was cancelled') {
    const record = this.pendingHandover;
    if (!record || record.cancelled) return false;
    record.cancelled = true;
    const cancel = record.adapter?.cancelPrepare || record.adapter?.cancelConnect;
    try {
      const result = cancel?.call(record.adapter, {
        attemptToken: record.token,
        reason,
      });
      result?.catch?.(() => {});
    } catch (e) {}
    return true;
  }

  async _discardHandoverCandidate(adapter, candidate, token, reason) {
    if (!candidate) return;
    const session = candidate?.session || candidate;
    try {
      if (typeof adapter?.discardConnection === 'function') {
        await adapter.discardConnection(session, { attemptToken: token, reason });
      } else if (typeof adapter?.disconnect === 'function') {
        await adapter.disconnect(session, { reason });
      }
    } catch (error) {
      console.warn('Coordinator candidate cleanup failed:', error?.message || error);
    }
  }

  async _prepareHandoverCandidate(peer, targetTransport, adapter, options, record) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
    const prepare = typeof adapter.prepareConnection === 'function'
      ? adapter.prepareConnection.bind(adapter)
      : adapter.connectPeer.bind(adapter);
    const preparePromise = Promise.resolve().then(() => prepare(peer, {
      ...options.adapterOptions,
      transport: targetTransport,
      fromTransport: record.token.fromTransport,
      timeoutMs,
      attemptToken: record.token,
      previousSession: record.baseSession,
    }));

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return preparePromise;
    }

    let timer = null;
    return new Promise((resolve, reject) => {
      let settled = false;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const cancel = adapter.cancelPrepare || adapter.cancelConnect;
        try {
          const result = cancel?.call(adapter, {
            attemptToken: record.token,
            reason: 'handover-timeout',
          });
          result?.catch?.(() => {});
        } catch (e) {}
        reject(new TransportHandoverTimeoutError(targetTransport, timeoutMs));
      }, timeoutMs);
      preparePromise.then(value => {
        if (settled) {
          this._discardHandoverCandidate(adapter, value, record.token, 'late-timeout-result');
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  _closePreviousSession(previous, reason) {
    if (previous.adapter) {
      if (typeof previous.adapter.disconnect === 'function') {
        try {
          const result = previous.adapter.disconnect(previous.session, { reason });
          result?.catch?.(() => {});
        } catch (e) {}
      } else {
        try {
          const result = previous.session?.disconnect?.() || previous.session?.destroy?.();
          result?.catch?.(() => {});
        } catch (e) {}
      }
    } else if (previous.managedExternally) {
      try {
        const result = this.signalingOwner?.disconnect?.();
        result?.catch?.(() => {});
      } catch (e) {}
    } else {
      try { previous.session?.destroy?.(); } catch (e) {}
    }

    if (previous.transport === TRANSPORTS.P2P) {
      try {
        const result = this.p2pAdapter?.disconnect?.();
        result?.catch?.(() => {});
      } catch (e) {}
    }
  }

  async _performHandover(peer, targetTransport, adapter, options, record) {
    let candidate = null;
    try {
      candidate = await this._prepareHandoverCandidate(
        peer,
        targetTransport,
        adapter,
        options,
        record,
      );
      let session = candidate?.session || candidate;
      if (!session || session.isConnected === false) {
        throw new Error(`${targetTransport} handover produced no connected candidate session`);
      }
      if (!this._isHandoverCurrent(record)) {
        await this._discardHandoverCandidate(adapter, candidate, record.token, 'stale-handover');
        return;
      }

      if (typeof adapter.commitConnection === 'function') {
        const committed = await adapter.commitConnection(candidate, {
          attemptToken: record.token,
          previousSession: record.baseSession,
        });
        session = committed?.session || committed || session;
      }
      if (!this._isHandoverCurrent(record)) {
        await this._discardHandoverCandidate(adapter, candidate, record.token, 'stale-after-commit');
        return;
      }

      const previous = {
        session: this.activeSession,
        transport: this.currentTransport,
        managedExternally: this.activeSessionManagedExternally,
        adapter: this.activeTransportAdapter,
      };
      this._stopHeartbeat();
      this._clearSignalingOwnerDisconnectSubscription();
      this._clearTransportDisconnectSubscription();

      const generation = ++this.generation;
      this.activeSession = session;
      this.activeSessionManagedExternally = true;
      this.activeTransportAdapter = adapter;
      this.currentPeer = peer;
      this.currentTransport = targetTransport;
      this.preferredTransport = targetTransport;
      this.transitionCount++;
      this._setState(COORDINATOR_STATE.CONNECTED, {
        peer,
        transport: targetTransport,
        previousTransport: previous.transport,
        handover: true,
      });
      peerRegistry.setPeerConnected(peer.deviceId, targetTransport);
      this._subscribeToTransportDisconnect(adapter, session, generation);
      try {
        this.onTransportChanged?.({
          peer,
          fromTransport: previous.transport,
          toTransport: targetTransport,
          attemptToken: record.token,
        });
      } catch (error) {
        console.warn('Coordinator transport-change observer failed:', error?.message || error);
      }

      // Commit and logical promotion have completed. Only now may the former
      // healthy session be released (make-before-break).
      this._closePreviousSession(previous, 'transport-handover');
      return session;
    } catch (error) {
      if (candidate) {
        await this._discardHandoverCandidate(adapter, candidate, record.token, 'handover-failed');
      }
      throw error;
    }
  }

  async _connectLanLegacy(peer, lanInfo, currentGen, connectionPolicy) {
    let settled = false;

    const abort = () => {
      if (settled) return;
      settled = true;
    };
    this.pendingConnectAbort = abort;

    try {
      const socket = await connectOutboundSocket({
        host: lanInfo.host,
        port: lanInfo.port || 8089,
        maxRetries: connectionPolicy.maxRetries,
        retryDelayMs: connectionPolicy.retryDelayMs,
      });

      if (settled || this.generation !== currentGen) {
        try { socket.destroy(); } catch (e) {}
        return;
      }

      settled = true;
      this.pendingConnectAbort = null;

      const session = new SignalingSession({
        isOutbound: true,
        peerInfo: peer,
      });

      this._bindSessionEvents(session, currentGen);
      session.attachSocket(socket, currentGen);
      this.activeSession = session;
      this.activeSessionManagedExternally = false;
      this.activeTransportAdapter = null;
      this.preferredTransport = TRANSPORTS.LAN;
      this.transitionCount = 0;

      this._startHeartbeat();
      this._setState(COORDINATOR_STATE.CONNECTED, { peer, transport: TRANSPORTS.LAN });
      peerRegistry.setPeerConnected(peer.deviceId, TRANSPORTS.LAN);
      if (this.onConnected) this.onConnected(peer, TRANSPORTS.LAN);

      return session;
    } catch (err) {
      if (this.generation === currentGen) {
        this.pendingConnectAbort = null;
        this._setState(COORDINATOR_STATE.ERROR, { error: err.message });
        peerRegistry.setPeerDisconnected(peer.deviceId);
      }
      throw err;
    }
  }

  _bindSessionEvents(session, generation) {
    session.onMessage = (msg) => {
      if (this.generation !== generation || this.activeSession !== session) return;

      this.lastReceivedHeartbeat = Date.now();

      if (msg && msg.type === 'ping') {
        session.sendMessage({ type: 'pong' });
        return;
      }
      if (msg && msg.type === 'pong') {
        return;
      }

      if (this.onMessage) {
        this.onMessage(msg, this.currentPeer);
      }
    };

    session.onDisconnect = () => {
      if (this.generation !== generation || this.activeSession !== session) return;
      this._handleSessionTermination({ releaseTransport: true });
    };

    session.onError = (err) => {
      if (this.generation !== generation || this.activeSession !== session) return;
      console.warn('Coordinator session error:', err?.message || err);
      if (this.onError) this.onError(err);
    };
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.lastReceivedHeartbeat = Date.now();
    this.heartbeatInterval = setInterval(() => {
      if (!this.activeSession || this.state !== COORDINATOR_STATE.CONNECTED) {
        this._stopHeartbeat();
        return;
      }
      const now = Date.now();
      if (now - this.lastReceivedHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        console.warn('[Coordinator] Heartbeat timed out, closing dead session');
        this.disconnect();
        return;
      }
      this.activeSession.sendMessage({ type: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _handleSessionTermination({ releaseTransport = false } = {}) {
    if (
      this.state === COORDINATOR_STATE.IDLE &&
      !this.activeSession &&
      !this.currentPeer &&
      !this.currentTransport
    ) {
      return false;
    }

    this._stopHeartbeat();
    this.cancelHandover('Active session terminated');
    this._clearSignalingOwnerDisconnectSubscription();
    this._clearTransportDisconnectSubscription();
    const peer = this.currentPeer;
    const transport = this.currentTransport;
    const session = this.activeSession;
    const transportAdapter = this.activeTransportAdapter;
    this.generation++;
    this.activeSession = null;
    this.activeSessionManagedExternally = false;
    this.activeTransportAdapter = null;
    this.currentPeer = null;
    this.currentTransport = null;
    this.preferredTransport = null;
    this.transitionCount = 0;
    this._setState(COORDINATOR_STATE.IDLE);

    if (peer?.deviceId) {
      peerRegistry.setPeerDisconnected(peer.deviceId);
    }
    if (releaseTransport) {
      this._releaseTransportAfterTermination(transport, session, transportAdapter);
    }
    if (this.onDisconnected) {
      this.onDisconnected(peer);
    }
    return true;
  }

  sendMessage(msgObj) {
    if (!this.activeSession || this.state !== COORDINATOR_STATE.CONNECTED) {
      return false;
    }
    if (typeof this.activeTransportAdapter?.sendMessage === 'function') {
      return this.activeTransportAdapter.sendMessage(msgObj, this.activeSession);
    }
    if (this.activeTransportAdapter) {
      return this.activeSession.sendMessage?.(msgObj) ?? false;
    }
    if (this.activeSessionManagedExternally && typeof this.signalingOwner?.sendMessage === 'function') {
      return this.signalingOwner.sendMessage(msgObj);
    }
    return this.activeSession.sendMessage?.(msgObj) ?? false;
  }

  cancelConnecting() {
    const hadPendingAttempt = Boolean(
      this.pendingAttempt ||
      this.pendingConnectAbort ||
      this.state === COORDINATOR_STATE.CONNECTING
    );
    if (this.pendingConnectAbort) {
      this.pendingConnectAbort();
      this.pendingConnectAbort = null;
    }
    this.pendingAttempt = null;
    if (hadPendingAttempt) {
      this.generation++;
    }
    if (this.state === COORDINATOR_STATE.CONNECTING) {
      const peer = this.currentPeer;
      this.currentPeer = null;
      this.currentTransport = null;
      this._setState(COORDINATOR_STATE.IDLE);
      if (peer?.deviceId) {
        peerRegistry.setPeerDisconnected(peer.deviceId);
      }
    }
    return hadPendingAttempt;
  }

  disconnect(options = {}) {
    const peerId = this.currentPeer?.deviceId || this.pendingAttempt?.token?.peerId || null;
    if (options.preserveFallback !== true) {
      try { this.fallbackEngine?.cancel?.(peerId, 'Coordinator disconnect requested'); } catch (e) {}
    }
    this.cancelHandover('Coordinator disconnect requested');
    this._stopHeartbeat();
    const session = this.activeSession;
    const managedExternally = this.activeSessionManagedExternally;
    const transport = this.currentTransport;
    const transportAdapter = this.activeTransportAdapter;
    this._clearSignalingOwnerDisconnectSubscription();
    this._clearTransportDisconnectSubscription();
    this.cancelConnecting();
    this.generation++;
    this.activeSession = null;
    this.activeSessionManagedExternally = false;
    this.activeTransportAdapter = null;
    if (transportAdapter && session) {
      if (typeof transportAdapter.disconnect === 'function') {
        try {
          const result = transportAdapter.disconnect(session, { reason: 'explicit-disconnect' });
          result?.catch?.(() => {});
        } catch (e) {}
      } else {
        try {
          const result = session.disconnect?.() || session.destroy?.();
          result?.catch?.(() => {});
        } catch (e) {}
      }
    } else if (managedExternally && session) {
      try {
        const result = this.signalingOwner?.disconnect?.();
        result?.catch?.(() => {});
      } catch (e) {}
    } else if (session) {
      try { session.destroy?.(); } catch (e) {}
    }
    this._handleSessionTermination();
    if (transport === TRANSPORTS.P2P) {
      this._releaseTransportAfterTermination(transport);
    }
  }

  getActivePeer() {
    return this.currentPeer;
  }

  getCoordinatorStatus() {
    return {
      state: this.state,
      peer: this.currentPeer,
      transport: this.currentTransport,
      preferredTransport: this.preferredTransport,
      generation: this.generation,
      pendingAttempt: this.pendingAttempt
        ? { token: this.pendingAttempt.token }
        : null,
      pendingHandover: this.pendingHandover
        ? { token: this.pendingHandover.token }
        : null,
      transitionCount: this.transitionCount,
      maxTransportTransitions: this.maxTransportTransitions,
      p2p: this.p2pAdapter?.getStatus?.() || null,
      bluetooth: this.bluetoothAdapter?.getStatus?.() || null,
      fallback: this.fallbackEngine?.getStatus?.() || null,
    };
  }
}

export const connectionCoordinator = new ConnectionCoordinator();
export default connectionCoordinator;
