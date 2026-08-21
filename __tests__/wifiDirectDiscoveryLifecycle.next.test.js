import fs from 'fs';
import path from 'path';

describe('Wi-Fi Direct resilient discovery lifecycle', () => {
  const nativeSource = fs.readFileSync(
    path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'm200', 'directconnection', 'DirectConnectionModule.kt'),
    'utf8'
  );
  const executableSource = nativeSource.replace(/\/\/.*$/gm, '');

  test('normal advertising owns an exact local service without broad clear-first', () => {
    const start = nativeSource.indexOf('fun startAdvertising(deviceLabel: String, deviceId: String, promise: Promise)');
    const end = nativeSource.indexOf('fun discoverMusabPeers(promise: Promise)', start);
    const slice = nativeSource.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(slice).toContain('manager.addLocalService(currentChannel, info');
    expect(slice).toContain('manager.removeLocalService(currentChannel, info');
    expect(slice).not.toContain('clearLocalServices');
  });

  test('normal DNS-SD owns an exact request without broad clear-first', () => {
    const start = nativeSource.indexOf('fun discoverMusabPeers(promise: Promise)');
    const end = nativeSource.indexOf('fun stopServiceDiscovery(promise: Promise)', start);
    const slice = nativeSource.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(slice).toContain('manager.addServiceRequest(currentChannel, request');
    expect(slice).toContain('manager.discoverServices(currentChannel');
    expect(slice).toContain('manager.removeServiceRequest(operationChannel, request');
    expect(slice).not.toContain('clearServiceRequests');
  });

  test('normal stop removes only the owned DNS-SD request', () => {
    const start = nativeSource.indexOf('fun stopServiceDiscovery(promise: Promise)');
    const end = nativeSource.indexOf('fun isSupported(promise: Promise)', start);
    const slice = nativeSource.slice(start, end);
    expect(slice).toContain('manager.removeServiceRequest(currentChannel, request');
    expect(slice).not.toContain('clearServiceRequests');
  });

  test('teardown keeps serialized broad cleanup but does not destroy a clean channel', () => {
    const start = nativeSource.indexOf('fun cleanupConnection(timeoutMs: Double, promise: Promise)');
    const end = nativeSource.indexOf('fun getConnectionInfo(promise: Promise)', start);
    const slice = nativeSource.slice(start, end);
    expect(slice).toContain('stopDiscoveryThenClear(0)');
    expect(slice).toContain('manager.clearServiceRequests(operationChannel');
    expect(slice).toContain('manager.cancelConnect(operationChannel');
    expect(slice).toMatch(/if \(group == null\)[\s\S]*?consecutiveEmptyChecks >= 2[\s\S]*?finish\(clean = true, timedOut = false, reinitialized = false\)/);
  });

  test('channel loss has a real listener, bounded recovery and desired-advertisement restoration', () => {
    expect(nativeSource).toContain('ChannelListener {');
    expect(nativeSource).toContain('scheduleBoundedChannelRecovery(generation)');
    expect(nativeSource).toContain('MAX_CHANNEL_RECOVERY_ATTEMPTS = 2');
    expect(nativeSource).toContain('restoreDesiredAdvertising(advertisingGeneration, 0)');
    expect(nativeSource).toContain('desiredDeviceLabel = deviceLabel');
    expect(nativeSource).toContain('desiredDeviceId = deviceId');
  });

  test('responder availability uses active discovery and never switches to startListening', () => {
    const start = nativeSource.indexOf('fun startPassiveListening(promise: Promise)');
    const end = nativeSource.indexOf('fun stopDiscovery(promise: Promise)', start);
    const slice = nativeSource.slice(start, end).replace(/\/\/.*$/gm, '');
    expect(slice).toContain('startDiscoveryWithRetry(promise, 0, false)');
    expect(executableSource).not.toContain('.startListening(');
    expect(nativeSource).not.toContain('PASSIVE_RESTORE_DELAY_MS');
    expect(nativeSource).not.toContain('restorePassiveListeningAfterScan');
  });

  test('discovery state is observable and stopped discovery can re-prime owned presence', () => {
    expect(nativeSource).toContain('addAction(WIFI_P2P_DISCOVERY_CHANGED_ACTION)');
    expect(nativeSource).toContain('WIFI_P2P_DISCOVERY_CHANGED_ACTION ->');
    expect(nativeSource).toContain('putBoolean("active", discoveryActive)');
    expect(nativeSource).toContain('if (!discoveryActive && canRefreshPresence(presenceGeneration))');
    expect(nativeSource).toContain('refreshActivePresence(presence, 0)');
  });
});
