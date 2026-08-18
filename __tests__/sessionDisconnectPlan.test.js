import { TRANSPORTS } from '../src/network/PeerRegistry';
import {
  CONTROL_PLANE_OWNERS,
  getSessionDisconnectPlan,
} from '../src/network/sessionDisconnectPlan';

describe('session disconnect planning', () => {
  test('known LAN uses coordinator control ownership without Wi-Fi Direct cleanup or legacy reconnect', () => {
    expect(getSessionDisconnectPlan({
      transport: TRANSPORTS.LAN,
      controlOwner: CONTROL_PLANE_OWNERS.COORDINATOR,
      unexpected: true,
    })).toEqual({
      disconnectViaCoordinator: true,
      cleanupWifiDirect: false,
      attemptLegacyWifiDirectReconnect: false,
    });
  });

  test('manual LAN keeps legacy signaling ownership but still avoids Wi-Fi Direct cleanup', () => {
    expect(getSessionDisconnectPlan({
      transport: TRANSPORTS.LAN,
      controlOwner: CONTROL_PLANE_OWNERS.LEGACY_APP,
      unexpected: true,
    })).toEqual({
      disconnectViaCoordinator: false,
      cleanupWifiDirect: false,
      attemptLegacyWifiDirectReconnect: false,
    });
  });

  test('legacy Wi-Fi Direct retains transport cleanup and app-level reconnect only for unexpected loss', () => {
    expect(getSessionDisconnectPlan({
      transport: TRANSPORTS.P2P,
      controlOwner: CONTROL_PLANE_OWNERS.LEGACY_APP,
      unexpected: true,
    })).toEqual({
      disconnectViaCoordinator: false,
      cleanupWifiDirect: true,
      attemptLegacyWifiDirectReconnect: true,
    });

    expect(getSessionDisconnectPlan({
      transport: TRANSPORTS.P2P,
      controlOwner: CONTROL_PLANE_OWNERS.LEGACY_APP,
      unexpected: false,
    }).attemptLegacyWifiDirectReconnect).toBe(false);
  });

  test('future non-P2P coordinator transport does not inherit Wi-Fi Direct teardown semantics', () => {
    expect(getSessionDisconnectPlan({
      transport: 'I2P',
      controlOwner: CONTROL_PLANE_OWNERS.COORDINATOR,
      unexpected: true,
    })).toEqual({
      disconnectViaCoordinator: true,
      cleanupWifiDirect: false,
      attemptLegacyWifiDirectReconnect: false,
    });
  });
});
