import fs from 'fs';
import path from 'path';

describe('Wi-Fi Direct passive presence lease', () => {
  const nativeSource = fs.readFileSync(
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
      'directconnection',
      'DirectConnectionModule.kt'
    ),
    'utf8'
  );

  test('refresh cadence stays safely below the AOSP idle shutdown window', () => {
    const match = nativeSource.match(/private val PASSIVE_PRESENCE_LEASE_REFRESH_MS = ([0-9_]+)L/);
    expect(match).not.toBeNull();
    const refreshMs = Number(match[1].replaceAll('_', ''));
    expect(refreshMs).toBeGreaterThan(0);
    expect(refreshMs).toBeLessThan(150000);
    expect(refreshMs).toBeLessThanOrEqual(60000);
  });

  test('successful owned advertising starts the generation-scoped lease', () => {
    const start = nativeSource.indexOf('private fun startAdvertisingWithRetry(');
    const end = nativeSource.indexOf('private fun schedulePassivePresenceLease(', start);
    const slice = nativeSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(slice).toContain('serviceInfo = info');
    expect(slice).toContain('advertising = true');
    expect(slice).toContain('schedulePassivePresenceLease(generation)');
  });

  test('lease uses only read-only peer polling and never changes discovery mode', () => {
    const start = nativeSource.indexOf('private fun schedulePassivePresenceLease(');
    const end = nativeSource.indexOf('@ReactMethod\n    fun stopAdvertising', start);
    const slice = nativeSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(slice).toContain('mainHandler.postDelayed');
    expect(slice).toContain('manager.requestPeers(currentChannel)');
    expect(slice).toContain('generation != advertisingGeneration');
    expect(slice).toContain('currentChannel === channel');
    expect(slice).toContain('PASSIVE_PRESENCE_LEASE_REFRESH_MS');
    expect(slice).not.toContain('startListening(');
    expect(slice).not.toContain('discoverPeers(');
    expect(slice).not.toContain('addLocalService(');
    expect(slice).not.toContain('clearLocalServices(');
    expect(slice).not.toContain('clearServiceRequests(');
  });
});
