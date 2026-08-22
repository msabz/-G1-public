import { connectionCoordinator } from './ConnectionCoordinator';

export const TRANSPORT_MODE = {
  AUTO: 'AUTO',
  LAN_ONLY: 'LAN_ONLY',
  P2P_ONLY: 'P2P_ONLY',
  BLUETOOTH_ONLY: 'BLUETOOTH_ONLY',
};

export const TRANSPORT_PRIORITY = Object.freeze(['LAN', 'P2P', 'BLUETOOTH']);

const MODE_TRANSPORT = {
  [TRANSPORT_MODE.LAN_ONLY]: 'LAN',
  [TRANSPORT_MODE.P2P_ONLY]: 'P2P',
  [TRANSPORT_MODE.BLUETOOTH_ONLY]: 'BLUETOOTH',
};

export class TransportTimeoutError extends Error {
  constructor(transport, timeoutMs) {
    super(`انتهت مهلة الاتصال عبر ${transport} بعد ${timeoutMs}ms`);
    this.name = 'TransportTimeoutError';
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }
}

export class TransportSelectionBusyError extends Error {
  constructor(activePeerId, requestedPeerId) {
    super(`Transport selection is already active for ${activePeerId}; cannot start ${requestedPeerId}`);
    this.name = 'TransportSelectionBusyError';
    this.activePeerId = activePeerId;
    this.requestedPeerId = requestedPeerId;
  }
}

export class TransportAttemptCancelledError extends Error {
  constructor(attemptToken, reason = 'Transport selection was cancelled') {
    super(reason);
    this.name = 'TransportAttemptCancelledError';
    this.attemptToken = attemptToken;
  }
}

export class TransportFallbackExhaustedError extends Error {
  constructor({ mode, attempts, candidates, attemptToken }) {
    const lastError = attempts[attempts.length - 1]?.error;
    const forcedTransport = MODE_TRANSPORT[mode];
    const forcedLabel = forcedTransport === 'LAN'
      ? 'الشبكة المحلية (LAN)'
      : forcedTransport === 'P2P'
        ? 'Wi-Fi Direct'
        : forcedTransport === 'BLUETOOTH'
          ? 'البلوتوث'
          : null;
    const details = attempts
      .map(item => `${item.transport}: ${item.error?.message || 'failed'}`)
      .join(', ');
    const message = forcedLabel
      ? `تعذّر الاتصال عبر ${forcedLabel}: ${lastError?.message || 'لا يوجد جهاز/مسار صالح'}`
      : `تعذّر الاتصال بالطرف الآخر عبر أي وسيلة اتصال متاحة (${details || 'لا توجد وسائل اتصال صالحة'})`;
    super(message);
    this.name = 'TransportFallbackExhaustedError';
    this.mode = mode;
    this.attempts = attempts;
    this.candidates = candidates;
    this.attemptToken = attemptToken;
  }
}

