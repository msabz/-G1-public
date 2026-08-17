const fs = require('fs');

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content, 'utf8');
}

function occurrenceCount(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

function replaceExact(source, label, from, to, expectedCount = 1) {
  const count = occurrenceCount(source, from);
  if (count !== expectedCount) {
    throw new Error(`[codemod:${label}] expected ${expectedCount} occurrence(s), found ${count}`);
  }
  return source.split(from).join(to);
}

function refactorSignaling() {
  const path = 'src/webrtc/signaling.js';
  let source = read(path);

  source = replaceExact(
    source,
    'observer-sets',
    'let recoveryInProgress = false;\n',
    `let recoveryInProgress = false;\nconst messageObservers = new Set();\nconst disconnectObservers = new Set();\n`
  );

  source = replaceExact(
    source,
    'observer-dispatchers',
    `export function isSameSignalingEndpoint(left, right) {\n  const a = normalizePeerAddress(left);\n  const b = normalizePeerAddress(right);\n  return !!(a && b && a === b);\n}\n`,
    `export function isSameSignalingEndpoint(left, right) {\n  const a = normalizePeerAddress(left);\n  const b = normalizePeerAddress(right);\n  return !!(a && b && a === b);\n}\n\nfunction notifyMessageObservers(msg) {\n  messageObservers.forEach(observer => {\n    try { observer(msg); } catch (error) {\n      console.warn('[G1/SIGNAL] message observer failed:', error?.message || error);\n    }\n  });\n}\n\nfunction notifyDisconnectObservers(details) {\n  disconnectObservers.forEach(observer => {\n    try { observer(details); } catch (error) {\n      console.warn('[G1/SIGNAL] disconnect observer failed:', error?.message || error);\n    }\n  });\n}\n`
  );

  source = replaceExact(
    source,
    'message-observer-hook',
    `    if (msg?.type === 'pong') {\n      logSocket('PONG_RECEIVED', session.socket, \`ts=\${msg.ts || ''}\`);\n      return;\n    }\n\n    if (onMessageCallback) onMessageCallback(msg);\n`,
    `    if (msg?.type === 'pong') {\n      logSocket('PONG_RECEIVED', session.socket, \`ts=\${msg.ts || ''}\`);\n      return;\n    }\n\n    notifyMessageObservers(msg);\n    if (onMessageCallback) onMessageCallback(msg);\n`
  );

  source = replaceExact(
    source,
    'disconnect-observer-hook',
    `    console.warn(\`[G1/SIGNAL][none] RECOVERY_EXHAUSTED reason=\${reason}\`);\n    setAvailabilityStatus();\n    if (onDisconnectCallback) onDisconnectCallback();\n`,
    `    console.warn(\`[G1/SIGNAL][none] RECOVERY_EXHAUSTED reason=\${reason}\`);\n    setAvailabilityStatus();\n    notifyDisconnectObservers({ reason, recovered: false });\n    if (onDisconnectCallback) onDisconnectCallback();\n`
  );

  source = replaceExact(
    source,
    'observer-api',
    `export function setOnDisconnect(cb) {\n  onDisconnectCallback = cb;\n  if (activeSession) setupSessionEvents(activeSession);\n}\n`,
    `export function setOnDisconnect(cb) {\n  onDisconnectCallback = cb;\n  if (activeSession) setupSessionEvents(activeSession);\n}\n\nexport function addSignalingMessageObserver(observer) {\n  if (typeof observer !== 'function') return { remove() {} };\n  messageObservers.add(observer);\n  return { remove: () => messageObservers.delete(observer) };\n}\n\nexport function addSignalingDisconnectObserver(observer) {\n  if (typeof observer !== 'function') return { remove() {} };\n  disconnectObservers.add(observer);\n  return { remove: () => disconnectObservers.delete(observer) };\n}\n`
  );

  write(path, source);
}

function refactorIndex() {
  const path = 'index.js';
  let source = read(path);
  const expected = `/**\n * G1 DirectChat - Entry Point\n */\nimport { AppRegistry } from 'react-native';\nimport App from './src/App';\n\nAppRegistry.registerComponent('DirectChat', () => App);\nAppRegistry.registerComponent('M200', () => App);\nAppRegistry.registerComponent('G1', () => App);\n`;
  if (source !== expected) {
    throw new Error('[codemod:index-root] index.js changed; refusing an unsafe replacement');
  }

  source = `/**\n * G1 DirectChat - Entry Point\n */\nimport React, { useEffect } from 'react';\nimport { AppRegistry } from 'react-native';\nimport App from './src/App';\nimport { setUiAttached } from './src/services/BackgroundRuntime';\n\nfunction G1Root() {\n  useEffect(() => {\n    setUiAttached(true);\n    return () => setUiAttached(false);\n  }, []);\n\n  return React.createElement(App);\n}\n\nAppRegistry.registerComponent('DirectChat', () => G1Root);\nAppRegistry.registerComponent('M200', () => G1Root);\nAppRegistry.registerComponent('G1', () => G1Root);\n`;
  write(path, source);
}

function refactorApp() {
  const path = 'src/App.js';
  let source = read(path);

  source = replaceExact(
    source,
    'lan-stable-identity',
    `      sendSignalingMessage({\n        type: "identity",\n        deviceId: identityRef.current?.deviceId || "dc_" + Math.random().toString(36).substring(7),\n        deviceName: identityRef.current?.deviceName || "DirectChat Device",\n      });\n`,
    `      const identity = identityRef.current || await getDeviceIdentity().catch(() => null);\n      if (!identity?.deviceId) throw new Error('تعذّر تحميل هوية G1 الثابتة');\n      identityRef.current = identity;\n      sendSignalingMessage({\n        type: "identity",\n        deviceId: identity.deviceId,\n        deviceName: identity.deviceName || "DirectChat Device",\n      });\n`
  );

  source = replaceExact(
    source,
    'lan-rethrow',
    `      setState(States.IDLE);\n      setStatusText("فشل الاتصال بالـ IP");\n    }\n  };\n`,
    `      setState(States.IDLE);\n      setStatusText("فشل الاتصال بالـ IP");\n      throw e;\n    }\n  };\n`
  );

  source = replaceExact(
    source,
    'ring-state-ref',
    `  const [ringState, setRingState] = useState(null);\n`,
    `  const [ringState, setRingState] = useState(null);\n  const ringStateRef = useRef(ringState);\n  ringStateRef.current = ringState;\n`
  );

  source = replaceExact(
    source,
    'incoming-call-live-state',
    `if (!inCallRef.current && !ringState)`,
    `if (!inCallRef.current && !ringStateRef.current)`
  );
  source = replaceExact(
    source,
    'outgoing-call-live-state',
    `if (inCallRef.current || ringState) return;`,
    `if (inCallRef.current || ringStateRef.current) return;`
  );
  source = replaceExact(
    source,
    'outgoing-timeout-live-state',
    `if (!ringState && !inCallRef.current) return;`,
    `if (!ringStateRef.current && !inCallRef.current) return;`
  );

  source = replaceExact(
    source,
    'remove-app-heartbeat-ref',
    `  const heartbeatRef = useRef(null);\n`,
    ``
  );

  source = replaceExact(
    source,
    'remove-app-heartbeat',
    `      // نبضة دورية تبقي قناة التحكم حيّة أثناء النقل الطويل\n      if (heartbeatRef.current) clearInterval(heartbeatRef.current);\n      heartbeatRef.current = setInterval(() => {\n        sendSignalingMessage({ type: 'ping' });\n      }, 5000);\n\n`,
    ``
  );

  source = replaceExact(
    source,
    'remove-heartbeat-cleanup',
    `    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }\n`,
    ``
  );

  source = replaceExact(
    source,
    'ui-detach-keeps-network',
    `      subs.forEach(s => s.remove());\n      cleanupAll();\n`,
    `      subs.forEach(s => s.remove());\n      // Root/Activity teardown is not an explicit disconnect. Keep signaling,\n      // file server and the foreground availability service alive so removing\n      // G1 from Recents does not make the peer go offline. Explicit disconnect\n      // flows still call cleanupAll()/finishWifiDisconnect().\n`
  );

  source = replaceExact(
    source,
    'live-session-file-routing',
    `  const sendAsset = async ({ uri, name, mimeType, size, kind, localUri }) => {\n    const peerIp = peerIpRef.current;\n    if (!peerIp) { Alert.alert('تعذّر تحديد عنوان الجهاز الآخر'); return; }\n\n    const transferId = newTransferId();\n`,
    `  const sendAsset = async ({ uri, name, mimeType, size, kind, localUri }) => {\n    // Legacy address is fallback only. FileShare resolves the live signaling\n    // socket first, so an inbound/passive peer can send even if peerIpRef was\n    // never populated and a stale P2P address cannot override the live route.\n    const peerIp = peerIpRef.current || null;\n\n    const transferId = newTransferId();\n`
  );

  source = replaceExact(
    source,
    'truthful-message-send-state',
    `  const sendMsg = (text) => {\n    sendSignalingMessage({ type: 'chat', text });\n    addMessage({ sender: 'me', type: 'text', text, status: 'sent' });\n  };\n`,
    `  const sendMsg = (text) => {\n    const sent = sendSignalingMessage({ type: 'chat', text });\n    addMessage({ sender: 'me', type: 'text', text, status: sent ? 'sent' : 'failed' });\n  };\n`
  );

  write(path, source);
}

refactorSignaling();
refactorIndex();
refactorApp();
console.log('G1 app runtime codemod applied successfully.');
