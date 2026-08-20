import fs from 'fs';
import path from 'path';

describe('Wi-Fi Direct corrected discovery lifecycle', () => {
  const nativeSource = fs.readFileSync(
    path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'm200', 'directconnection', 'DirectConnectionModule.kt'),
    'utf8'
  );
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.js'), 'utf8');

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

  test('manual fresh discovery returns to passive listen after the generic scan', () => {
    const start = appSource.indexOf('const runFreshDiscovery = async () => {');
    const end = appSource.indexOf('const findFreshPeer = contact =>', start);
    const slice = appSource.slice(start, end);
    const genericScan = slice.indexOf('await DirectConnection.discoverPeers();');
    const passiveListen = slice.lastIndexOf('await DirectConnection.startPassiveListening();');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(genericScan).toBeGreaterThanOrEqual(0);
    expect(passiveListen).toBeGreaterThan(genericScan);
  });
});
