import { NativeModules } from 'react-native';
import { SignalingSession, connectOutboundSocket, MAX_SIGNALING_BUFFER_BYTES } from '../network/SignalingSession';
import { getDefaultSignalingListener, DEFAULT_SIGNALING_PORT } from '../network/SignalingListener';

export { MAX_SIGNALING_BUFFER_BYTES, DEFAULT_SIGNALING_PORT };
export const SIGNALING_HEARTBEAT_INTERVAL_MS = 6000;
export const SIGNALING_HEARTBEAT_TIMEOUT_MS = 18000;
export const SIGNALING_RECOVERY_GRACE_MS = 4000;
export const PASSIVE_INBOUND_IDENTITY_TIMEOUT_MS = 5000;

let activeSession = null;
let onMessageCallback = null;
let onDisconnectCallback = null;
let clientWaitTimer = null;
let clientWaitReject = null;
let onClientConnectedCallback = null;
let clientConnectedPending = false;
let abortCurrentOperation = null;
let isExplicitServerMode = false;
let nextSocketId = 1;
let heartbeatTimer = null;
let lastInboundActivityAt = 0;
let recoveryTimer = null;
let recoveryGeneration = 0;
let recoveryInProgress = false;
let recoveryExpectedInboundPeerAddress = null;
let recoveryInboundAdmissionSnapshot = null;
let gracefulDisconnectPending = false;
let passiveInboundAdmissionHandler = null;
const messageObservers = new Set();
const disconnectObservers = new Set();

function socketId(socket) {
  if (!socket) return 'none';
  if (!socket.__g1SocketId) socket.__g1SocketId = `sock-${nextSocketId++}`;
  return socket.__g1SocketId;
}

function logSocket(event, socket, details = '') {
  const suffix = details ? ` ${details}` : '';
  console.log(`[G1/SIGNAL][${socketId(socket)}] ${event}${suffix}`);
}

function normalizePeerAddress(value) {
  if (!value || typeof value !== 'string') return null;
  let address = value.trim();
  if (!address) return null;
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  return address || null;
}

export function isSameSignalingEndpoint(left, right) {
  const a = normalizePeerAddress(left);
  const b = normalizePeerAddress(right);
  return !!(a && b && a === b);
}

function notifyMessageObservers(msg) {
  messageObservers.forEach(observer => {
    try { observer(msg); } catch (error) {
      console.warn('[G1/SIGNAL] message observer failed:', error?.message || error);
    }
  });
}

function notifyDisconnectObservers(details) {
  disconnectObservers.forEach(observer => {
    try { observer(details); } catch (error) {
      console.warn('[G1/SIGNAL] disconnect observer failed:', error?.message || error);
    }
  });
}

function callService(method, ...args) {
  try {
    const fn = NativeModules?.ServiceModule?.[method];
    if (typeof fn !== 'function') return;
    const result = fn(...args);
    if (result?.catch) result.catch(() => {});
  } catch (e) {}
}

function setAvailabilityStatus(status = 'جاهز لاستقبال الأجهزة القريبة') {
  callService('startAvailabilityService', status);
}

function setActiveServiceStatus(status = 'متصل — G1 يعمل في الخلفية') {
  callService('startConnectionService', status);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  lastInboundActivityAt = 0;
}

function clearPassiveInboundIdentityTimer(session) {
  if (!session?.passiveAdmissionTimer) return;
  clearTimeout(session.passiveAdmissionTimer);
  session.passiveAdmissionTimer = null;
}

function terminateUnadmittedPassiveSession(session, reason = 'admission-rejected') {
  if (!session) return false;
  clearPassiveInboundIdentityTimer(session);
  session.passiveAdmissionRejected = true;

  const socket = session.socket;
  if (activeSession === session) {
    stopHeartbeat();
    activeSession = null;
  }

  logSocket('PASSIVE_INBOUND_REJECTED', socket, `reason=${reason}`);
  try { session.destroy(); } catch (e) {}
  setAvailabilityStatus();
  return true;
}

