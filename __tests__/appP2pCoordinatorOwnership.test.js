import fs from 'fs';
import path from 'path';

describe('App outbound P2P coordinator ownership wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.js'), 'utf8');

  test('imports and uses the P2P App bridge for outbound peers with stable identity', () => {
    expect(source).toContain('connectP2pFromApp,');
    expect(source).toContain('resolveStableP2pDeviceId,');
    expect(source).toContain('shouldYieldNativeP2pEvent,');
    expect(source).toContain("} from './network/p2pAppBridge';");
    expect(source).toContain(
      'const stableDeviceId = incoming ? null : resolveStableP2pDeviceId(selected, selected);'
    );
    expect(source).toContain('const result = await connectP2pFromApp({');
    expect(source).toContain(
      'activeControlOwnerRef.current = CONTROL_PLANE_OWNERS.COORDINATOR;'
    );
  });

  test('keeps incoming/identity-unproven peers on the legacy branch for this slice', () => {
    expect(source).toContain('const stableDeviceId = incoming ? null');
    expect(source).toContain(
      '// Incoming invitations and peers without a provable stable G1 identity stay'
    );
    expect(source).toContain('DirectConnection.connectToPeer(selected.deviceAddress),');
    expect(source).toContain('nativeDeadline');
  });

  test('legacy PEER_CONNECTED handler yields while coordinator owns P2P negotiation', () => {
    expect(source).toContain('shouldYieldNativeP2pEvent({');
    expect(source).toContain('coordinatorP2pAttemptActive: !!coordinatorP2pAttemptRef.current');
    expect(source).toContain('const coordinatorStatus = connectionCoordinator.getCoordinatorStatus();');
  });

  test('correlates legacy native callbacks with the exact connection epoch', () => {
    expect(source).toContain("const LEGACY_P2P_EPOCH_PENDING = 'PENDING';");
    expect(source).toContain('const legacyP2pEarlyConnectedInfoRef = useRef(new Map());');
    expect(source).toContain('legacyP2pExpectedEpochRef.current = LEGACY_P2P_EPOCH_PENDING;');
    expect(source).toContain('const connectionEpoch = Number(nativeAttempt?.connectionEpoch);');
    expect(source).toContain('legacyP2pEarlyConnectedInfoRef.current.get(connectionEpoch)');
    expect(source).toMatch(
      /Number\.isInteger\(expectedEpoch\)[\s\S]{0,180}?eventEpoch !== expectedEpoch/
    );
  });

  test('passes fallback cancellation ownership through the whole P2P activation tail', () => {
    expect(source).toContain('{ incoming = false, attemptContext = null }');
    expect(source).toContain('const ensureAttemptCurrent = () => attemptContext?.throwIfCancelled?.();');
    expect(source).toContain('beginWifiNegotiation(selected, { attemptContext })');
    expect(source).toContain('cancelOwnedCoordinatorStep(');
    expect(source).toContain('p2pTimeoutMs: 40000');
  });

  test('concurrent App connection entry points yield while outbound coordinator P2P is active', () => {
    expect(source).toMatch(
      /const maybeAnswerIncomingInvitation = peers => \{[\s\S]*?if \(coordinatorP2pAttemptRef\.current\) \{\s*return;\s*\}/
    );
    expect(source).toMatch(
      /const handleConnectLan = async \(ip, port = 8089\) => \{[\s\S]*?if \(coordinatorP2pAttemptRef\.current\)/
    );
    expect(source).toMatch(
      /const btConnect = async (?:\([^)]*\)|\w+) => \{[\s\S]*?if \(coordinatorP2pAttemptRef\.current\)/
    );
  });

  test('coordinator-owned P2P teardown avoids App native cleanup ownership', () => {
    expect(source).toContain(
      'if (plan.cleanupWifiDirect && !plan.disconnectViaCoordinator) {'
    );
    expect(source).toContain('const clean = await waitForCoordinatorP2pCleanup(10000);');
  });
});