export function runWithTransportTimeout(factory, timeoutMs, transport, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve().then(factory);
  }

  let timer = null;
  let settled = false;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        const cancellation = onTimeout?.();
        // Cancellation may need native cleanup and therefore return a Promise.
        // The transport deadline must remain authoritative, but a rejected
        // fire-and-forget cleanup must still be observed to avoid an unhandled
        // rejection after fallback has already advanced to the next step.
        Promise.resolve(cancellation).catch(error => {
          console.warn(
            `[FallbackEngine] ${transport} timeout cancellation failed:`,
            error?.message || error,
          );
        });
      } catch (error) {
        console.warn(
          `[FallbackEngine] ${transport} timeout cancellation failed:`,
          error?.message || error,
        );
      }
      reject(new TransportTimeoutError(transport, timeoutMs));
    }, timeoutMs);

    Promise.resolve()
      .then(factory)
      .then(result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch(error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizeMaxAttempts(value) {
  if (!Number.isFinite(value)) return TRANSPORT_PRIORITY.length;
  return Math.max(1, Math.min(TRANSPORT_PRIORITY.length, Math.floor(value)));
}

function peerKey(peer) {
  return peer?.deviceId || peer?.id || null;
}

function hasEndpoint(peer, transport) {
  if (transport === 'LAN') {
    return Boolean(peer?.transports?.LAN?.host || peer?.host);
  }
  if (transport === 'P2P') {
    return Boolean(peer?.transports?.P2P?.deviceAddress || peer?.deviceAddress);
  }
  return Boolean(peer?.transports?.BLUETOOTH?.address || peer?.btAddress);
}

export class TransportFallbackEngine {
  constructor(options = {}) {
    this.mode = options.mode || TRANSPORT_MODE.AUTO;
    this.lanTimeoutMs = options.lanTimeoutMs || 5000;
    this.p2pTimeoutMs = options.p2pTimeoutMs || 8000;
    // Covers the native RFCOMM connect plus a first-time Android pairing prompt,
    // while remaining bounded so AUTO selection cannot stall indefinitely.
    this.bluetoothTimeoutMs = options.bluetoothTimeoutMs || 25000;
    this.maxAttempts = normalizeMaxAttempts(options.maxAttempts);

    // The engine is a deterministic policy helper. The injected coordinator is
    // the sole logical connection/session owner.
    this.coordinator = options.coordinator || connectionCoordinator;
    this.generation = 0;
    this.pendingByPeer = new Map();

    try {
      this.coordinator?.setFallbackEngine?.(this);
    } catch (error) {
      console.warn('[FallbackEngine] Could not attach coordinator policy:', error?.message || error);
    }
  }

  setMode(mode) {
    if (Object.values(TRANSPORT_MODE).includes(mode)) {
      this.mode = mode;
    }
  }

  getMode() {
    return this.mode;
  }

  setMaxAttempts(maxAttempts) {
    this.maxAttempts = normalizeMaxAttempts(maxAttempts);
  }

  _isTransportAllowed(transport) {
    return this.mode === TRANSPORT_MODE.AUTO || MODE_TRANSPORT[this.mode] === transport;
  }

  _hasConnector(transport, handlers = {}) {
    if (transport === 'LAN') {
      return typeof handlers.connectLan === 'function' ||
        typeof this.coordinator?.connectLanPeer === 'function';
    }
    if (transport === 'P2P') {
      return typeof handlers.connectP2p === 'function' ||
        typeof this.coordinator?.connectP2pPeer === 'function';
    }
    return typeof handlers.connectBluetooth === 'function' ||
      typeof this.coordinator?.connectBluetoothPeer === 'function';
  }

  /**
   * Returns a stable priority plan. Endpoint object insertion order, discovery
   * callback order and handler registration order never influence selection.
   */
  getCandidatePlan(peer, handlers = {}, options = {}) {
    const excluded = new Set(options.excludeTransports || []);
    const maximum = normalizeMaxAttempts(options.maxAttempts ?? this.maxAttempts);
    return TRANSPORT_PRIORITY.filter(transport => (
      this._isTransportAllowed(transport) &&
      !excluded.has(transport) &&
      hasEndpoint(peer, transport) &&
      this._hasConnector(transport, handlers)
    )).slice(0, maximum);
  }

  _createAttemptToken(peerId) {
    const generation = ++this.generation;
    return Object.freeze({
      generation,
      attemptId: `transport-${generation}`,
      peerId,
      mode: this.mode,
    });
  }

  _findActiveRecord() {
    return this.pendingByPeer.values().next().value || null;
  }

  _isCurrent(record) {
    return this.pendingByPeer.get(record.peerId) === record && !record.cancelled;
  }

  getStatus() {
    const record = this._findActiveRecord();
    return {
      mode: this.mode,
      generation: this.generation,
      maxAttempts: this.maxAttempts,
      pendingAttempt: record
        ? {
            token: record.token,
            transport: record.currentTransport,
            completedSteps: record.completedSteps,
          }
        : null,
    };
  }

  cancel(peerId = null, reason = 'Transport selection was cancelled') {
    const record = peerId
      ? this.pendingByPeer.get(peerId)
      : this._findActiveRecord();
    if (!record || record.cancelled) return false;

    record.cancelled = true;
    record.cancelReason = reason;
    try {
      const cancellation = record.cancelCurrent?.();
      // Explicit cancellation is intentionally synchronous for callers, but the
      // native cleanup hook may be asynchronous. Observe a rejected cleanup so
      // it cannot surface later as an unhandled rejection.
      Promise.resolve(cancellation).catch(error => {
        console.warn(
          '[FallbackEngine] explicit cancellation cleanup failed:',
          error?.message || error,
        );
      });
    } catch (error) {
      console.warn(
        '[FallbackEngine] explicit cancellation cleanup failed:',
        error?.message || error,
      );
    }
    return true;
  }

  connect(peer, handlers = {}, options = {}) {
    const id = peerKey(peer);
    if (!id) {
      return Promise.reject(new Error('Stable peer deviceId is required for transport selection'));
    }

    const duplicate = this.pendingByPeer.get(id);
    if (duplicate) return duplicate.promise;

    const active = this._findActiveRecord();
    if (active) {
      return Promise.reject(new TransportSelectionBusyError(active.peerId, id));
    }

    const record = {
      peerId: id,
      token: this._createAttemptToken(id),
      cancelled: false,
      cancelReason: null,
      cancelCurrent: null,
      currentTransport: null,
      completedSteps: 0,
      promise: null,
    };

    this.pendingByPeer.set(id, record);
    const promise = this._connectWithRecord(peer, handlers, options, record)
      .finally(() => {
        if (this.pendingByPeer.get(id) === record) {
          this.pendingByPeer.delete(id);
        }
      });
    record.promise = promise;
    return promise;
  }

  _connectorFor(transport, peer, handlers, options = {}, record = null) {
    const stepState = { active: true };
    const attemptContext = Object.freeze({
      attemptToken: record?.token || null,
      isCancelled: () => !stepState.active || (record ? !this._isCurrent(record) : false),
      throwIfCancelled: () => {
        if (!stepState.active || (record && !this._isCurrent(record))) {
          throw new TransportAttemptCancelledError(
            record?.token || null,
            record?.cancelReason || 'Transport attempt is no longer current'
          );
        }
      },
    });
    const createCancel = cancel => () => {
      stepState.active = false;
      return cancel?.();
    };
    const invalidate = () => { stepState.active = false; };
    if (transport === 'LAN') {
      const timeoutMs = options.lanTimeoutMs ?? this.lanTimeoutMs;
      const connect = typeof handlers.connectLan === 'function'
        ? () => handlers.connectLan(peer, attemptContext)
        : () => this.coordinator.connectLanPeer(peer, timeoutMs);
      return {
        connect,
        cancel: createCancel(
          handlers.cancelLan || (() => this.coordinator?.cancelConnecting?.())
        ),
        invalidate,
        timeoutMs,
        timeoutLabel: 'LAN',
      };
    }

    if (transport === 'P2P') {
      const timeoutMs = options.p2pTimeoutMs ?? this.p2pTimeoutMs;
      const connect = typeof handlers.connectP2p === 'function'
        ? () => handlers.connectP2p(peer, attemptContext)
        : () => this.coordinator.connectP2pPeer(peer, timeoutMs);
      return {
        connect,
        cancel: createCancel(
          handlers.cancelP2p || (() => this.coordinator?.cancelConnecting?.())
        ),
        invalidate,
        timeoutMs,
        timeoutLabel: 'Wi-Fi Direct',
      };
    }

    const timeoutMs = options.bluetoothTimeoutMs ?? this.bluetoothTimeoutMs;
    const connect = typeof handlers.connectBluetooth === 'function'
      ? () => handlers.connectBluetooth(peer, attemptContext)
      : () => this.coordinator.connectBluetoothPeer(peer, timeoutMs);
    return {
      connect,
      cancel: createCancel(
        handlers.cancelBluetooth || (() => this.coordinator?.cancelConnecting?.())
      ),
      invalidate,
      timeoutMs,
      timeoutLabel: 'Bluetooth',
    };
  }

  async _connectWithRecord(peer, handlers, options, record) {
    const candidates = this.getCandidatePlan(peer, handlers, options);
    const attempts = [];

    for (let index = 0; index < candidates.length; index++) {
      if (!this._isCurrent(record)) {
        throw new TransportAttemptCancelledError(record.token, record.cancelReason);
      }

      const transport = candidates[index];
      const connector = this._connectorFor(transport, peer, handlers, options, record);
      record.currentTransport = transport;
      record.cancelCurrent = connector.cancel;

      try {
        handlers.onFallbackStep?.(transport, {
          attemptToken: record.token,
          step: index + 1,
          maxSteps: candidates.length,
        });
        const result = await runWithTransportTimeout(
          connector.connect,
          connector.timeoutMs,
          connector.timeoutLabel,
          connector.cancel,
        );

        if (!this._isCurrent(record)) {
          throw new TransportAttemptCancelledError(record.token, record.cancelReason);
        }

        record.cancelCurrent = null;
        record.completedSteps = index + 1;
        return transport === 'LAN'
          ? { transport, session: result }
          : { transport, result };
      } catch (error) {
        connector.invalidate();
        if (error instanceof TransportAttemptCancelledError || !this._isCurrent(record)) {
          throw error instanceof TransportAttemptCancelledError
            ? error
            : new TransportAttemptCancelledError(record.token, record.cancelReason);
        }
        record.cancelCurrent = null;
        record.completedSteps = index + 1;
        attempts.push({ transport, error });
        console.log(
          `[FallbackEngine] ${transport} connection failed, attempting next transport:`,
          error?.message || error,
        );
      }
    }

    throw new TransportFallbackExhaustedError({
      mode: this.mode,
      attempts,
      candidates,
      attemptToken: record.token,
    });
  }
}

export const fallbackEngine = new TransportFallbackEngine();
export default fallbackEngine;