function startPassiveInboundIdentityTimer(session) {
  clearPassiveInboundIdentityTimer(session);
  if (!session?.passiveAdmissionRequired || session.passiveAdmissionAccepted) return;

  session.passiveAdmissionTimer = setTimeout(() => {
    session.passiveAdmissionTimer = null;
    if (
      activeSession !== session ||
      !session.isConnected ||
      !session.passiveAdmissionRequired ||
      session.passiveAdmissionAccepted
    ) {
      return;
    }
    terminateUnadmittedPassiveSession(session, 'identity-timeout');
  }, PASSIVE_INBOUND_IDENTITY_TIMEOUT_MS);
}

function dispatchApplicationMessage(msg) {
  notifyMessageObservers(msg);
  if (onMessageCallback) onMessageCallback(msg);
}

function handlePassiveInboundPreAdmissionMessage(session, msg) {
  if (!session?.passiveAdmissionRequired || session.passiveAdmissionAccepted) return false;

  // Every G1 session announces its local route immediately after activation.
  // This metadata is useful only after identity is known, so consume it here
  // rather than treating it as proof of identity or leaking it to app runtimes.
  if (msg?.type === 'my-ip') {
    logSocket('PASSIVE_ROUTE_METADATA_IGNORED', session.socket, `ip=${normalizePeerAddress(msg.ip) || 'unknown'}`);
    return true;
  }

  if (msg?.type !== 'identity' || !msg.deviceId) {
    terminateUnadmittedPassiveSession(session, 'identity-required');
    return true;
  }

  const peerAddress = normalizePeerAddress(session.socket?.remoteAddress || session.peerInfo?.host || null);
  let decision = null;
  try {
    decision = passiveInboundAdmissionHandler?.({
      message: msg,
      peerAddress,
      session,
    }) || null;
  } catch (error) {
    console.warn('[G1/SIGNAL] passive inbound admission handler failed:', error?.message || error);
    decision = { accepted: false, reason: 'validator-error' };
  }

  if (decision?.then && typeof decision.then === 'function') {
    terminateUnadmittedPassiveSession(session, 'async-validator-not-supported');
    return true;
  }

  if (decision?.accepted !== true) {
    terminateUnadmittedPassiveSession(session, decision?.reason || 'identity-rejected');
    return true;
  }

  session.passiveAdmissionAccepted = true;
  session.passiveAdmissionDetails = decision;
  clearPassiveInboundIdentityTimer(session);
  logSocket(
    'PASSIVE_INBOUND_ADMITTED',
    session.socket,
    `peer=${decision.peerId || msg.deviceId} transport=${decision.transport || 'LAN'}`
  );
  setActiveServiceStatus('متصل عبر الشبكة المحلية');

  // Mark the session admitted before dispatching identity. If several frames
  // arrived in one TCP read, following app frames are now safe to dispatch.
  dispatchApplicationMessage(msg);
  return true;
}

function cancelPendingRecovery() {
  recoveryGeneration += 1;
  recoveryInProgress = false;
  recoveryExpectedInboundPeerAddress = null;
  recoveryInboundAdmissionSnapshot = null;
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
}

