const {
  getPassiveLanPromotionPlan,
  isKnownLanRaceWinner,
  shouldAllowPassiveLanAdmission,
} = require('../src/network/passiveLanAppPolicy');

const { States, Tiers } = require('../src/utils/stateMachine');
const { TRANSPORTS } = require('../src/network/PeerRegistry');
const { CONTROL_PLANE_OWNERS } = require('../src/network/sessionDisconnectPlan');

function connectedLanCoordinator(deviceId = 'peer-1') {
  return {
    state: 'CONNECTED',
    peer: { deviceId, deviceName: 'Peer One' },
    transport: TRANSPORTS.LAN,
  };
}

function healthyInbound(peerAddress = '192.168.0.36') {
  return {
    connected: true,
    peerAddress,
    direction: 'inbound',
    passiveAdmissionAccepted: true,
  };
}

describe('passive LAN App policy', () => {
  test('promotes an admitted inbound LAN identity from idle without deriving identity from the IP', () => {
    expect(getPassiveLanPromotionPlan({
      message: { type: 'identity', deviceId: 'peer-1', deviceName: 'Peer One' },
      appState: States.IDLE,
      uiMounted: true,
      coordinatorStatus: connectedLanCoordinator(),
      signalingHealth: healthyInbound(),
    })).toEqual({
      peerId: 'peer-1',
      host: '192.168.0.36',
      transport: TRANSPORTS.LAN,
      controlOwner: CONTROL_PLANE_OWNERS.COORDINATOR,
      tier: Tiers.LAN,
      convergedPendingKnownLan: false,
    });
  });

  test('promotes the same peer when inbound wins a pending known-LAN outbound race', () => {
    expect(getPassiveLanPromotionPlan({
      message: { type: 'identity', deviceId: 'peer-1' },
      appState: States.WIFI_CONNECTING,
      uiMounted: true,
      pendingKnownLanPeerId: 'peer-1',
      coordinatorStatus: connectedLanCoordinator(),
      signalingHealth: healthyInbound('::ffff:192.168.0.36'),
    })).toEqual(expect.objectContaining({
      peerId: 'peer-1',
      host: '::ffff:192.168.0.36',
      convergedPendingKnownLan: true,
    }));
  });

  test('does not promote ordinary outbound LAN identity or an already-connected UI', () => {
    expect(getPassiveLanPromotionPlan({
      message: { type: 'identity', deviceId: 'peer-1' },
      appState: States.IDLE,
      uiMounted: true,
      coordinatorStatus: connectedLanCoordinator(),
      signalingHealth: { ...healthyInbound(), direction: 'outbound', passiveAdmissionAccepted: false },
    })).toBeNull();

    expect(getPassiveLanPromotionPlan({
      message: { type: 'identity', deviceId: 'peer-1' },
      appState: States.CONNECTED,
      uiMounted: true,
      coordinatorStatus: connectedLanCoordinator(),
      signalingHealth: healthyInbound(),
    })).toBeNull();
  });

  test('does not promote mismatched peers, non-LAN coordinator ownership, or unhealthy sessions', () => {
    expect(getPassiveLanPromotionPlan({
      message: { type: 'identity', deviceId: 'peer-2' },
      appState: States.IDLE,
      uiMounted: true,
      coordinatorStatus: connectedLanCoordinator('peer-1'),
      signalingHealth: healthyInbound(),
    })).toBeNull();

    expect(getPassiveLanPromotionPlan({
      message: { type: 'identity', deviceId: 'peer-1' },
      appState: States.IDLE,
      uiMounted: true,
      coordinatorStatus: { ...connectedLanCoordinator(), transport: TRANSPORTS.P2P },
      signalingHealth: healthyInbound(),
    })).toBeNull();

    expect(getPassiveLanPromotionPlan({
      message: { type: 'identity', deviceId: 'peer-1' },
      appState: States.IDLE,
      uiMounted: true,
      coordinatorStatus: connectedLanCoordinator(),
      signalingHealth: { ...healthyInbound(), connected: false },
    })).toBeNull();
  });

  test('allows passive admission only while idle/disconnected or for the exact pending known-LAN peer', () => {
    expect(shouldAllowPassiveLanAdmission({
      uiMounted: true,
      appState: States.IDLE,
      messageDeviceId: 'peer-1',
    })).toBe(true);

    expect(shouldAllowPassiveLanAdmission({
      uiMounted: true,
      appState: States.DISCONNECTED,
      messageDeviceId: 'peer-1',
    })).toBe(true);

    expect(shouldAllowPassiveLanAdmission({
      uiMounted: true,
      appState: States.WIFI_CONNECTING,
      pendingKnownLanPeerId: 'peer-1',
      messageDeviceId: 'peer-1',
    })).toBe(true);

    expect(shouldAllowPassiveLanAdmission({
      uiMounted: true,
      appState: States.WIFI_CONNECTING,
      pendingKnownLanPeerId: null,
      messageDeviceId: 'peer-1',
    })).toBe(false);

    expect(shouldAllowPassiveLanAdmission({
      uiMounted: true,
      appState: States.CONNECTED,
      messageDeviceId: 'peer-1',
    })).toBe(false);

    // Once the React UI detaches, stale view state must not permanently block
    // a fresh trusted LAN session; coordinator/session ownership becomes the
    // authoritative guard in the admission handler.
    expect(shouldAllowPassiveLanAdmission({
      uiMounted: false,
      appState: States.CONNECTED,
      messageDeviceId: 'peer-1',
    })).toBe(true);
  });

  test('recognizes only a healthy connected coordinator session for the target as a race winner', () => {
    expect(isKnownLanRaceWinner({
      targetDeviceId: 'peer-1',
      coordinatorStatus: connectedLanCoordinator(),
      signalingHealth: healthyInbound(),
    })).toBe(true);

    expect(isKnownLanRaceWinner({
      targetDeviceId: 'peer-2',
      coordinatorStatus: connectedLanCoordinator(),
      signalingHealth: healthyInbound(),
    })).toBe(false);

    expect(isKnownLanRaceWinner({
      targetDeviceId: 'peer-1',
      coordinatorStatus: connectedLanCoordinator(),
      signalingHealth: { ...healthyInbound(), connected: false },
    })).toBe(false);
  });
});
