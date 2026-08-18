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

  return {
    disconnectViaCoordinator: controlOwner === CONTROL_PLANE_OWNERS.COORDINATOR,
    cleanupWifiDirect,
    attemptLegacyWifiDirectReconnect: unexpected && cleanupWifiDirect,
  };
}

export default getSessionDisconnectPlan;
