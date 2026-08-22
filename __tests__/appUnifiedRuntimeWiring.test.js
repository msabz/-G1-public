import fs from 'fs';
import path from 'path';

describe('App unified runtime wiring', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.js'), 'utf8');
  const chatSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'ChatScreen.js'),
    'utf8'
  );

  test('keeps Bluetooth discovery independent from camera and microphone permissions', () => {
    expect(appSource).toContain('async function requestBluetoothPerms()');
    expect(appSource).toMatch(
      /const btScan = async \(\) => \{[\s\S]*?await requestBluetoothPerms\(\)/
    );
  });

  test('uses bounded unified selection and automatic alternate transport fallback', () => {
    expect(appSource).toContain('connectionCoordinator.connectPeer(selectionPeer, {');
    expect(appSource).toContain('excludeTransports: [...excludedTransports]');
    expect(appSource).toContain('automaticFailoverCountRef.current >= 2');
    expect(appSource).toContain('attemptAlternateTransport(failedPeer, TRANSPORTS.BLUETOOTH)');
  });

  test('routes planned Bluetooth changes through make-before-break and stable identity rebind', () => {
    expect(appSource).toContain(
      'connectionCoordinator.handoverPeer(peer, TRANSPORTS.BLUETOOTH, {'
    );
    expect(appSource).toContain('connectionCoordinator.rebindConnectedPeer(stablePeer, {');
    expect(appSource).toContain('releaseLegacyIpTransportForBluetooth(previousTransport)');
    expect(appSource).toContain("String(contact?.btAddress || '').trim().toUpperCase() === address");
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
