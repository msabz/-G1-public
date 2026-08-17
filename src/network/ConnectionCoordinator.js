import { SignalingSession, connectOutboundSocket } from './SignalingSession';
import { getDefaultSignalingListener } from './SignalingListener';
import { peerRegistry, PEER_STATUS } from './PeerRegistry';

export const COORDINATOR_STATE = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
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
    this.generation = 0;

    this.onStateChange = options.onStateChange || null;
    this.onMessage = options.onMessage || null;
    this.onConnected = options.onConnected || null;
    this.onDisconnected = options.onDisconnected || null;
    this.onError = options.onError || null;

    this.heartbeatInterval = null;
    this.lastReceivedHeartbeat = 0;
    this.pendingConnectAbort = null;
  }

  setIdentity({ deviceId, deviceName }) {
    this.myDeviceId = deviceId;
    this.myDeviceName = deviceName;
    peerRegistry.setMyDeviceId(deviceId);
  }

  _setState(newState, payload = {}) {
    this.state = newState;
    if (this.onStateChange) {
      this.onStateChange(newState, payload);
    }
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
    this.currentPeer = peerInfo;
    this.currentTransport = peerInfo.transport || 'LAN';

    this._startHeartbeat();
    this._setState(COORDINATOR_STATE.CONNECTED, { peer: peerInfo, transport: this.currentTransport });
    if (remoteDevId) {
      peerRegistry.setPeerConnected(remoteDevId, this.currentTransport);
    }
    if (this.onConnected) this.onConnected(peerInfo, this.currentTransport);

    return true;
  }

  async connectLanPeer(peer, timeoutMs = 8000) {
    const lanInfo = peer.transports?.LAN || peer;
    if (!lanInfo.host) {
      throw new Error('LAN host is missing for peer');
    }

    const currentGen = ++this.generation;
    this.cancelConnecting();

    this._setState(COORDINATOR_STATE.CONNECTING, { peer, transport: 'LAN' });
    peerRegistry.setPeerConnecting(peer.deviceId);
    this.currentPeer = peer;
    this.currentTransport = 'LAN';

    let settled = false;
    let connectPromise = null;

    const abort = () => {
      if (settled) return;
      settled = true;
    };
    this.pendingConnectAbort = abort;

    try {
      const socket = await connectOutboundSocket({
        host: lanInfo.host,
        port: lanInfo.port || 8089,
        maxRetries: 3,
        retryDelayMs: 600,
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

      this._startHeartbeat();
      this._setState(COORDINATOR_STATE.CONNECTED, { peer, transport: 'LAN' });
      peerRegistry.setPeerConnected(peer.deviceId, 'LAN');
      if (this.onConnected) this.onConnected(peer, 'LAN');

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
      this._handleSessionTermination();
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

  _handleSessionTermination() {
    this._stopHeartbeat();
    const peer = this.currentPeer;
    this.activeSession = null;
    this.currentPeer = null;
    this.currentTransport = null;
    this._setState(COORDINATOR_STATE.IDLE);

    if (peer?.deviceId) {
      peerRegistry.setPeerDisconnected(peer.deviceId);
    }
    if (this.onDisconnected) {
      this.onDisconnected(peer);
    }
  }

  sendMessage(msgObj) {
    if (!this.activeSession || this.state !== COORDINATOR_STATE.CONNECTED) {
      return false;
    }
    return this.activeSession.sendMessage(msgObj);
  }

  cancelConnecting() {
    if (this.pendingConnectAbort) {
      this.pendingConnectAbort();
      this.pendingConnectAbort = null;
    }
    if (this.state === COORDINATOR_STATE.CONNECTING) {
      const peer = this.currentPeer;
      this._setState(COORDINATOR_STATE.IDLE);
      if (peer?.deviceId) {
        peerRegistry.setPeerDisconnected(peer.deviceId);
      }
    }
  }

  disconnect() {
    this.generation++;
    this._stopHeartbeat();
    this.cancelConnecting();
    const session = this.activeSession;
    this.activeSession = null;
    if (session) {
      session.destroy();
    }
    this._handleSessionTermination();
  }

  getActivePeer() {
    return this.currentPeer;
  }

  getCoordinatorStatus() {
    return {
      state: this.state,
      peer: this.currentPeer,
      transport: this.currentTransport,
      generation: this.generation,
    };
  }
}

export const connectionCoordinator = new ConnectionCoordinator();
export default connectionCoordinator;
