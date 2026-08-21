jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import TcpSocket from 'react-native-tcp-socket';
import {
  ConnectionCoordinator,
  COORDINATOR_STATE,
} from '../src/network/ConnectionCoordinator';
import { IDENTITY_TRUST, IDENTITY_SOURCE } from '../src/network/IdentityModel';
import { peerRegistry, TRANSPORTS } from '../src/network/PeerRegistry';

function makeOwner(overrides = {}) {
  const session = {
    isConnected: true,
    isOutbound: true,
    sendMessage: jest.fn(),
    destroy: jest.fn(),
  };
  let disconnectObserver = null;
  return {
    session,
    connectOutbound: jest.fn().mockResolvedValue(undefined),
    acceptInbound: jest.fn().mockImplementation(async () => {
      session.isOutbound = false;
      return session;
    }),
    cancelConnect: jest.fn(),
    getActiveSession: jest.fn(() => session),
    sendMessage: jest.fn().mockReturnValue(true),
    disconnect: jest.fn(),
    subscribeDisconnect: jest.fn(observer => {
      disconnectObserver = observer;
      return { remove: jest.fn() };
    }),
    emitDisconnect() {
      disconnectObserver?.({ reason: 'test-disconnect' });
    },
    ...overrides,
  };
}

function makeP2pAdapter(route, overrides = {}) {
  return {
    setIdentity: jest.fn(),
    connectPeer: jest.fn().mockResolvedValue(route),
    cancelConnect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue({ clean: true }),
    getStatus: jest.fn(() => ({ state: 'READY', activeRoute: route })),
    ...overrides,
  };
}

