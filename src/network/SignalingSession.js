import TcpSocket from 'react-native-tcp-socket';

export const WRITE_CHUNK_SIZE = 16 * 1024;
export const MAX_SIGNALING_BUFFER_BYTES = 64 * 1024;

function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export class SignalingSession {
  constructor(options = {}) {
    this.socket = null;
    this.generation = 0;
    this.stateHolder = { buf: '' };
    this.onMessage = options.onMessage || null;
    this.onDisconnect = options.onDisconnect || null;
    this.onError = options.onError || null;
    this.peerInfo = options.peerInfo || null;
    this.isOutbound = !!options.isOutbound;
    this.isConnected = false;
  }

  attachSocket(socket, generation = 0) {
    this.detachSocket();
    this.socket = socket;
    this.generation = generation;
    this.stateHolder = { buf: '' };
    this.isConnected = true;

    // Signaling is a long-lived control channel. Keep the TCP socket alive even
    // while chat is idle or a large file is flowing over the independent 8090
    // data channel. These calls are best-effort because test doubles and some
    // platform implementations may not expose them.
    try {
      if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(true, 5000);
    } catch (e) {}
    try {
      if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    } catch (e) {}

    this._bindSocketEvents(socket, generation);
  }

  _bindSocketEvents(socket, generation) {
    socket.on('data', data => {
      if (this.generation !== generation || this.socket !== socket) return;
      this.stateHolder.buf += data.toString();
      const parts = this.stateHolder.buf.split('\n');
      this.stateHolder.buf = parts.pop();
      if (utf8ByteLength(this.stateHolder.buf) > MAX_SIGNALING_BUFFER_BYTES) {
        this.closeOversizedSocket();
        return;
      }

      for (const p of parts) {
        if (utf8ByteLength(p) > MAX_SIGNALING_BUFFER_BYTES) {
          this.closeOversizedSocket();
          return;
        }
        if (!p.trim()) continue;
        try {
          const msg = JSON.parse(p);
          if (this.onMessage) this.onMessage(msg, this);
        } catch (e) {
          console.warn('Signaling parse error:', e?.message || e);
        }
      }
    });

    socket.on('error', err => {
      if (this.generation !== generation || this.socket !== socket) return;
      if (this.onError) this.onError(err, this);
      this._handleDisconnect(socket, generation);
    });

    socket.on('close', () => {
      if (this.generation !== generation || this.socket !== socket) return;
      this._handleDisconnect(socket, generation);
    });
  }

  closeOversizedSocket() {
    this.stateHolder.buf = '';
    this.destroy();
  }

  _handleDisconnect(socket, generation) {
    if (this.generation !== generation || this.socket !== socket) return;
    this.isConnected = false;
    this.socket = null;
    if (this.onDisconnect) this.onDisconnect(this);
  }

  sendMessage(msgObj) {
    const socket = this.socket;
    if (!socket || !this.isConnected) return false;
    const payload = JSON.stringify(msgObj) + '\n';
    try {
      if (payload.length <= WRITE_CHUNK_SIZE) {
        socket.write(payload);
      } else {
        for (let i = 0; i < payload.length; i += WRITE_CHUNK_SIZE) {
          socket.write(payload.slice(i, i + WRITE_CHUNK_SIZE));
        }
      }
      return true;
    } catch (e) {
      console.warn('SignalingSession send failed:', e?.message || e);
      this._handleDisconnect(socket, this.generation);
      return false;
    }
  }

  detachSocket() {
    this.isConnected = false;
    const sock = this.socket;
    this.socket = null;
    this.stateHolder = { buf: '' };
    return sock;
  }

  destroy() {
    this.isConnected = false;
    const sock = this.socket;
    this.socket = null;
    this.stateHolder = { buf: '' };
    if (sock) {
      try {
        sock.destroy();
      } catch (e) {}
    }
  }
}

export function connectOutboundSocket({ host, port, maxRetries = 10, retryDelayMs = 800, onAttempt }) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    let settled = false;
    let currentSocket = null;

    const tryConnect = () => {
      if (settled) return;
      attempt++;
      if (onAttempt) onAttempt(attempt);

      let attemptDone = false;
      const socket = TcpSocket.createConnection({ host, port }, () => {
        if (settled) {
          try { socket.destroy(); } catch (e) {}
          return;
        }
        settled = true;
        attemptDone = true;
        resolve(socket);
      });
      currentSocket = socket;

      const retryOrFail = error => {
        if (attemptDone || settled) return;
        attemptDone = true;
        try { socket.destroy(); } catch (e) {}
        if (attempt < maxRetries) {
          setTimeout(tryConnect, retryDelayMs);
        } else {
          settled = true;
          reject(error || new Error('تعذّر الاتصال بقناة الإشارات بعد عدة محاولات'));
        }
      };

      socket.on('error', error => {
        retryOrFail(error);
      });

      socket.on('close', () => {
        retryOrFail(new Error('أُغلق المقبس قبل اكتمال الاتصال'));
      });
    };

    tryConnect();
  });
}
