import {
  addSignalingDisconnectObserver,
  addSignalingMessageObserver,
  cancelSignalingConnectAttempt,
  closeSignaling,
  connectToSignalingServer,
  createSignalingServer,
  getActiveSession,
  sendSignalingMessage,
  waitForClientConnection,
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

  async acceptInbound({ port = 8089, timeoutMs = 30000 } = {}) {
    await createSignalingServer(port);
    await waitForClientConnection(timeoutMs);
    return getActiveSession();
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

  subscribeMessage(observer) {
    return addSignalingMessageObserver(observer);
  },

  subscribeDisconnect(observer) {
    return addSignalingDisconnectObserver(observer);
  },
};

export default signalingOwner;