function setupSessionEvents(session) {
  session.onMessage = (msg) => {
    if (activeSession !== session || !session.isConnected || session.passiveAdmissionRejected) return;
    lastInboundActivityAt = Date.now();

    // Heartbeat frames belong to the signaling control plane. They must never
    // leak upward into chat/RTC application message handlers.
    if (msg?.type === 'ping') {
      logSocket('PING_RECEIVED', session.socket, `ts=${msg.ts || ''}`);
      const pong = { type: 'pong', ts: msg.ts || Date.now() };
      if (session.sendMessage(pong)) {
        logSocket('PONG_SENT', session.socket, `ts=${pong.ts}`);
      }
      return;
    }

    if (msg?.type === 'pong') {
      logSocket('PONG_RECEIVED', session.socket, `ts=${msg.ts || ''}`);
      return;
    }

    if (handlePassiveInboundPreAdmissionMessage(session, msg)) return;
    dispatchApplicationMessage(msg);
  };

  session.onDisconnect = () => {
    if (activeSession === session) {
      const direction = session.isOutbound ? 'outbound' : 'inbound';
      logSocket('SESSION_DISCONNECTED', session.socket, `direction=${direction}`);

      if (session.passiveAdmissionRequired && !session.passiveAdmissionAccepted) {
        terminateUnadmittedPassiveSession(session, 'socket-disconnect-before-identity');
        return;
      }

      // disconnect-request / disconnect-ack are deliberate terminal control
      // frames. Physical logs showed that treating the peer close that follows
      // as a transient failure could redial a fresh socket only for App cleanup
      // to destroy it ~180 ms later. Suppress recovery while graceful teardown
      // is pending; App/coordinator remains the owner of the final logical reset.
      if (gracefulDisconnectPending) {
        gracefulDisconnectPending = false;
        clearPassiveInboundIdentityTimer(session);
        stopHeartbeat();
        activeSession = null;
        cancelPendingRecovery();
        logSocket('RECOVERY_SUPPRESSED', session.socket, 'reason=graceful-disconnect');
        setAvailabilityStatus();
        return;
      }

      beginTransientRecovery(session, 'socket-disconnect');
    }
  };

  session.onError = (err) => {
    console.warn(`[G1/SIGNAL][${socketId(session.socket)}] SOCKET_ERROR`, err?.code || '', err?.message || err);
  };
}

async function resolveLocalRouteAddress(session) {
  const socketAddress = normalizePeerAddress(session?.socket?.localAddress);
  if (socketAddress) return socketAddress;
  try {
    const nativeAddress = await NativeModules?.DirectConnectionModule?.getLocalIpAddress?.();
    return normalizePeerAddress(nativeAddress);
  } catch (e) {
    return null;
  }
}

async function announceLocalRoute(session) {
  if (!session?.isConnected || !session.socket) return;
  const localAddress = await resolveLocalRouteAddress(session);
  if (activeSession !== session || !session.isConnected) return;
  if (!localAddress) {
    logSocket('ROUTE_ANNOUNCE_SKIPPED', session.socket, 'reason=no-local-address');
    return;
  }
  const sent = session.sendMessage({ type: 'my-ip', ip: localAddress });
  logSocket(sent ? 'ROUTE_ANNOUNCED' : 'ROUTE_ANNOUNCE_FAILED', session.socket, `ip=${localAddress}`);
}

function activateSession(session, socket, direction, reason = 'connect') {
  cancelPendingRecovery();
  gracefulDisconnectPending = false;
  activeSession = session;
  lastInboundActivityAt = Date.now();
  logSocket('SESSION_ACTIVE', socket, `direction=${direction} reason=${reason}`);
  setActiveServiceStatus(
    session.passiveAdmissionRequired && !session.passiveAdmissionAccepted
      ? 'جاري التحقق من جهاز قريب'
      : reason === 'transient-recovery'
        ? 'تمت استعادة الاتصال'
        : 'متصل — G1 يعمل في الخلفية'
  );
  startHeartbeat(session);
  announceLocalRoute(session).catch(() => {});
}

