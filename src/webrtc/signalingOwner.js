import {
  addSignalingDisconnectObserver,
  cancelSignalingConnectAttempt,
  closeSignaling,
  connectToSignalingServer,
  getActiveSession,
  sendSignalingMessage,
} from './signaling';

/**
 * Thin adapter that exposes the live signaling runtime through the ownership
 * contract expected by ConnectionCoordinator. It intentionally contains no
 * recovery, heartbeat, socket, or logical-peer state of its own.
 */
export const signalingOwner = {
  connectOutbound({
    host,
    port,
    maxRetries = 10,
    retryDelayMs = 800,
  }) {
    return connectToSignalingServer(host, port, maxRetries, retryDelayMs);
  },

  cancelConnect(reason) {
    return cancelSignalingConnectAttempt(reason);
  },

  getActiveSession() {
    return getActiveSession();
  },

  sendMessage(message) {
    return sendSignalingMessage(message);
  },

  disconnect() {
    return closeSignaling();
  },

  subscribeDisconnect(observer) {
    return addSignalingDisconnectObserver(observer);
  },
};

export default signalingOwner;
