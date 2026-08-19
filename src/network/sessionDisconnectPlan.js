import { requiresWifiDirectCleanup } from './sessionCleanupPolicy';

export const CONTROL_PLANE_OWNERS = {
  COORDINATOR: 'COORDINATOR',
  LEGACY_APP: 'LEGACY_APP',
};

/**
 * Keep transport teardown separate from signaling-session ownership.
 * The returned plan is intentionally side-effect free so App can execute it
 * without re-introducing ownership decisions into UI conditionals.
 */
export function getSessionDisconnectPlan({
  transport = null,
  controlOwner = CONTROL_PLANE_OWNERS.LEGACY_APP,
  unexpected = false,
} = {}) {
  const cleanupWifiDirect = requiresWifiDirectCleanup(transport);
  const coordinatorOwned = controlOwner === CONTROL_PLANE_OWNERS.COORDINATOR;

  return {
    disconnectViaCoordinator: coordinatorOwned,
    cleanupWifiDirect,
    // Once the coordinator owns a P2P session, reconnect/recovery must stay
    // behind that ownership boundary. Falling back to App's legacy signaling
    // reconnect would create two control-plane owners for the same route.
    attemptLegacyWifiDirectReconnect: unexpected && cleanupWifiDirect && !coordinatorOwned,
  };
}

export default getSessionDisconnectPlan;