function beginTransientRecovery(session, reason) {
  if (activeSession !== session) return;

  const previousSocket = session.socket;
  const peerInfo = session.peerInfo ? { ...session.peerInfo } : null;
  const wasOutbound = !!session.isOutbound;

  clearPassiveInboundIdentityTimer(session);
  stopHeartbeat();
  activeSession = null;
  const token = ++recoveryGeneration;
  recoveryInProgress = true;
  recoveryExpectedInboundPeerAddress = wasOutbound
    ? null
    : normalizePeerAddress(previousSocket?.remoteAddress || peerInfo?.host || peerInfo?.ip || null);
  recoveryInboundAdmissionSnapshot = wasOutbound
    ? null
    : {
        required: session.passiveAdmissionRequired === true,
        accepted: session.passiveAdmissionAccepted === true,
        details: session.passiveAdmissionDetails || null,
      };
  callService('updateConnectionStatus', 'انقطع المسار مؤقتاً — جاري الاستعادة');

  logSocket(
    'RECOVERY_WINDOW_OPEN',
    previousSocket,
    `reason=${reason} direction=${wasOutbound ? 'outbound' : 'inbound'} graceMs=${SIGNALING_RECOVERY_GRACE_MS}`
  );

  if (wasOutbound && peerInfo?.host) {
    const host = peerInfo.host;
    const port = peerInfo.port || DEFAULT_SIGNALING_PORT;
    logSocket('RECOVERY_REDIAL_START', previousSocket, `host=${host} port=${port}`);

    connectOutboundSocket({ host, port, maxRetries: 3, retryDelayMs: 600 })
      .then(socket => {
        socketId(socket);
        if (token !== recoveryGeneration || (activeSession && activeSession.isConnected)) {
          logSocket('RECOVERY_REDIAL_REJECTED', socket, 'reason=newer-session-won');
          try { socket.destroy(); } catch (e) {}
          return;
        }

        const replacement = new SignalingSession({ isOutbound: true, peerInfo });
        setupSessionEvents(replacement);
        replacement.attachSocket(socket);
        activateSession(replacement, socket, 'outbound', 'transient-recovery');
        logSocket('RECOVERY_SUCCESS', socket, `host=${host} port=${port}`);
      })
      .catch(err => {
        if (token !== recoveryGeneration) return;
        console.warn(`[G1/SIGNAL][none] RECOVERY_REDIAL_FAILED`, err?.message || err);
      });
  }

  recoveryTimer = setTimeout(() => {
    if (token !== recoveryGeneration) return;
    recoveryTimer = null;
    recoveryInProgress = false;
    recoveryExpectedInboundPeerAddress = null;
    recoveryInboundAdmissionSnapshot = null;
    if (activeSession && activeSession.isConnected) return;
    console.warn(`[G1/SIGNAL][none] RECOVERY_EXHAUSTED reason=${reason}`);
    setAvailabilityStatus();
    notifyDisconnectObservers({ reason, recovered: false });
    if (onDisconnectCallback) onDisconnectCallback();
  }, SIGNALING_RECOVERY_GRACE_MS);
}

function startHeartbeat(session) {
  stopHeartbeat();
  if (!session || !session.isConnected) return;

  lastInboundActivityAt = Date.now();
  heartbeatTimer = setInterval(() => {
    if (activeSession !== session || !session.isConnected || !session.socket) {
      stopHeartbeat();
      return;
    }

    const silentFor = Date.now() - lastInboundActivityAt;
    if (silentFor > SIGNALING_HEARTBEAT_TIMEOUT_MS) {
      const socket = session.socket;
      logSocket('HEARTBEAT_TIMEOUT', socket, `silentMs=${silentFor}`);
      beginTransientRecovery(session, 'heartbeat-timeout');
      session.destroy();
      return;
    }

    const ts = Date.now();
    logSocket('PING', session.socket, `ts=${ts}`);
    const sent = session.sendMessage({ type: 'ping', ts });
    if (!sent) logSocket('PING_FAILED', session.socket);
  }, SIGNALING_HEARTBEAT_INTERVAL_MS);
}

export function setOnMessage(cb) {
  onMessageCallback = cb;
  if (activeSession) setupSessionEvents(activeSession);
}

export function setOnDisconnect(cb) {
  onDisconnectCallback = cb;
  if (activeSession) setupSessionEvents(activeSession);
}

