import TcpSocket from 'react-native-tcp-socket';

export const DEFAULT_SIGNALING_PORT = 8089;
export const MAX_PENDING_CONNECTIONS = 5;
export const PENDING_HANDSHAKE_TIMEOUT_MS = 5000;

export class SignalingListener {
  constructor(options = {}) {
    this.port = options.port || DEFAULT_SIGNALING_PORT;
    this.host = options.host || '0.0.0.0';
    this.onConnection = options.onConnection || null;
    this.onError = options.onError || null;
    this.server = null;
    this.isListening = false;
    this.generation = 0;
    this.pendingSockets = new Set();
    this.pendingTimers = new Map();
  }

  start(port = this.port) {
    this.port = port;
    if (this.isListening && this.server) {
      return Promise.resolve(this.port);
    }

    return new Promise((resolve, reject) => {
      const currentGen = ++this.generation;
      let settled = false;

      this._cleanupPending();

      try {
        const serverInst = TcpSocket.createServer(socket => {
          if (this.generation !== currentGen || !this.isListening) {
            try { socket.destroy(); } catch (e) {}
            return;
          }
          this._handleIncomingRawSocket(socket, currentGen);
        });

        serverInst.listen({ port: this.port, host: this.host }, () => {
          if (this.generation !== currentGen) {
            try { serverInst.close(); } catch (e) {}
            return;
          }
          this.server = serverInst;
          this.isListening = true;
          settled = true;
          resolve(this.port);
        });

        serverInst.on('error', err => {
          if (!settled) {
            settled = true;
            this.isListening = false;
            this.server = null;
            reject(err);
          } else {
            console.warn('SignalingListener server error:', err?.message || err);
            if (this.onError) this.onError(err);
          }
        });
      } catch (err) {
        settled = true;
        reject(err);
      }
    });
  }

  _handleIncomingRawSocket(socket, generation) {
    if (this.pendingSockets.size >= MAX_PENDING_CONNECTIONS) {
      console.warn('SignalingListener: Max pending connections reached, rejecting incoming socket');
      try { socket.destroy(); } catch (e) {}
      return;
    }

    this.pendingSockets.add(socket);

    const timer = setTimeout(() => {
      if (this.pendingSockets.has(socket)) {
        this.pendingSockets.delete(socket);
        this.pendingTimers.delete(socket);
        try { socket.destroy(); } catch (e) {}
      }
    }, PENDING_HANDSHAKE_TIMEOUT_MS);

    this.pendingTimers.set(socket, timer);

    const cleanupSocket = () => {
      if (this.pendingTimers.has(socket)) {
        clearTimeout(this.pendingTimers.get(socket));
        this.pendingTimers.delete(socket);
      }
      this.pendingSockets.delete(socket);
    };

    if (typeof socket.once === 'function') {
      socket.once('close', cleanupSocket);
      socket.once('error', cleanupSocket);
    } else if (typeof socket.on === 'function') {
      socket.on('close', cleanupSocket);
      socket.on('error', cleanupSocket);
    }

    if (this.onConnection) {
      this.onConnection(socket, () => {
        // Handshake verified/promoted callback
        cleanupSocket();
        if (typeof socket.removeListener === 'function') {
          socket.removeListener('close', cleanupSocket);
          socket.removeListener('error', cleanupSocket);
        }
      });
    }
  }

  _cleanupPending() {
    for (const [socket, timer] of this.pendingTimers.entries()) {
      clearTimeout(timer);
      try { socket.destroy(); } catch (e) {}
    }
    this.pendingTimers.clear();
    this.pendingSockets.clear();
  }

  stop() {
    this.generation++;
    this.isListening = false;
    this._cleanupPending();
    const serverInst = this.server;
    this.server = null;
    if (serverInst) {
      try {
        serverInst.close();
      } catch (e) {}
    }
  }

  getPort() {
    return this.port;
  }

  getStatus() {
    return {
      isListening: this.isListening,
      port: this.port,
      pendingCount: this.pendingSockets.size,
    };
  }
}

let defaultListenerInstance = null;

export function getDefaultSignalingListener() {
  if (!defaultListenerInstance) {
    defaultListenerInstance = new SignalingListener();
  }
  return defaultListenerInstance;
}
