import fs from 'fs';
import path from 'path';

describe('Wi-Fi Direct corrected discovery lifecycle', () => {
  const nativeSource = fs.readFileSync(
    path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'm200', 'directconnection', 'DirectConnectionModule.kt'),
    'utf8'
  );

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

  test('normal stop removes only the owned request', () => {
    const start = nativeSource.indexOf('fun stopServiceDiscovery(promise: Promise)');
    const end = nativeSource.indexOf('private fun ensureChannel()', start);
    const slice = nativeSource.slice(start, end);
    expect(slice).toContain('manager.removeServiceRequest(currentChannel, request');
    expect(slice).not.toContain('clearServiceRequests');
  });

  test('teardown keeps the previously proven serialized broad cleanup path', () => {
    const start = nativeSource.indexOf('fun cleanupConnection(timeoutMs: Double, promise: Promise)');
    const end = nativeSource.indexOf('fun getConnectionInfo(promise: Promise)', start);
    const slice = nativeSource.slice(start, end);
    expect(slice).toContain('stopDiscoveryThenClear(0)');
    expect(slice).toContain('manager.clearServiceRequests(operationChannel');
    expect(slice).toContain('manager.cancelConnect(operationChannel');
  });

  test('channel recreation drops stale channel-scoped service ownership', () => {
    const start = nativeSource.indexOf('private fun resetChannelScopedServiceState()');
    const end = nativeSource.indexOf('private fun reasonName', start);
    const slice = nativeSource.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(slice).toContain('serviceInfo = null');
    expect(slice).toContain('serviceRequest = null');
    expect(slice).toContain('advertising = false');
    expect(slice).toContain('resetChannelScopedServiceState()');
  });

  test('manual DNS-SD-to-generic scan lifecycle restores passive listening without touching App ownership', () => {
    const stopStart = nativeSource.indexOf('fun stopServiceDiscovery(promise: Promise)');
    const discoverStart = nativeSource.indexOf('fun discoverPeers(promise: Promise)');
    const restoreStart = nativeSource.indexOf('private fun restorePassiveListeningAfterScan(');
    const stopSlice = nativeSource.slice(stopStart, discoverStart);
    const discoverSlice = nativeSource.slice(discoverStart, restoreStart + 1200);

    expect(stopSlice).toContain('restorePassiveAfterNextPeerScan = true');
    expect(discoverSlice).toContain('val restorePassive = restorePassiveAfterNextPeerScan');
    expect(discoverSlice).toContain('restorePassiveAfterNextPeerScan = false');
    expect(discoverSlice).toContain('restorePassiveListeningAfterScan(currentChannel, connectionEpoch, 0)');
    expect(discoverSlice).toContain('manager.startListening(expectedChannel');
    expect(discoverSlice).toContain('connectionGeneration != connectionEpoch');
  });
});