export function setPassiveInboundAdmissionHandler(handler) {
  passiveInboundAdmissionHandler = typeof handler === 'function' ? handler : null;
}

export function addSignalingMessageObserver(observer) {
  if (typeof observer !== 'function') return { remove() {} };
  messageObservers.add(observer);
  return { remove: () => messageObservers.delete(observer) };
}

export function addSignalingDisconnectObserver(observer) {
  if (typeof observer !== 'function') return { remove() {} };
  disconnectObservers.add(observer);
  return { remove: () => disconnectObservers.delete(observer) };
}

export function getActiveSession() {
  return activeSession;
}

export function getActivePeerAddress() {
  const session = activeSession;
  if (!session || !session.isConnected) return null;
  const socketAddress = normalizePeerAddress(session.socket?.remoteAddress);
  if (socketAddress) return socketAddress;
  return normalizePeerAddress(session.peerInfo?.host || session.peerInfo?.ip || null);
}

export function getSignalingHealth() {
  return {
    connected: !!(activeSession && activeSession.isConnected),
    peerAddress: getActivePeerAddress(),
    direction: activeSession
      ? (activeSession.isOutbound ? 'outbound' : 'inbound')
      : null,
    passiveAdmissionAccepted: activeSession?.passiveAdmissionAccepted === true,
    passiveAdmissionRequired: activeSession?.passiveAdmissionRequired === true,
    lastInboundActivityAt,
    heartbeatRunning: !!heartbeatTimer,
    recoveryInProgress,
    gracefulDisconnectPending,
  };
}

export function getDefaultListener() {
  return getDefaultSignalingListener();
}

export function waitForClientConnection(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (clientConnectedPending) {
      clientConnectedPending = false;
      resolve();
      return;
    }
    if (clientWaitTimer) clearTimeout(clientWaitTimer);
    clientWaitTimer = setTimeout(() => {
      clientWaitTimer = null;
      clientWaitReject = null;
      onClientConnectedCallback = null;
      reject(new Error('انتهت مهلة انتظار اتصال الطرف الآخر'));
    }, timeoutMs);
    clientWaitReject = reject;
    onClientConnectedCallback = () => {
      if (clientWaitTimer) clearTimeout(clientWaitTimer);
      clientWaitTimer = null;
      clientWaitReject = null;
      resolve();
    };
  });
}

function notifyClientConnected() {
  if (onClientConnectedCallback) {
    const cb = onClientConnectedCallback;
    onClientConnectedCallback = null;
    cb();
  } else {
    clientConnectedPending = true;
  }
}

