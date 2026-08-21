import { SignalingSession, connectOutboundSocket } from './SignalingSession';
import { getDefaultSignalingListener } from './SignalingListener';
import { peerRegistry, PEER_STATUS, TRANSPORTS } from './PeerRegistry';

export const COORDINATOR_STATE = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  AUTHENTICATING: 'AUTHENTICATING',
  CONNECTED: 'CONNECTED',
  DISCONNECTING: 'DISCONNECTING',
  ERROR: 'ERROR',
};

export const HEARTBEAT_INTERVAL_MS = 6000;
export const HEARTBEAT_TIMEOUT_MS = 18000;

export class ConnectionCoordinator {
  constructor(options = {}) {
    this.myDeviceId = options.myDeviceId || '';
    this.myDeviceName = options.myDeviceName || 'G1 Device';
    this.state = COORDINATOR_STATE.IDLE;
    this.activeSession = null;
    this.currentPeer = null;
    this.currentTransport = null;
    this.provenIdentity = null;
    this.generation = 0;

    this.onStateChange = options.onStateChange || null;
    this.onMessage = options.onMessage || null;
    this.onConnected = options.onConnected || null;
    this.onDisconnected = options.onDisconnected || null;
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

    // Identity authentication is above the signaling route and below trusted
    // logical-session promotion. It proves possession of the key-derived user
    // identity; discovery/persistence values remain expectations only.
    this.identityAuthenticator = options.identityAuthenticator || null;

    // Wi-Fi Direct transport adapter owns only Android P2P route lifecycle:
    // discovery observations, group negotiation, bind/unbind and cleanup. It
    // never owns signaling, heartbeat, peer identity semantics or UI state.
    this.p2pAdapter = options.p2pAdapter || null;
  }

  _isConnectionStateActive() {
    return this.state === COORDINATOR_STATE.CONNECTING ||
      this.state === COORDINATOR_STATE.AUTHENTICATING ||
      this.state === COORDINATOR_STATE.CONNECTED;
  }

  setIdentity({ deviceId, deviceName }) {
    this.myDeviceId = deviceId;
    this.myDeviceName = deviceName;
    peerRegistry.setMyDeviceId(deviceId);
    try {
      this.p2pAdapter?.setIdentity?.({ deviceId, deviceName });
    } catch (e) {}
    try {
      this.identityAuthenticator?.setLocalDeviceIdentity?.({ deviceId, deviceName });
    } catch (e) {}
  }

  setSignalingOwner(owner) {
    if (owner === this.signalingOwner) return;
    if (this._isConnectionStateActive()) {
      throw new Error('Cannot replace signaling owner while a connection is active');
    }
    this._clearSignalingOwnerDisconnectSubscription();
    this.signalingOwner = owner || null;
    try {
      this.identityAuthenticator?.setSignalingOwner?.(this.signalingOwner);
    } catch (e) {}
  }

  setIdentityAuthenticator(authenticator) {
    if (authenticator === this.identityAuthenticator) return;
    if (this._isConnectionStateActive()) {
      throw new Error('Cannot replace identity authenticator while a connection is active');
    }
    try { this.identityAuthenticator?.stop?.(); } catch (e) {}
    this.identityAuthenticator = authenticator || null;
    if (this.identityAuthenticator) {
      try {
        this.identityAuthenticator.setSignalingOwner?.(this.signalingOwner);
        if (this.myDeviceId) {
          this.identityAuthenticator.setLocalDeviceIdentity?.({
            deviceId: this.myDeviceId,
            deviceName: this.myDeviceName,
          });
        }
      } catch (e) {}
    }
  }