function makeAuthenticator(deviceId = 'peer-device', overrides = {}) {
  const proven = {
    deviceId,
    userId: 'b'.repeat(64),
    g1Number: 'G1-PROVEN',
    displayName: 'Proven peer',
    keyFingerprint: 'fingerprint',
    trust: IDENTITY_TRUST.SESSION_PROVEN,
    source: IDENTITY_SOURCE.SESSION_PROOF,
  };
  return {
    proven,
    setSignalingOwner: jest.fn(),
    setLocalDeviceIdentity: jest.fn(),
    authenticatePeer: jest.fn().mockResolvedValue(proven),
    cancelAuthentication: jest.fn(),
    stop: jest.fn(),
    ...overrides,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ConnectionCoordinator Wi-Fi Direct ownership', () => {
  afterEach(() => {
    peerRegistry.clear();
    jest.clearAllMocks();
  });

  test('holds P2P at AUTHENTICATING until cryptographic proof succeeds', async () => {
    const owner = makeOwner();
    const p2pAdapter = makeP2pAdapter({
      transport: TRANSPORTS.P2P,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
      connectionEpoch: 11,
      bound: true,
    });
    let resolveAuth;
    const authenticator = makeAuthenticator('peer-device');
    authenticator.authenticatePeer = jest.fn(() => new Promise(resolve => {
      resolveAuth = resolve;
    }));
    const onConnected = jest.fn();
    const states = [];
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      myDeviceName: 'Self phone',
      signalingOwner: owner,
      identityAuthenticator: authenticator,
      p2pAdapter,
      onConnected,
      onStateChange: state => states.push(state),
    });
    const peer = {
      deviceId: 'peer-device',
      deviceName: 'Peer phone',
      userId: 'b'.repeat(64),
      transports: {
        P2P: { deviceAddress: 'AA:BB:CC:DD:EE:FF' },
      },
    };
    const expectedIdentity = {
      deviceId: 'peer-device',
      userId: 'b'.repeat(64),
      g1Number: 'G1-PROVEN',
    };

    const attempt = coordinator.connectP2pPeer(peer, 12000, {
      port: 8089,
      maxRetries: 4,
      retryDelayMs: 700,
      expectedIdentity,
    });
    await flushMicrotasks();

    expect(coordinator.state).toBe(COORDINATOR_STATE.AUTHENTICATING);
    expect(onConnected).not.toHaveBeenCalled();
    expect(owner.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'identity' }));
    expect(authenticator.authenticatePeer).toHaveBeenCalledWith({
      expectedIdentity,
      timeoutMs: 12000,
    });

    resolveAuth(authenticator.proven);
    const session = await attempt;

    expect(p2pAdapter.connectPeer).toHaveBeenCalledWith(peer, {
      timeoutMs: 12000,
      incoming: false,
    });
    expect(owner.connectOutbound).toHaveBeenCalledWith({
      host: '192.168.49.1',
      port: 8089,
      maxRetries: 4,
      retryDelayMs: 700,
      timeoutMs: 12000,
    });
    expect(owner.acceptInbound).not.toHaveBeenCalled();
    expect(owner.sendMessage).toHaveBeenCalledWith({
      type: 'identity',
      deviceId: 'self-device',
      deviceName: 'Self phone',
    });
    expect(TcpSocket.createConnection).not.toHaveBeenCalled();
    expect(session).toBe(owner.session);
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(coordinator.currentTransport).toBe(TRANSPORTS.P2P);
    expect(coordinator.provenIdentity).toBe(authenticator.proven);
    expect(coordinator.activeSessionManagedExternally).toBe(true);
    expect(coordinator.heartbeatInterval).toBeNull();
    expect(onConnected).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'peer-device', identityTrust: IDENTITY_TRUST.SESSION_PROVEN }),
      TRANSPORTS.P2P
    );
    expect(states).toEqual(expect.arrayContaining([
      COORDINATOR_STATE.CONNECTING,
      COORDINATOR_STATE.AUTHENTICATING,
      COORDINATOR_STATE.CONNECTED,
    ]));
  });

  test('group owner authenticates the inbound signaling session before promotion', async () => {
    const owner = makeOwner();
    const p2pAdapter = makeP2pAdapter({
      transport: TRANSPORTS.P2P,
      isGroupOwner: true,
      groupOwnerAddress: null,
      connectionEpoch: 12,
      bound: true,
    });
    const authenticator = makeAuthenticator('peer-device');
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
      identityAuthenticator: authenticator,
      p2pAdapter,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };

    await coordinator.connectP2pPeer(peer, 9000, { signalingTimeoutMs: 15000 });

    expect(owner.acceptInbound).toHaveBeenCalledWith({ port: 8089, timeoutMs: 15000 });
    expect(owner.connectOutbound).not.toHaveBeenCalled();
    expect(authenticator.authenticatePeer).toHaveBeenCalledTimes(1);
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(coordinator.currentTransport).toBe(TRANSPORTS.P2P);
  });

  test('cancelling a pending P2P attempt tears down route/signaling without authentication or promotion', async () => {
    let rejectRoute;
    const p2pAdapter = makeP2pAdapter(null, {
      connectPeer: jest.fn(() => new Promise((_resolve, reject) => {
        rejectRoute = reject;
      })),
    });
    p2pAdapter.cancelConnect.mockImplementation(() => {
      rejectRoute?.(new Error('cancelled'));
      return Promise.resolve(true);
    });
    const owner = makeOwner();
    const authenticator = makeAuthenticator('peer-device');
    const onConnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
      identityAuthenticator: authenticator,
      p2pAdapter,
      onConnected,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: '11:22:33:44:55:66' } },
    };

    const attempt = coordinator.connectP2pPeer(peer, 9000);
    await flushMicrotasks();
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTING);

    coordinator.cancelConnecting();
    await expect(attempt).resolves.toBeUndefined();

    expect(p2pAdapter.cancelConnect).toHaveBeenCalledTimes(1);
    expect(owner.cancelConnect).toHaveBeenCalledTimes(1);
    expect(owner.disconnect).toHaveBeenCalledTimes(1);
    expect(authenticator.authenticatePeer).not.toHaveBeenCalled();
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(coordinator.currentPeer).toBeNull();
    expect(coordinator.currentTransport).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
  });

  test('signaling failure after group formation cleans P2P and never starts authentication', async () => {
    const failure = new Error('signaling refused');
    const owner = makeOwner({
      connectOutbound: jest.fn().mockRejectedValue(failure),
    });
    const p2pAdapter = makeP2pAdapter({
      transport: TRANSPORTS.P2P,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
    });
    const authenticator = makeAuthenticator('peer-device');
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
      identityAuthenticator: authenticator,
      p2pAdapter,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: 'AA:AA:AA:AA:AA:AA' } },
    };

    await expect(coordinator.connectP2pPeer(peer, 7000)).rejects.toBe(failure);

    expect(authenticator.authenticatePeer).not.toHaveBeenCalled();
    expect(owner.disconnect).toHaveBeenCalledTimes(1);
    expect(p2pAdapter.disconnect).toHaveBeenCalledTimes(1);
    expect(coordinator.state).toBe(COORDINATOR_STATE.ERROR);
    expect(coordinator.activeSession).toBeNull();
  });

  test('authentication failure closes signaling and P2P without onConnected promotion', async () => {
    const owner = makeOwner();
    const p2pAdapter = makeP2pAdapter({
      transport: TRANSPORTS.P2P,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
    });
    const authenticator = makeAuthenticator('peer-device', {
      authenticatePeer: jest.fn().mockRejectedValue(new Error('USER_ID_MISMATCH')),
    });
    const onConnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
      identityAuthenticator: authenticator,
      p2pAdapter,
      onConnected,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: 'AA:BB:CC:00:00:09' } },
    };

    await expect(coordinator.connectP2pPeer(peer, 7000)).rejects.toThrow('USER_ID_MISMATCH');

    expect(owner.disconnect).toHaveBeenCalledTimes(1);
    expect(p2pAdapter.disconnect).toHaveBeenCalledTimes(1);
    expect(authenticator.cancelAuthentication).toHaveBeenCalled();
    expect(coordinator.provenIdentity).toBeNull();
    expect(coordinator.state).toBe(COORDINATOR_STATE.ERROR);
    expect(onConnected).not.toHaveBeenCalled();
  });

  test('terminal signaling loss releases the authenticated P2P group', async () => {
    const owner = makeOwner();
    const p2pAdapter = makeP2pAdapter({
      transport: TRANSPORTS.P2P,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
    });
    const authenticator = makeAuthenticator('peer-device');
    const onDisconnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
      identityAuthenticator: authenticator,
      p2pAdapter,
      onDisconnected,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: 'AA:BB:CC:00:00:01' } },
    };

    await coordinator.connectP2pPeer(peer, 7000);
    owner.emitDisconnect();
    await flushMicrotasks();

    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(coordinator.activeSession).toBeNull();
    expect(coordinator.provenIdentity).toBeNull();
    expect(p2pAdapter.disconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'peer-device' }));
  });

  test('explicit disconnect closes signaling and P2P transport exactly through their owners', async () => {
    const owner = makeOwner();
    const p2pAdapter = makeP2pAdapter({
      transport: TRANSPORTS.P2P,
      isGroupOwner: false,
      groupOwnerAddress: '192.168.49.1',
    });
    const authenticator = makeAuthenticator('peer-device');
    const coordinator = new ConnectionCoordinator({
      myDeviceId: 'self-device',
      signalingOwner: owner,
      identityAuthenticator: authenticator,
      p2pAdapter,
    });
    const peer = {
      deviceId: 'peer-device',
      transports: { P2P: { deviceAddress: 'AA:BB:CC:00:00:02' } },
    };

    await coordinator.connectP2pPeer(peer, 7000);
    coordinator.disconnect();
    await flushMicrotasks();

    expect(owner.disconnect).toHaveBeenCalledTimes(1);
    expect(p2pAdapter.disconnect).toHaveBeenCalledTimes(1);
    expect(owner.session.destroy).not.toHaveBeenCalled();
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
  });

  test('P2P adapter and identity authenticator receive stable local device identity', () => {
    const first = makeP2pAdapter(null);
    const second = makeP2pAdapter(null);
    const authenticator = makeAuthenticator('peer-device');
    const coordinator = new ConnectionCoordinator();

    coordinator.setIdentityAuthenticator(authenticator);
    coordinator.setP2pAdapter(first);
    coordinator.setIdentity({ deviceId: 'self-device', deviceName: 'Self phone' });

    expect(first.setIdentity).toHaveBeenCalledWith({
      deviceId: 'self-device',
      deviceName: 'Self phone',
    });
    expect(authenticator.setLocalDeviceIdentity).toHaveBeenCalledWith({
      deviceId: 'self-device',
      deviceName: 'Self phone',
    });
    expect(() => coordinator.setP2pAdapter(second)).not.toThrow();
    expect(second.setIdentity).toHaveBeenCalledWith({
      deviceId: 'self-device',
      deviceName: 'Self phone',
    });
  });
});