function inspectDuplicatePassiveInbound(socket, promote, source) {
  const activeSocket = activeSession?.socket || null;
  logSocket('DUPLICATE_INBOUND_PENDING', socket, `active=${socketId(activeSocket)}`);

  let settled = false;
  let buffer = '';
  const bufferedMessages = [];
  let timer = null;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try { socket.removeListener?.('data', onData); } catch (e) {}
    try { socket.removeListener?.('close', onTerminal); } catch (e) {}
    try { socket.removeListener?.('error', onTerminal); } catch (e) {}
  };

  const reject = reason => {
    if (settled) return false;
    settled = true;
    cleanup();
    logSocket('DUPLICATE_INBOUND_REJECTED', socket, `active=${socketId(activeSocket)} reason=${reason}`);
    try { socket.destroy(); } catch (e) {}
    return false;
  };

  const promoteInboundWinner = decision => {
    if (settled) return false;
    settled = true;
    cleanup();

    const previous = activeSession;
    if (previous && previous.isConnected && previous.isOutbound) {
      clearPassiveInboundIdentityTimer(previous);
      stopHeartbeat();
      activeSession = null;
      try { previous.destroy(); } catch (e) {}
    }

    logSocket(
      'DUPLICATE_INBOUND_SELECTED',
      socket,
      `peer=${decision?.peerId || 'unknown'} previous=${socketId(activeSocket)}`
    );
    return attachIncomingSession(socket, promote, source, {
      skipAcceptedLog: true,
      skipDuplicateCheck: true,
      preMessages: bufferedMessages,
    });
  };

  const validateIdentity = msg => {
    const peerAddress = normalizePeerAddress(socket?.remoteAddress);
    let decision = null;
    try {
      decision = passiveInboundAdmissionHandler?.({
        message: msg,
        peerAddress,
        session: null,
        validateOnly: true,
      }) || null;
    } catch (error) {
      console.warn('[G1/SIGNAL] duplicate inbound validation failed:', error?.message || error);
      reject('validator-error');
      return false;
    }

    if (decision?.then && typeof decision.then === 'function') {
      reject('async-validator-not-supported');
      return false;
    }
    if (decision?.accepted !== true) {
      reject(decision?.reason || 'identity-rejected');
      return false;
    }
    if (decision?.preferInbound !== true) {
      reject('stable-id-retains-outbound');
      return false;
    }

    return promoteInboundWinner(decision);
  };

  const onData = data => {
    if (settled) return;
    buffer += data.toString();
    if (buffer.length > MAX_SIGNALING_BUFFER_BYTES) {
      reject('candidate-buffer-too-large');
      return;
    }

    const parts = buffer.split('\n');
    buffer = parts.pop();
    const parsedMessages = [];
    for (const part of parts) {
      if (!part.trim()) continue;
      try {
        parsedMessages.push(JSON.parse(part));
      } catch (error) {
        reject('candidate-parse-error');
        return;
      }
    }

    for (let index = 0; index < parsedMessages.length; index++) {
      if (settled) return;
      const msg = parsedMessages[index];
      if (msg?.type === 'my-ip') {
        bufferedMessages.push(msg);
        continue;
      }
      if (msg?.type !== 'identity' || !msg.deviceId) {
        reject('identity-required');
        return;
      }

      // Preserve every complete frame already coalesced in this TCP read. The
      // real SignalingSession is attached only after the stable-id decision, so
      // bytes already consumed by this provisional parser cannot be re-read from
      // the socket. Replay identity and any trailing application frames in order.
      bufferedMessages.push(msg, ...parsedMessages.slice(index + 1));
      validateIdentity(msg);
      return;
    }
  };

  const onTerminal = () => {
    if (settled) return;
    settled = true;
    cleanup();
  };

  socket.on('data', onData);
  socket.on('close', onTerminal);
  socket.on('error', onTerminal);
  timer = setTimeout(() => reject('identity-timeout'), PASSIVE_INBOUND_IDENTITY_TIMEOUT_MS);
  return true;
}

