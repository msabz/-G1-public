import { connectionCoordinator } from './ConnectionCoordinator';

export const TRANSPORT_MODE = {
  AUTO: 'AUTO',
  LAN_ONLY: 'LAN_ONLY',
  P2P_ONLY: 'P2P_ONLY',
  BLUETOOTH_ONLY: 'BLUETOOTH_ONLY',
};

export class TransportTimeoutError extends Error {
  constructor(transport, timeoutMs) {
    super(`انتهت مهلة الاتصال عبر ${transport} بعد ${timeoutMs}ms`);
    this.name = 'TransportTimeoutError';
    this.transport = transport;
    this.timeoutMs = timeoutMs;
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
      try { if (onTimeout) onTimeout(); } catch (e) {}
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

export class TransportFallbackEngine {
  constructor(options = {}) {
    this.mode = options.mode || TRANSPORT_MODE.AUTO;
    this.lanTimeoutMs = options.lanTimeoutMs || 5000;
    this.p2pTimeoutMs = options.p2pTimeoutMs || 8000;
    this.bluetoothTimeoutMs = options.bluetoothTimeoutMs || 8000;
    // Make connection ownership explicit without changing the default live
    // behavior. The singleton remains the production default; injection gives
    // tests and the future coordinator-owned orchestrator an exact owner seam.
    this.coordinator = options.coordinator || connectionCoordinator;
  }

  setMode(mode) {
    if (Object.values(TRANSPORT_MODE).includes(mode)) {
      this.mode = mode;
    }
  }

  getMode() {
    return this.mode;
  }

  async connect(peer, handlers = {}) {
    const {
      connectP2p,
      cancelP2p,
      connectBluetooth,
      cancelBluetooth,
      onFallbackStep,
    } = handlers;
    const errors = [];

    // 1. LAN Transport (Priority 1). The coordinator owns LAN cancellation.
    const canTryLan = this.mode === TRANSPORT_MODE.AUTO || this.mode === TRANSPORT_MODE.LAN_ONLY;
    const hasLanEndpoint = peer.transports?.LAN?.host || peer.host;

    if (canTryLan && hasLanEndpoint) {
      try {
        if (onFallbackStep) onFallbackStep('LAN');
        const session = await runWithTransportTimeout(
          () => this.coordinator.connectLanPeer(peer, this.lanTimeoutMs),
          this.lanTimeoutMs,
          'LAN',
          () => this.coordinator.cancelConnecting()
        );
        return { transport: 'LAN', session };
      } catch (err) {
        console.log('[FallbackEngine] LAN connection failed, attempting next transport:', err?.message || err);
        errors.push({ transport: 'LAN', error: err });
      }
    }

    if (this.mode === TRANSPORT_MODE.LAN_ONLY) {
      throw new Error(`تعذّر الاتصال عبر الشبكة المحلية (LAN): ${errors[0]?.error?.message || 'لا يوجد عنوان'}`);
    }

    // 2. Wi-Fi Direct (P2P) (Priority 2). P2P remains independently usable;
    // this timeout only prevents AUTO orchestration from hanging forever.
    const canTryP2p = (this.mode === TRANSPORT_MODE.AUTO || this.mode === TRANSPORT_MODE.P2P_ONLY) && typeof connectP2p === 'function';
    const hasP2pEndpoint = peer.transports?.P2P?.deviceAddress || peer.deviceAddress;

    if (canTryP2p && hasP2pEndpoint) {
      try {
        if (onFallbackStep) onFallbackStep('P2P');
        const result = await runWithTransportTimeout(
          () => connectP2p(peer),
          this.p2pTimeoutMs,
          'Wi-Fi Direct',
          cancelP2p
        );
        return { transport: 'P2P', result };
      } catch (err) {
        console.log('[FallbackEngine] Wi-Fi Direct connection failed, attempting next transport:', err?.message || err);
        errors.push({ transport: 'P2P', error: err });
      }
    }

    if (this.mode === TRANSPORT_MODE.P2P_ONLY) {
      throw new Error(`تعذّر الاتصال عبر Wi-Fi Direct: ${errors[errors.length - 1]?.error?.message || 'لا يوجد جهاز/مسار صالح'}`);
    }

    // 3. Bluetooth (Priority 3)
    const canTryBt = (this.mode === TRANSPORT_MODE.AUTO || this.mode === TRANSPORT_MODE.BLUETOOTH_ONLY) && typeof connectBluetooth === 'function';
    const hasBtEndpoint = peer.transports?.BLUETOOTH?.address || peer.btAddress;

    if (canTryBt && hasBtEndpoint) {
      try {
        if (onFallbackStep) onFallbackStep('BLUETOOTH');
        const result = await runWithTransportTimeout(
          () => connectBluetooth(peer),
          this.bluetoothTimeoutMs,
          'Bluetooth',
          cancelBluetooth
        );
        return { transport: 'BLUETOOTH', result };
      } catch (err) {
        console.log('[FallbackEngine] Bluetooth connection failed:', err?.message || err);
        errors.push({ transport: 'BLUETOOTH', error: err });
      }
    }

    if (this.mode === TRANSPORT_MODE.BLUETOOTH_ONLY) {
      throw new Error(`تعذّر الاتصال عبر البلوتوث: ${errors[errors.length - 1]?.error?.message || 'لا يوجد جهاز/مسار صالح'}`);
    }

    const errorSummary = errors.map(e => `${e.transport}: ${e.error?.message || 'failed'}`).join(', ');
    throw new Error(`تعذّر الاتصال بالطرف الآخر عبر أي وسيلة اتصال متاحة (${errorSummary || 'لا توجد وسائل اتصال صالحة'})`);
  }
}

export const fallbackEngine = new TransportFallbackEngine();
export default fallbackEngine;
