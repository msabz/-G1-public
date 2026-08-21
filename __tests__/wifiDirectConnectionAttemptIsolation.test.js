import fs from 'fs';
import path from 'path';

describe('Wi-Fi Direct connection-attempt isolation', () => {
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

  test('stale disconnected broadcasts cannot terminate a new negotiation', () => {
    const start = nativeSource.indexOf('WIFI_P2P_CONNECTION_CHANGED_ACTION -> {');
    const end = nativeSource.indexOf('WIFI_P2P_THIS_DEVICE_CHANGED_ACTION', start);
    const block = nativeSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(block).toContain('val connectionWasInProgress = connectionInProgress');
    expect(block).toContain('} else if (connectionWasInProgress) {');
    expect(block).toContain('the JS timeout/native watchdog remains the bounded failure authority');
    expect(block).toMatch(
      /else if \(connectionWasInProgress\) \{[\s\S]*?emitCurrentPeers\(\)[\s\S]*?\} else \{/
    );
  });

  test('presence recovery is only scheduled for a real idle disconnect', () => {
    const start = nativeSource.indexOf('WIFI_P2P_CONNECTION_CHANGED_ACTION -> {');
    const end = nativeSource.indexOf('WIFI_P2P_THIS_DEVICE_CHANGED_ACTION', start);
    const block = nativeSource.slice(start, end);
    const pendingStart = block.indexOf('} else if (connectionWasInProgress) {');
    const idleStart = block.indexOf('} else {', pendingStart + 1);
    const pendingBlock = block.slice(pendingStart, idleStart);
    const idleBlock = block.slice(idleStart);

    expect(pendingBlock).not.toContain('connectionInProgress = false');
    expect(pendingBlock).not.toContain('connectionGeneration++');
    expect(pendingBlock).not.toContain('scheduleActivePresenceRefresh');
    expect(idleBlock).toContain('connectionInProgress = false');
    expect(idleBlock).toContain('connectionGeneration++');
    expect(idleBlock).toContain('scheduleActivePresenceRefresh(presenceGeneration, 600L)');
  });
});