function attachIncomingSession(socket, promote, source, options = {}) {
  if (!options.skipAcceptedLog) {
    logSocket('INBOUND_ACCEPTED', socket, `source=${source}`);
  }

  if (!options.skipDuplicateCheck && activeSession && activeSession.isConnected && activeSession.socket) {
    // A simultaneous known-LAN connect must not be resolved by packet/socket
    // arrival order. If the existing session is outbound, hold the inbound raw
    // socket only long enough to read/validate stable identity, then apply the
    // coordinator's deterministic deviceId tie-break. Other duplicate cases
    // retain the existing healthy session as before.
    if (
      source === 'persistent' &&
      activeSession.isOutbound &&
      !isExplicitServerMode &&
      typeof passiveInboundAdmissionHandler === 'function'
    ) {
      return inspectDuplicatePassiveInbound(socket, promote, source);
    }

    logSocket('DUPLICATE_INBOUND_REJECTED', socket, `active=${socketId(activeSession.socket)}`);
    try { socket.destroy(); } catch (e) {}
    return false;
  }

  if (recoveryInProgress && recoveryExpectedInboundPeerAddress) {
    const incomingAddress = normalizePeerAddress(socket?.remoteAddress);
    if (!isSameSignalingEndpoint(incomingAddress, recoveryExpectedInboundPeerAddress)) {
      logSocket(
        'RECOVERY_INBOUND_REJECTED',
        socket,
        `expected=${recoveryExpectedInboundPeerAddress || 'unknown'} actual=${incomingAddress || 'unknown'}`
      );
      try { socket.destroy(); } catch (e) {}
      return false;
    }
  }

  const wasRecovering = recoveryInProgress;
  const inheritedAdmission = wasRecovering ? recoveryInboundAdmissionSnapshot : null;
  const passiveAdmissionRequired =
    source === 'persistent' &&
    !isExplicitServerMode &&
    typeof passiveInboundAdmissionHandler === 'function';

  if (promote) promote();
  const session = new SignalingSession({
    isOutbound: false,
    peerInfo: { host: normalizePeerAddress(socket?.remoteAddress) },
  });
  session.passiveAdmissionRequired = passiveAdmissionRequired;
  session.passiveAdmissionAccepted = passiveAdmissionRequired
    ? inheritedAdmission?.required === true && inheritedAdmission?.accepted === true
    : true;
  session.passiveAdmissionDetails = session.passiveAdmissionAccepted
    ? inheritedAdmission?.details || null
    : null;
  session.passiveAdmissionRejected = false;
  session.passiveAdmissionTimer = null;

  setupSessionEvents(session);
  session.attachSocket(socket);
  activateSession(session, socket, 'inbound', wasRecovering ? 'peer-redial' : 'connect');

  if (session.passiveAdmissionRequired && !session.passiveAdmissionAccepted) {
    startPassiveInboundIdentityTimer(session);
  }

  if (Array.isArray(options.preMessages) && options.preMessages.length) {
    for (const message of options.preMessages) {
      if (activeSession !== session || !session.isConnected) break;
      session.onMessage?.(message, session);
    }
  }

  // waitForClientConnection belongs to the explicit Wi-Fi Direct server flow.
  // Passive LAN sockets must never leave a stale clientConnectedPending token.
  if (isExplicitServerMode) notifyClientConnected();
  return true;
}

export function startPersistentListener(port = DEFAULT_SIGNALING_PORT) {
  const listener = getDefaultSignalingListener();
  listener.onConnection = (socket, promote) => attachIncomingSession(socket, promote, 'persistent');
  return listener.start(port).then(result => {
    if (!activeSession) setAvailabilityStatus();
    return result;
  });
}

export function createSignalingServer(port = DEFAULT_SIGNALING_PORT) {
  isExplicitServerMode = true;
  if (activeSession && !activeSession.isConnected) {
    logSocket('STALE_SESSION_DESTROYED', activeSession.socket, 'reason=explicit-server-mode');
    activeSession.destroy();
    activeSession = null;
  }
  return startPersistentListener(port);
}