  setP2pAdapter(adapter) {
    if (adapter === this.p2pAdapter) return;
    if (this._isConnectionStateActive()) {
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

  _setState(newState, payload = {}) {
    this.state = newState;
    if (this.onStateChange) {
      this.onStateChange(newState, payload);
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

  _releaseTransportAfterTermination(transport) {
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
    if (this.state === COORDINATOR_STATE.CONNECTING && this.currentPeer?.deviceId === remoteDevId) {
      if (this.shouldYieldToInbound(remoteDevId)) {
        console.log(`[Coordinator] Yielding outbound connect to inbound from ${remoteDevId}`);
        this.cancelConnecting();
      } else {
        console.log(`[Coordinator] Retaining outbound connect, rejecting inbound from ${remoteDevId}`);
        try { socket.destroy(); } catch (e) {}
        return false;
      }
    } else if (this.state === COORDINATOR_STATE.CONNECTED) {
      if (this.currentPeer?.deviceId === remoteDevId) {
        // Redundant incoming session from same peer
        try { socket.destroy(); } catch (e) {}
        return false;
      }
    }

    const session = new SignalingSession({
      isOutbound: false,
      peerInfo,
    });

    this._bindSessionEvents(session, ++this.generation);
    session.attachSocket(socket, this.generation);
    this.activeSession = session;
    this.activeSessionManagedExternally = false;
    this.currentPeer = peerInfo;
    this.currentTransport = peerInfo.transport || TRANSPORTS.LAN;
    this.provenIdentity = null;

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

    if (this.state === COORDINATOR_STATE.CONNECTING || this.state === COORDINATOR_STATE.AUTHENTICATING) {
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
    this.currentPeer = peer;
    this.currentTransport = transport;
    this.provenIdentity = null;

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

  async connectLanPeer(peer, timeoutMs = 8000, connectOptions = {}) {
    const lanInfo = peer.transports?.[TRANSPORTS.LAN] || peer;
    if (!lanInfo.host) {
      throw new Error('LAN host is missing for peer');
    }
    if (this.signalingOwner && typeof this.signalingOwner.connectOutbound !== 'function') {
      throw new Error('Configured signaling owner is missing connectOutbound()');
    }

    const connectionPolicy = {
      maxRetries: connectOptions?.maxRetries ?? 3,
      retryDelayMs: connectOptions?.retryDelayMs ?? 600,
    };
    const currentGen = ++this.generation;
    this.cancelConnecting();
    this.provenIdentity = null;

    this._setState(COORDINATOR_STATE.CONNECTING, { peer, transport: TRANSPORTS.LAN });
    peerRegistry.setPeerConnecting(peer.deviceId);
    this.currentPeer = peer;
    this.currentTransport = TRANSPORTS.LAN;

    if (this.signalingOwner) {
      return this._connectLanWithSignalingOwner(peer, lanInfo, currentGen, timeoutMs, connectionPolicy);
    }

    return this._connectLanLegacy(peer, lanInfo, currentGen, connectionPolicy);
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

      this.activeSession = session;
      this.activeSessionManagedExternally = true;
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
      if (this.generation === currentGen) {
        this._setState(COORDINATOR_STATE.ERROR, { error: err.message });
        peerRegistry.setPeerDisconnected(peer.deviceId);
      }
      throw err;
    }
  }

  async connectP2pPeer(peer, timeoutMs = 30000, connectOptions = {}) {
    const p2pInfo = peer?.transports?.[TRANSPORTS.P2P] || peer || {};
    const deviceAddress = p2pInfo.deviceAddress || peer?.deviceAddress;
    if (!peer?.deviceId) {
      throw new Error('Stable peer deviceId is required for Wi-Fi Direct');
    }
    if (!deviceAddress) {
      throw new Error('Wi-Fi Direct deviceAddress is missing for peer');
    }
    if (!this.p2pAdapter || typeof this.p2pAdapter.connectPeer !== 'function') {
      throw new Error('Configured Wi-Fi Direct transport adapter is unavailable');
    }
    const owner = this.signalingOwner;
    if (!owner || typeof owner.getActiveSession !== 'function') {
      throw new Error('Configured signaling owner is required for Wi-Fi Direct');
    }
    const authenticator = this.identityAuthenticator;
    if (!authenticator || typeof authenticator.authenticatePeer !== 'function') {
      throw new Error('Configured G1 identity authenticator is required for Wi-Fi Direct');
    }
    if (!this.myDeviceId) {
      throw new Error('Local stable G1 identity is required before Wi-Fi Direct connect');
    }

    const currentGen = ++this.generation;
    this.cancelConnecting();
    this.provenIdentity = null;
    this._setState(COORDINATOR_STATE.CONNECTING, { peer, transport: TRANSPORTS.P2P });
    peerRegistry.setPeerConnecting(peer.deviceId);
    this.currentPeer = peer;
    this.currentTransport = TRANSPORTS.P2P;

    const expectedIdentity = connectOptions.expectedIdentity || {
      deviceId: peer.deviceId,
      userId: peer.userId || null,
      g1Number: peer.g1Number || null,
    };

    let settled = false;
    let cancelled = false;
    let route = null;
    const abort = () => {
      if (settled) return;
      settled = true;
      cancelled = true;
      try { authenticator.cancelAuthentication?.('COORDINATOR_CANCELLED'); } catch (e) {}
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

      // A live socket is still only a route. Hold logical promotion at
      // AUTHENTICATING until the remote proves possession of the key-derived
      // UserId expected by the saved/QR/DNS-SD contact projection.
      this.activeSession = session;
      this.activeSessionManagedExternally = true;
      this._stopHeartbeat();
      this._setState(COORDINATOR_STATE.AUTHENTICATING, {
        peer,
        transport: TRANSPORTS.P2P,
        route,
      });

      const provenIdentity = await authenticator.authenticatePeer({
        expectedIdentity,
        timeoutMs: connectOptions.authTimeoutMs || 12000,
      });

      if (cancelled || this.generation !== currentGen) {
        return;
      }
      if (!provenIdentity || provenIdentity.deviceId !== peer.deviceId) {
        throw new Error('Authenticated G1 device identity does not match the requested peer');
      }

      peerRegistry.upsertPeerIdentity?.(provenIdentity);
      this.provenIdentity = provenIdentity;
      this.currentPeer = peerRegistry.getPeer(peer.deviceId) || {
        ...peer,
        userId: provenIdentity.userId || null,
        g1Number: provenIdentity.g1Number || null,
        keyFingerprint: provenIdentity.keyFingerprint || null,
        identityTrust: provenIdentity.trust || null,
        identitySource: provenIdentity.source || null,
      };

      // Legacy identity metadata remains for older App/UI projection only. It is
      // deliberately sent after cryptographic proof and is never itself treated
      // as authentication evidence.
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
      this._setState(COORDINATOR_STATE.CONNECTED, {
        peer: this.currentPeer,
        transport: TRANSPORTS.P2P,
        route,
        provenIdentity,
      });
      peerRegistry.setPeerConnected(peer.deviceId, TRANSPORTS.P2P);
      if (this.onConnected) this.onConnected(this.currentPeer, TRANSPORTS.P2P);
      this._subscribeToSignalingOwnerDisconnect(owner, currentGen);
      return session;
    } catch (err) {
      if (cancelled || this.generation !== currentGen) {
        return;
      }
      settled = true;
      if (this.pendingConnectAbort === abort) this.pendingConnectAbort = null;
      try { authenticator.cancelAuthentication?.('COORDINATOR_AUTH_FAILED'); } catch (e) {}
      try { owner.disconnect?.(); } catch (e) {}
      try { await this.p2pAdapter.disconnect?.(); } catch (e) {}
      this._clearSignalingOwnerDisconnectSubscription();
      this.activeSession = null;
      this.activeSessionManagedExternally = false;
      this.provenIdentity = null;
      if (this.generation === currentGen) {
        this._setState(COORDINATOR_STATE.ERROR, { error: err.message, transport: TRANSPORTS.P2P });
        peerRegistry.setPeerDisconnected(peer.deviceId);
      }
      throw err;
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
    this._clearSignalingOwnerDisconnectSubscription();
    const peer = this.currentPeer;
    const transport = this.currentTransport;
    this.activeSession = null;
    this.activeSessionManagedExternally = false;
    this.currentPeer = null;
    this.currentTransport = null;
    this.provenIdentity = null;
    this._setState(COORDINATOR_STATE.IDLE);

    if (peer?.deviceId) {
      peerRegistry.setPeerDisconnected(peer.deviceId);
    }
    if (releaseTransport) {
      this._releaseTransportAfterTermination(transport);
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
    if (this.activeSessionManagedExternally && typeof this.signalingOwner?.sendMessage === 'function') {
      return this.signalingOwner.sendMessage(msgObj);
    }
    return this.activeSession.sendMessage(msgObj);
  }

  cancelConnecting() {
    if (this.pendingConnectAbort) {
      this.pendingConnectAbort();
      this.pendingConnectAbort = null;
    }
    if (this.state === COORDINATOR_STATE.CONNECTING || this.state === COORDINATOR_STATE.AUTHENTICATING) {
      const peer = this.currentPeer;
      this.currentPeer = null;
      this.currentTransport = null;
      this.provenIdentity = null;
      this.activeSession = null;
      this.activeSessionManagedExternally = false;
      this._setState(COORDINATOR_STATE.IDLE);
      if (peer?.deviceId) {
        peerRegistry.setPeerDisconnected(peer.deviceId);
      }
    }
  }

  disconnect() {
    this.generation++;
    this._stopHeartbeat();
    try { this.identityAuthenticator?.cancelAuthentication?.('COORDINATOR_DISCONNECT'); } catch (e) {}
    this.cancelConnecting();
    const session = this.activeSession;
    const managedExternally = this.activeSessionManagedExternally;
    const transport = this.currentTransport;
    if (managedExternally) {
      this._clearSignalingOwnerDisconnectSubscription();
    }
    this.activeSession = null;
    this.activeSessionManagedExternally = false;
    this.provenIdentity = null;
    if (managedExternally) {
      try { this.signalingOwner?.disconnect?.(); } catch (e) {}
    } else if (session) {
      session.destroy();
    }
    this._handleSessionTermination();
    this._releaseTransportAfterTermination(transport);
  }

  getActivePeer() {
    return this.currentPeer;
  }

  getCoordinatorStatus() {
    return {
      state: this.state,
      peer: this.currentPeer,
      transport: this.currentTransport,
      provenIdentity: this.provenIdentity,
      generation: this.generation,
      p2p: this.p2pAdapter?.getStatus?.() || null,
    };
  }
}

export const connectionCoordinator = new ConnectionCoordinator();
export default connectionCoordinator;
