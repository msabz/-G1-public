import fs from 'fs';
import path from 'path';

describe('App unified runtime wiring', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.js'), 'utf8');
  const chatSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'ChatScreen.js'),
    'utf8'
  );
  const contactsSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'ContactsScreen.js'),
    'utf8'
  );
  const bluetoothPanelSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'discovery', 'BluetoothDiscoveryPanel.js'),
    'utf8'
  );
  const bluetoothNativeSource = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'android',
      'app',
      'src',
      'main',
      'java',
      'com',
      'm200',
      'bluetooth',
      'BluetoothConnectionModule.kt'
    ),
    'utf8'
  );

  test('keeps Bluetooth discovery independent from camera and microphone permissions', () => {
    expect(appSource).toContain('async function requestBluetoothPerms()');
    expect(appSource).toContain('async function requestMediaPerms()');
    expect(appSource).toMatch(
      /const btScan = async \(\) => \{[\s\S]*?await requestBluetoothPerms\(\)/
    );
    expect(appSource).toMatch(
      /wifiPermissionRequest\.finally\(\(\) => \{[\s\S]{0,300}?startBluetoothAvailability\(\)/
    );
    expect(appSource).toMatch(
      /async function startBluetoothAvailability\(\)[\s\S]{0,500}?bluetoothTransport\.startListening\(\)/
    );
    const mediaPermissions = appSource.match(
      /async function requestMediaPerms\(\) \{([\s\S]*?)\n  \};/
    )?.[1] || '';
    expect(mediaPermissions).not.toContain('BLUETOOTH_SCAN');
    expect(mediaPermissions).not.toContain('NEARBY_WIFI_DEVICES');
  });

  test('exposes Bluetooth discovery from the normal idle contacts screen', () => {
    expect(appSource).toContain('onBtScan={btScan}');
    expect(appSource).toContain('btScanning={btScanning}');
    expect(contactsSource).toContain('onBtScan');
    expect(contactsSource).toContain('btScanning = false');
    expect(contactsSource).toContain(
      "scanButtonTitle={btScanning ? 'جاري البحث…' : 'بحث Bluetooth'}"
    );
    expect(bluetoothPanelSource).toContain("scanButtonTitle = 'بحث Bluetooth'");
    expect(bluetoothPanelSource).toContain('testID="bluetooth-scan-action"');
    expect(bluetoothPanelSource).toContain('accessibilityLabel="بدء بحث Bluetooth وإظهار هذا الهاتف"');
    expect(contactsSource).not.toContain('{btDevices && btDevices.length > 0 && (');
    expect(appSource).toMatch(
      /if \(!enabled\) \{[\s\S]{0,300}?await BT\.requestEnable\(\)[\s\S]{0,1200}?bluetoothTransport\.discover\(/
    );
    expect(appSource).toContain('retry < 20 && !enabled');
  });

  test('reports Bluetooth scan startup truthfully to the discovery panel', () => {
    const start = appSource.indexOf('const btScan = async');
    const end = appSource.indexOf('const buildBluetoothPeer =', start);
    const scanSource = appSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(scanSource).toContain('await bluetoothTransport.discover({');
    expect(scanSource).toMatch(/await bluetoothTransport\.discover\([\s\S]*?return true;/);
    expect(scanSource.match(/return false;/g)?.length).toBeGreaterThanOrEqual(5);
  });

  test('waits for Android discoverability consent before resolving the native request', () => {
    expect(bluetoothNativeSource).toContain('ActivityEventListener');
    expect(bluetoothNativeSource).toContain('activity.startActivityForResult(intent, REQUEST_DISCOVERABLE)');
    expect(bluetoothNativeSource).toContain('if (requestCode != REQUEST_DISCOVERABLE) return');
    expect(bluetoothNativeSource).toContain('resultCode == Activity.RESULT_CANCELED');
    expect(bluetoothNativeSource).toContain('Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)');
    expect(bluetoothNativeSource).toContain('REQUEST_ENABLE');
    expect(bluetoothNativeSource).toContain('resultCode != Activity.RESULT_OK');
  });

  test('uses bounded unified selection and automatic alternate transport fallback', () => {
    expect(appSource).toContain('connectionCoordinator.connectPeer(selectionPeer, {');
    expect(appSource).toContain('excludeTransports: [...excludedTransports]');
    expect(appSource).toContain('automaticFailoverCountRef.current >= 2');
    expect(appSource).toContain('attemptAlternateTransport(failedPeer, TRANSPORTS.BLUETOOTH)');
  });

  test('does not promote a raw Wi-Fi Direct MAC address into unified stable identity', () => {
    expect(appSource).toContain('const stableId = resolveStableP2pDeviceId(contact, contact);');
    expect(appSource).not.toContain('const stableId = contact.deviceId || contact.peerId || null;');
  });

  test('bounds legacy native Wi-Fi Direct callbacks from the start of preparation', () => {
    expect(appSource).toContain('const nativeDeadline = new Promise((_, reject) => {');
    expect(appSource).toMatch(
      /timeoutRef\.current = setTimeout[\s\S]{0,900}?Promise\.race\(\[[\s\S]{0,250}?DirectConnection\.stopServiceDiscovery\(\)/
    );
    expect(appSource).toMatch(
      /Promise\.race\(\[[\s\S]{0,200}?DirectConnection\.connectToPeer\(selected\.deviceAddress\)/
    );
  });

  test('releases failed coordinator routes without cancelling the active fallback plan', () => {
    expect(appSource).toContain('connectionCoordinator.disconnect({ preserveFallback: true });');
  });

  test('routes planned Bluetooth changes through make-before-break and stable identity rebind', () => {
    expect(appSource).toContain(
      'connectionCoordinator.handoverPeer(peer, TRANSPORTS.BLUETOOTH, {'
    );
    expect(appSource).toContain('connectionCoordinator.rebindConnectedPeer(stablePeer, {');
    expect(appSource).toContain('releaseLegacyIpTransportForBluetooth(previousTransport)');
    expect(appSource).toContain("String(contact?.btAddress || '').trim().toUpperCase() === address");
  });

  test('adopts authenticated Bluetooth before releasing either legacy IP path', () => {
    const incomingStart = appSource.indexOf('const handleBluetoothConnected = async');
    const incomingEnd = appSource.indexOf('const handleBluetoothMessage = async', incomingStart);
    const incomingSource = appSource.slice(incomingStart, incomingEnd);
    const incomingAdopt = incomingSource.indexOf(
      'const promotedRoute = await connectionCoordinator.connectBluetoothPeer(peer, 25000, {'
    );
    const incomingRelease = incomingSource.indexOf(
      'await releaseLegacyIpTransportForBluetooth(previousTransport);'
    );

    const outgoingStart = appSource.indexOf('const btConnect = async');
    const outgoingEnd = appSource.indexOf('const endCallLocal =', outgoingStart);
    const outgoingSource = appSource.slice(outgoingStart, outgoingEnd);
    const outgoingLegacyStart = outgoingSource.indexOf(
      '} else if (previousTransport && previousTransport !== TRANSPORTS.BLUETOOTH) {'
    );
    const outgoingAdopt = outgoingSource.indexOf(
      'route = await connectionCoordinator.connectBluetoothPeer(peer, 25000, {',
      outgoingLegacyStart
    );
    const outgoingRelease = outgoingSource.indexOf(
      'await releaseLegacyIpTransportForBluetooth(previousTransport);',
      outgoingLegacyStart
    );

    expect(incomingAdopt).toBeGreaterThanOrEqual(0);
    expect(incomingRelease).toBeGreaterThan(incomingAdopt);
    expect(outgoingLegacyStart).toBeGreaterThanOrEqual(0);
    expect(outgoingAdopt).toBeGreaterThan(outgoingLegacyStart);
    expect(outgoingRelease).toBeGreaterThan(outgoingAdopt);
  });

  test('bootstraps the first Bluetooth route from authenticated G1 identity', () => {
    expect(appSource).toContain('device.deviceId || device.remoteNodeId');
    expect(appSource).toContain('const deviceId = advertisedDeviceId || known?.deviceId');
    expect(appSource).toContain('const peer = route.peer || buildBluetoothPeer({');
    expect(appSource).not.toContain('route.peer || bluetoothPendingPeerRef.current || buildBluetoothPeer');
    expect(appSource).toContain('const verifiedPeer = route?.peer || peer;');
    expect(appSource).toContain('activateBluetoothUi(adoptedRoute?.peer || peer, adoptedRoute)');
    expect(appSource).toContain('currentPeerId !== peer.deviceId');
    expect(appSource).toContain('تم توثيق Bluetooth');
    expect(bluetoothNativeSource).toContain('IDENTITY_PREFERENCES = "musabchat_identity"');
    expect(bluetoothNativeSource).toContain('IDENTITY_DEVICE_ID = "device_id"');
  });

  test('a Bluetooth device tap always invokes the Bluetooth connector directly', () => {
    const start = appSource.indexOf('const btConnect = async');
    const end = appSource.indexOf('const endCallLocal =', start);
    const btConnectSource = appSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(btConnectSource).not.toContain('connectionCoordinator.connectPeer(peer');
    expect(btConnectSource).toMatch(
      /else \{\s*route = await connectionCoordinator\.connectBluetoothPeer\(peer, 25000, \{/
    );
  });

  test('clears provisional Bluetooth ownership on every logical session cleanup', () => {
    const cleanup = appSource.match(
      /function cleanupSessionResources\([^)]*\) \{([\s\S]*?)\n  \}/
    )?.[1] || '';
    expect(cleanup).toContain('bluetoothPendingPeerRef.current = null;');
    expect(cleanup).toContain('bluetoothActivationRef.current = null;');
    expect(cleanup).toContain('bluetoothLegacyHandoverRef.current = null;');
    expect(cleanup).toContain('pendingBluetoothIdentityRef.current = null;');
  });

  test('keeps Bluetooth UI hydration outside the bounded transport connector', () => {
    expect(appSource).toMatch(
      /connectBluetooth: bluetoothAddress[\s\S]{0,700}?return route;[\s\S]{0,900}?selection\?\.transport === TRANSPORTS\.BLUETOOTH/
    );
    expect(appSource).toContain('const connectedPeer = route?.peer || selectionPeer;');
    expect(appSource).toContain('cancelOwnedCoordinatorStep(selectionPeer.deviceId, TRANSPORTS.BLUETOOTH)');
  });

  test('preserves the incoming legacy route when Bluetooth adoption fails', () => {
    const start = appSource.indexOf('const handleBluetoothConnected = async');
    const end = appSource.indexOf('const handleBluetoothMessage = async', start);
    const incomingSource = appSource.slice(start, end);

    expect(incomingSource).toContain('let adoptedLegacyTransport = false;');
    expect(incomingSource).toContain('adoptedLegacyTransport = true;');
    expect(incomingSource).toMatch(
      /!adoptedLegacyTransport &&[\s\S]{0,160}?!releasedLegacyTransport[\s\S]{0,180}?stateRef\.current = States\.CONNECTED;/
    );
  });

  test('rejects an app identity that conflicts with the authenticated Bluetooth hello', () => {
    expect(appSource).toContain('activeRoute?.remoteNodeId');
    expect(appSource).toContain('stableDeviceId !== authenticatedDeviceId');
    expect(appSource).toContain('رفض هوية Bluetooth لا تطابق المصافحة الموثقة');
  });

  test('correlates RTC media with one call and never reflects Bluetooth failures', () => {
    expect(appSource).toContain('rtcNegotiatingCallIdRef.current === call.callId');
    expect(appSource).toContain('callId: mediaCallId');
    expect(appSource).toContain(
      "if (message.type === 'call-request' || message.type === 'rtc-offer')"
    );
    expect(appSource).not.toMatch(
      /if \(message\.type\?\.startsWith\('call-'\)[\s\S]{0,180}type: 'call-failed'/
    );
  });

  test('visually disables IP-only calls and assets on the Bluetooth text route', () => {
    expect(chatSource).toContain("const mediaEnabled = activeTier !== 'BLUETOOTH';");
    expect(chatSource).toContain('accessibilityState={{ disabled: !mediaEnabled }}');
    expect(appSource).toContain('if (activeTransportRef.current === TRANSPORTS.BLUETOOTH)');
  });
});