export function connectToSignalingServer(host, port, maxRetries = 10, retryDelayMs = 800) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const requestedHost = normalizePeerAddress(host);

    if (activeSession && activeSession.isConnected && activeSession.socket) {
      const activeHost = getActivePeerAddress();
      if (isSameSignalingEndpoint(activeHost, requestedHost)) {
        console.log(`[G1/SIGNAL][${socketId(activeSession.socket)}] CONNECT_REUSED host=${host} port=${port}`);
        resolve();
        return;
      }

      // Never silently reuse or destroy a healthy session that belongs to a
      // different peer. The caller/orchestrator must explicitly disconnect or
      // migrate it first. This prevents messages/files from being routed to the
      // wrong device during rapid peer selection or stale UI state.
      const error = new Error(
        `يوجد اتصال نشط مع جهاز آخر (${activeHost || 'unknown'}). أنهِ الجلسة الحالية قبل الاتصال بـ ${requestedHost || host}`
      );
      logSocket('CONNECT_REUSE_REJECTED', activeSession.socket, `active=${activeHost || 'unknown'} requested=${requestedHost || host}`);
      reject(error);
      return;
    }
    if (activeSession) {
      logSocket('STALE_SESSION_DESTROYED', activeSession.socket, 'reason=new-outbound-connect');
      activeSession.destroy();
      activeSession = null;
    }

    cancelPendingRecovery();
    gracefulDisconnectPending = false;

    const abort = error => {
      if (settled) return;
      settled = true;
      reject(error || new Error('أُلغيت محاولة الاتصال بقناة الإشارات'));
    };
    abortCurrentOperation = abort;

    connectOutboundSocket({ host, port, maxRetries, retryDelayMs })
      .then(socket => {
        socketId(socket);
        logSocket('OUTBOUND_CONNECTED', socket, `host=${host} port=${port}`);
        if (settled) {
          logSocket('OUTBOUND_REJECTED', socket, 'reason=operation-already-settled');
          try { socket.destroy(); } catch (e) {}
          return;
        }
        settled = true;
        if (abortCurrentOperation === abort) abortCurrentOperation = null;

        if (activeSession && activeSession.isConnected && activeSession.socket) {
          const activeHost = getActivePeerAddress();
          if (isSameSignalingEndpoint(activeHost, requestedHost)) {
            logSocket('OUTBOUND_DUPLICATE_REJECTED', socket, `active=${socketId(activeSession.socket)}`);
            try { socket.destroy(); } catch (e) {}
            resolve();
            return;
          }

          logSocket('OUTBOUND_RACE_REJECTED', socket, `activePeer=${activeHost || 'unknown'} requested=${requestedHost || host}`);
          try { socket.destroy(); } catch (e) {}
          reject(new Error('تم إنشاء جلسة مع جهاز آخر أثناء محاولة الاتصال'));
          return;
        }

        const session = new SignalingSession({ isOutbound: true, peerInfo: { host, port } });
        setupSessionEvents(session);
        session.attachSocket(socket);
        activateSession(session, socket, 'outbound');
        resolve();
      })
      .catch(err => {
        if (settled) return;
        if (abortCurrentOperation === abort) abortCurrentOperation = null;
        abort(err);
      });
  });
}

export function cancelSignalingConnectAttempt(reason) {
  const abort = abortCurrentOperation;
  if (!abort) return false;

  abortCurrentOperation = null;
  const error = reason instanceof Error
    ? reason
    : new Error(typeof reason === 'string' && reason ? reason : 'أُلغيت محاولة الاتصال بقناة الإشارات');
  abort(error);
  return true;
}

export function sendSignalingMessage(msgObj) {
  if (!activeSession) return false;
  const socket = activeSession.socket;
  const type = msgObj?.type || 'unknown';
  if (type === 'disconnect-request' || type === 'disconnect-ack') {
    gracefulDisconnectPending = true;
  }
  logSocket('SEND', socket, `type=${type}`);
  const sent = activeSession.sendMessage(msgObj);
  if (!sent) logSocket('SEND_FAILED', socket, `type=${type}`);
  return sent;
}

export function closeSignaling() {
  stopHeartbeat();
  cancelPendingRecovery();
  gracefulDisconnectPending = false;
  const session = activeSession;
  activeSession = null;

  if (session) {
    clearPassiveInboundIdentityTimer(session);
    logSocket('SESSION_DESTROYED', session.socket, 'reason=closeSignaling');
    session.destroy();
  }

  cancelSignalingConnectAttempt(new Error('أُغلقت قناة الإشارات'));

  if (clientWaitTimer) clearTimeout(clientWaitTimer);
  clientWaitTimer = null;
  if (clientWaitReject) {
    const reject = clientWaitReject;
    clientWaitReject = null;
    reject(new Error('أُغلقت قناة الإشارات'));
  }
  onClientConnectedCallback = null;
  clientConnectedPending = false;
  isExplicitServerMode = false;
  setAvailabilityStatus();
}
