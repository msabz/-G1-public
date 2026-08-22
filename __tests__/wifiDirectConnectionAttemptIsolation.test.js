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

  test('native group attempts and connection lifecycle events expose their epoch', () => {
    const createGroupStart = nativeSource.indexOf('fun createGroup(promise: Promise)');
    const connectStart = nativeSource.indexOf('fun connectToPeer(', createGroupStart);
    const createGroupBlock = nativeSource.slice(createGroupStart, connectStart);
    const emitConnectedStart = nativeSource.indexOf('private fun emitPeerConnected(');
    const sendEventStart = nativeSource.indexOf('private fun sendEvent(', emitConnectedStart);
    const emitConnectedBlock = nativeSource.slice(emitConnectedStart, sendEventStart);
    const connectionChangedStart = nativeSource.indexOf('WIFI_P2P_CONNECTION_CHANGED_ACTION -> {');
    const connectionChangedEnd = nativeSource.indexOf(
      'WIFI_P2P_THIS_DEVICE_CHANGED_ACTION',
      connectionChangedStart
    );
    const connectionChangedBlock = nativeSource.slice(connectionChangedStart, connectionChangedEnd);

    expect(createGroupStart).toBeGreaterThanOrEqual(0);
    expect(connectStart).toBeGreaterThan(createGroupStart);
    expect(createGroupBlock).toContain(
      'val started = epoch == connectionGeneration && currentChannel === channel'
    );
    expect(createGroupBlock).toContain('putBoolean("started", started)');
    expect(createGroupBlock).toContain('putDouble("connectionEpoch", epoch.toDouble())');
    expect(emitConnectedBlock).toMatch(
      /sendEvent\("PEER_CONNECTED"[\s\S]*?putDouble\("connectionEpoch", epoch\.toDouble\(\)\)/
    );
    expect(connectionChangedBlock).toMatch(
      /sendEvent\("PEER_DISCONNECTED"[\s\S]*?putDouble\("connectionEpoch", eventEpoch\.toDouble\(\)\)/
    );
  });

  test('group operations recover a channel snapshot and invalidate synchronous failures', () => {
    const createStart = nativeSource.indexOf('fun createGroup(promise: Promise)');
    const connectStart = nativeSource.indexOf('fun connectToPeer(', createStart);
    const cancelStart = nativeSource.indexOf('fun cancelConnect(', connectStart);
    const createBlock = nativeSource.slice(createStart, connectStart);
    const connectBlock = nativeSource.slice(connectStart, cancelStart);

    expect(createStart).toBeGreaterThanOrEqual(0);
    expect(connectStart).toBeGreaterThan(createStart);
    expect(cancelStart).toBeGreaterThan(connectStart);
    [createBlock, connectBlock].forEach(block => {
      expect(block).toContain('if (!ensureChannel())');
      expect(block).toContain('val manager = wifiP2pManager ?: run');
      expect(block).toContain('val currentChannel = channel ?: run');
      expect(block).toContain('attemptEpoch?.let { invalidateConnectionAttempt(it) }');
      expect(block).toMatch(/catch \(e: Exception\) \{[\s\S]*?promise\.reject\("ERROR",[\s\S]*?, e\)/);
    });
    expect(createBlock).toContain('manager.createGroup(currentChannel, object : ActionListener');
    expect(connectBlock).toContain('manager.connect(currentChannel, config, object : ActionListener');
    expect(createBlock).not.toContain('wifiP2pManager?.createGroup(channel');
    expect(connectBlock).not.toContain('wifiP2pManager?.connect(channel');
    const invalidationStart = nativeSource.indexOf('private fun invalidateConnectionAttempt(');
    const invalidationEnd = nativeSource.indexOf('@ReactMethod', invalidationStart);
    const invalidationBlock = nativeSource.slice(invalidationStart, invalidationEnd);
    expect(invalidationStart).toBeGreaterThanOrEqual(0);
    expect(invalidationEnd).toBeGreaterThan(invalidationStart);
    expect(invalidationBlock).toContain('connectionInProgress = false');
    expect(invalidationBlock).toContain('connectionGeneration++');
  });

  test('stale disconnected broadcasts cannot terminate a new negotiation', () => {
    const start = nativeSource.indexOf('WIFI_P2P_CONNECTION_CHANGED_ACTION -> {');
    const end = nativeSource.indexOf('WIFI_P2P_THIS_DEVICE_CHANGED_ACTION', start);
    const block = nativeSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(block).toContain('val hadActiveGroup = groupActive');
    expect(block).toContain('val connectionWasInProgress = connectionInProgress');
    expect(block).toContain('} else if (connectionWasInProgress) {');
    expect(block).toContain('the JS timeout/native watchdog remains the bounded failure authority');
    expect(block).toMatch(
      /else if \(connectionWasInProgress\) \{[\s\S]*?emitCurrentPeers\(\)[\s\S]*?\} else \{/
    );
    expect(block).toContain('} else if (hadActiveGroup) {');
    expect(block).toMatch(
      /else if \(hadActiveGroup\) \{[\s\S]*?sendEvent\("PEER_DISCONNECTED"/
    );
  });

  test('presence recovery is only scheduled for a real idle disconnect', () => {
    const start = nativeSource.indexOf('WIFI_P2P_CONNECTION_CHANGED_ACTION -> {');
    const end = nativeSource.indexOf('WIFI_P2P_THIS_DEVICE_CHANGED_ACTION', start);
    const block = nativeSource.slice(start, end);
    const pendingStart = block.indexOf('} else if (connectionWasInProgress) {');
    const activeDisconnectStart = block.indexOf('} else if (hadActiveGroup) {', pendingStart + 1);
    const pendingBlock = block.slice(pendingStart, activeDisconnectStart);
    const activeDisconnectBlock = block.slice(activeDisconnectStart);

    expect(pendingBlock).not.toContain('connectionInProgress = false');
    expect(pendingBlock).not.toContain('connectionGeneration++');
    expect(pendingBlock).not.toContain('scheduleActivePresenceRefresh');
    expect(activeDisconnectBlock).toContain('connectionInProgress = false');
    expect(activeDisconnectBlock).toContain('connectionGeneration++');
    expect(activeDisconnectBlock).toContain('scheduleActivePresenceRefresh(presenceGeneration, 600L)');
  });
});
