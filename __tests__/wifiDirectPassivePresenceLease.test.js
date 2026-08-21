import fs from 'fs';
import path from 'path';

describe('Wi-Fi Direct active presence refresh', () => {
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

  test('refresh cadence stays bounded and comfortably below framework idle windows', () => {
    const match = nativeSource.match(/private val ACTIVE_PRESENCE_REFRESH_MS = ([0-9_]+)L/);
    expect(match).not.toBeNull();
    const refreshMs = Number(match[1].replaceAll('_', ''));
    expect(refreshMs).toBeGreaterThan(0);
    expect(refreshMs).toBeLessThanOrEqual(60000);
  });

  test('successful owned advertising starts a generation-scoped active presence lease', () => {
    const start = nativeSource.indexOf('private fun startAdvertisingWithRetry(');
    const end = nativeSource.indexOf('private fun restoreDesiredAdvertising(', start);
    const slice = nativeSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(slice).toContain('serviceInfo = info');
    expect(slice).toContain('advertising = true');
    expect(slice).toContain('val presence = ++presenceGeneration');
    expect(slice).toContain('scheduleActivePresenceRefresh(presence)');
  });

  test('presence refresh actively primes P2P but yields to service discovery, cleanup, negotiation and groups', () => {
    const guardStart = nativeSource.indexOf('private fun canRefreshPresence(');
    const end = nativeSource.indexOf('@ReactMethod\n    fun stopAdvertising', guardStart);
    const slice = nativeSource.slice(guardStart, end);

    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(slice).toContain('serviceRequest == null');
    expect(slice).toContain('!cleanupInProgress');
    expect(slice).toContain('!connectionInProgress');
    expect(slice).toContain('!groupActive');
    expect(slice).toContain('manager.discoverPeers(currentChannel');
    expect(slice).not.toContain('manager.requestPeers(currentChannel)');
    expect(slice).not.toContain('manager.startListening(');
  });

  test('channel recreation invalidates stale scoped ownership and restores desired advertisement', () => {
    const resetStart = nativeSource.indexOf('private fun resetChannelScopedServiceState()');
    const restoreStart = nativeSource.indexOf('private fun restoreDesiredAdvertising(');
    const restoreEnd = nativeSource.indexOf('private fun canRefreshPresence(', restoreStart);
    const resetSlice = nativeSource.slice(resetStart, restoreStart);
    const restoreSlice = nativeSource.slice(restoreStart, restoreEnd);

    expect(resetSlice).toContain('serviceInfo = null');
    expect(resetSlice).toContain('serviceRequest = null');
    expect(resetSlice).toContain('advertising = false');
    expect(resetSlice).toContain('presenceGeneration++');
    expect(resetSlice).toContain('restoreDesiredAdvertising(advertisingGeneration, 0)');
    expect(restoreSlice).toContain('desiredDeviceLabel');
    expect(restoreSlice).toContain('desiredDeviceId');
    expect(restoreSlice).toContain('manager.addLocalService(currentChannel, info');
    expect(restoreSlice).toContain('refreshActivePresence(presence, 0)');
  });
});
