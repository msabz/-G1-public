const normalizeAddress = value => {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  return address || null;
};

const normalizeEpoch = value => (
  Number.isInteger(value) && value >= 0 ? value : null
);

export const createConnectionAddressTracker = () => {
  let latestEpoch = -1;
  let activeEpoch = null;
  let connectedPeerAddress = null;
  let identity = null;

  return {
    beginAttempt() {
      activeEpoch = null;
      connectedPeerAddress = null;
      identity = null;
    },

    activateConnection(epoch) {
      const nextEpoch = normalizeEpoch(epoch);
      if (nextEpoch === null) return false;
      if (nextEpoch < latestEpoch) return false;
      if (nextEpoch === latestEpoch) return activeEpoch === nextEpoch;

      latestEpoch = nextEpoch;
      activeEpoch = nextEpoch;
      connectedPeerAddress = null;
      identity = null;
      return true;
    },

    setConnectedPeerAddress(epoch, address) {
      if (activeEpoch !== normalizeEpoch(epoch)) return false;
      connectedPeerAddress = normalizeAddress(address);
      return connectedPeerAddress !== null;
    },

    setIdentity({ peerId, deviceName, targetPeer }) {
      identity = peerId ? {
        peerId,
        deviceName: deviceName || '',
        targetAddress: normalizeAddress(targetPeer?.deviceAddress),
      } : null;
    },

    resolvedPeer() {
      const deviceAddress = identity?.targetAddress || connectedPeerAddress;
      if (!identity || !deviceAddress) return null;
      return { ...identity, deviceAddress };
    },

    clear() {
      activeEpoch = null;
      connectedPeerAddress = null;
      identity = null;
    },
  };
};

export const saveResolvedPeerAddress = async (tracker, savePeerAddress) => {
  const peer = tracker.resolvedPeer();
  if (!peer) return false;
  await savePeerAddress(peer.peerId, peer.deviceAddress, peer.deviceName);
  return true;
};
