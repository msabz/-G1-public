jest.mock("react-native-tcp-socket", () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import {
  ConnectionCoordinator,
  COORDINATOR_STATE,
  TransportTransitionLimitError,
} from "../src/network/ConnectionCoordinator";
import { TRANSPORTS } from "../src/network/PeerRegistry";
import {
  TransportFallbackEngine,
  TRANSPORT_MODE,
} from "../src/network/TransportFallbackEngine";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePeer(transports = {}) {
  return {
    deviceId: "peer-device",
    deviceName: "Peer phone",
    transports,
  };
}

function makeBluetoothAdapter(overrides = {}) {
  const session = { id: "bt-session", isConnected: true };
  return {
    session,
    setIdentity: jest.fn(),
    connectPeer: jest.fn().mockResolvedValue(session),
    cancelConnect: jest.fn(),
    disconnect: jest.fn().mockResolvedValue(undefined),
    discardConnection: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockReturnValue(true),
    subscribeDisconnect: jest.fn(() => ({ remove: jest.fn() })),
    getStatus: jest.fn(() => ({ state: "READY" })),
    ...overrides,
  };
}

function makeSignalingOwner() {
  const session = { id: "lan-session", isConnected: true };
  return {
    session,
    connectOutbound: jest.fn().mockResolvedValue(undefined),
    cancelConnect: jest.fn(),
    getActiveSession: jest.fn(() => session),
    sendMessage: jest.fn().mockReturnValue(true),
    disconnect: jest.fn(),
    subscribeDisconnect: jest.fn(() => ({ remove: jest.fn() })),
  };
}

describe("ConnectionCoordinator unified transport ownership", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test("uses the injected Bluetooth adapter contract and routes session operations through it", async () => {
    const bluetoothAdapter = makeBluetoothAdapter();
    const coordinator = new ConnectionCoordinator({
      myDeviceId: "self-device",
      bluetoothAdapter,
    });
    const peer = makePeer({
      BLUETOOTH: { address: "AA:BB:CC:DD:EE:FF" },
    });

    const session = await coordinator.connectBluetoothPeer(peer, 4200);

    expect(session).toBe(bluetoothAdapter.session);
    expect(bluetoothAdapter.connectPeer).toHaveBeenCalledTimes(1);
    expect(bluetoothAdapter.connectPeer).toHaveBeenCalledWith(peer, {
      address: "AA:BB:CC:DD:EE:FF",
      timeoutMs: 4200,
      attemptToken: expect.objectContaining({
        peerId: "peer-device",
        transport: TRANSPORTS.BLUETOOTH,
        attemptId: 1,
      }),
    });
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(coordinator.currentTransport).toBe(TRANSPORTS.BLUETOOTH);

    const message = { type: "chat", text: "hello" };
    expect(coordinator.sendMessage(message)).toBe(true);
    expect(bluetoothAdapter.sendMessage).toHaveBeenCalledWith(message, session);

    coordinator.disconnect();
    expect(bluetoothAdapter.disconnect).toHaveBeenCalledWith(session, {
      reason: "explicit-disconnect",
    });
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
  });

  test("connectPeer is the unified intent seam backed by the attached fallback policy", async () => {
    const bluetoothAdapter = makeBluetoothAdapter();
    const coordinator = new ConnectionCoordinator({ bluetoothAdapter });
    new TransportFallbackEngine({
      coordinator,
      mode: TRANSPORT_MODE.AUTO,
    });
    const peer = makePeer({
      BLUETOOTH: { address: "AA:BB:CC:DD:EE:10" },
    });

    await expect(coordinator.connectPeer(peer)).resolves.toEqual({
      transport: TRANSPORTS.BLUETOOTH,
      result: bluetoothAdapter.session,
    });
    expect(bluetoothAdapter.connectPeer).toHaveBeenCalledTimes(1);
  });

  test("failed route cleanup can preserve the active fallback selection", () => {
    const coordinator = new ConnectionCoordinator();
    const cancel = jest.fn();
    coordinator.fallbackEngine = { cancel };
    coordinator.state = COORDINATOR_STATE.ERROR;
    coordinator.currentPeer = makePeer({
      LAN: { host: "192.168.0.36", port: 8089 },
      P2P: { deviceAddress: "02:00:00:00:00:36" },
    });
    coordinator.currentTransport = TRANSPORTS.LAN;

    coordinator.disconnect({ preserveFallback: true });

    expect(cancel).not.toHaveBeenCalled();
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(coordinator.currentPeer).toBeNull();
    expect(coordinator.currentTransport).toBeNull();
  });

  test("a failed LAN handler can clean its route and continue to P2P", async () => {
    const coordinator = new ConnectionCoordinator();
    new TransportFallbackEngine({ coordinator });
    const peer = makePeer({
      LAN: { host: "192.168.0.36", port: 8089 },
      P2P: { deviceAddress: "02:00:00:00:00:36" },
    });
    const connectP2p = jest.fn().mockResolvedValue({ route: "p2p" });
    const connectLan = jest.fn(async () => {
      coordinator.state = COORDINATOR_STATE.ERROR;
      coordinator.currentPeer = peer;
      coordinator.currentTransport = TRANSPORTS.LAN;
      coordinator.disconnect({ preserveFallback: true });
      throw new Error("ECONNREFUSED");
    });

    await expect(coordinator.connectPeer(peer, {
      handlers: { connectLan, connectP2p },
    })).resolves.toEqual({
      transport: TRANSPORTS.P2P,
      result: { route: "p2p" },
    });
    expect(connectLan).toHaveBeenCalledTimes(1);
    expect(connectP2p).toHaveBeenCalledTimes(1);
  });

  test("coalesces duplicate Bluetooth attempts and reuses the connected session", async () => {
    const pendingConnection = deferred();
    const bluetoothAdapter = makeBluetoothAdapter({
      connectPeer: jest.fn(() => pendingConnection.promise),
    });
    const coordinator = new ConnectionCoordinator({ bluetoothAdapter });
    const peer = makePeer({
      BLUETOOTH: { address: "AA:BB:CC:DD:EE:01" },
    });

    const first = coordinator.connectBluetoothPeer(peer, 5000);
    const duplicate = coordinator.connectBluetoothPeer(peer, 5000);

    expect(duplicate).toBe(first);
    expect(bluetoothAdapter.connectPeer).toHaveBeenCalledTimes(1);

    pendingConnection.resolve(bluetoothAdapter.session);
    await expect(first).resolves.toBe(bluetoothAdapter.session);
    await expect(duplicate).resolves.toBe(bluetoothAdapter.session);

    await expect(coordinator.connectBluetoothPeer(peer, 5000)).resolves.toBe(
      bluetoothAdapter.session
    );
    expect(bluetoothAdapter.connectPeer).toHaveBeenCalledTimes(1);
  });

  test("rebinds a provisional Bluetooth identity without replacing its live session", async () => {
    const bluetoothAdapter = makeBluetoothAdapter();
    const coordinator = new ConnectionCoordinator({ bluetoothAdapter });
    const provisional = {
      deviceId: "bluetooth:AA:BB:CC:DD:EE:11",
      deviceName: "Paired phone",
      transports: {
        BLUETOOTH: { address: "AA:BB:CC:DD:EE:11" },
      },
    };
    await coordinator.connectBluetoothPeer(provisional, 5000);
    const session = coordinator.activeSession;
    const generation = coordinator.generation;
    const stable = {
      deviceId: "stable-g1-peer",
      deviceName: "Stable phone",
      transports: {
        LAN: { host: "192.168.0.77", port: 8089 },
      },
    };

    const rebound = coordinator.rebindConnectedPeer(stable, {
      expectedDeviceId: provisional.deviceId,
    });

    expect(rebound.deviceId).toBe(stable.deviceId);
    expect(rebound.transports.BLUETOOTH.address).toBe("AA:BB:CC:DD:EE:11");
    expect(rebound.transports.LAN.host).toBe("192.168.0.77");
    expect(coordinator.activeSession).toBe(session);
    expect(coordinator.generation).toBe(generation);
    expect(coordinator.currentTransport).toBe(TRANSPORTS.BLUETOOTH);
    expect(() => coordinator.rebindConnectedPeer(
      { deviceId: "another-peer" },
      { expectedDeviceId: provisional.deviceId },
    )).toThrow("Connected peer changed before identity rebind");
  });

  test("promotes the adapter-authenticated peer before publishing Bluetooth connected state", async () => {
    const provisional = {
      deviceId: "bluetooth:AA:BB:CC:DD:EE:12",
      deviceName: "Discovered phone",
      transports: {
        BLUETOOTH: { address: "AA:BB:CC:DD:EE:12" },
      },
    };
    const authenticated = {
      ...provisional,
      deviceId: "stable-authenticated-peer",
    };
    const route = {
      transport: TRANSPORTS.BLUETOOTH,
      address: "AA:BB:CC:DD:EE:12",
      remoteNodeId: authenticated.deviceId,
      peer: authenticated,
    };
    const bluetoothAdapter = makeBluetoothAdapter({
      connectPeer: jest.fn().mockResolvedValue(route),
    });
    const onConnected = jest.fn();
    const coordinator = new ConnectionCoordinator({ bluetoothAdapter, onConnected });

    await expect(coordinator.connectBluetoothPeer(provisional, 5000)).resolves.toBe(route);

    expect(coordinator.currentPeer).toBe(authenticated);
    expect(coordinator.getCoordinatorStatus().peer.deviceId).toBe(authenticated.deviceId);
    expect(onConnected).toHaveBeenCalledWith(authenticated, TRANSPORTS.BLUETOOTH);
  });

  test("rejects a second inbound session instead of replacing the active peer session", async () => {
    const bluetoothAdapter = makeBluetoothAdapter();
    const coordinator = new ConnectionCoordinator({ bluetoothAdapter });
    const peer = makePeer({
      BLUETOOTH: { address: "AA:BB:CC:DD:EE:09" },
    });
    await coordinator.connectBluetoothPeer(peer, 5000);
    const socket = { destroy: jest.fn() };

    expect(
      coordinator.handleIncomingSession(socket, {
        deviceId: "different-peer",
        transport: TRANSPORTS.LAN,
      })
    ).toBe(false);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(coordinator.currentPeer).toBe(peer);
    expect(coordinator.activeSession).toBe(bluetoothAdapter.session);
  });

  test("a cancelled attempt token cannot promote a late Bluetooth result", async () => {
    const pendingConnection = deferred();
    const bluetoothAdapter = makeBluetoothAdapter({
      connectPeer: jest.fn(() => pendingConnection.promise),
    });
    const onConnected = jest.fn();
    const coordinator = new ConnectionCoordinator({
      bluetoothAdapter,
      onConnected,
    });
    const peer = makePeer({
      BLUETOOTH: { address: "AA:BB:CC:DD:EE:02" },
    });

    const attempt = coordinator.connectBluetoothPeer(peer, 5000);
    const token = coordinator.getCoordinatorStatus().pendingAttempt.token;
    coordinator.cancelConnecting();
    pendingConnection.resolve(bluetoothAdapter.session);

    await expect(attempt).resolves.toBeUndefined();
    expect(bluetoothAdapter.cancelConnect).toHaveBeenCalledWith({
      attemptToken: token,
      reason: "Coordinator cancelled Bluetooth connect",
    });
    expect(bluetoothAdapter.discardConnection).toHaveBeenCalledWith(
      bluetoothAdapter.session,
      { attemptToken: token, reason: "stale-attempt" }
    );
    expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    expect(coordinator.activeSession).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
  });

  test("make-before-break keeps LAN alive until a Bluetooth candidate is committed", async () => {
    const owner = makeSignalingOwner();
    const candidate = deferred();
    const btSession = { id: "prepared-bt", isConnected: true };
    const bluetoothAdapter = makeBluetoothAdapter({
      prepareConnection: jest.fn(() => candidate.promise),
      commitConnection: jest.fn().mockResolvedValue(undefined),
    });
    const coordinator = new ConnectionCoordinator({
      signalingOwner: owner,
      bluetoothAdapter,
      maxTransportTransitions: 1,
    });
    const peer = makePeer({
      LAN: { host: "192.168.0.36", port: 8089 },
      BLUETOOTH: { address: "AA:BB:CC:DD:EE:03" },
    });
    await coordinator.connectLanPeer(peer, 5000);

    const handover = coordinator.handoverPeer(peer, TRANSPORTS.BLUETOOTH, {
      timeoutMs: 4000,
    });

    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(coordinator.currentTransport).toBe(TRANSPORTS.LAN);
    expect(coordinator.activeSession).toBe(owner.session);
    expect(owner.disconnect).not.toHaveBeenCalled();

    candidate.resolve({ session: btSession });
    await expect(handover).resolves.toBe(btSession);

    expect(bluetoothAdapter.commitConnection).toHaveBeenCalledTimes(1);
    expect(owner.disconnect).toHaveBeenCalledTimes(1);
    expect(
      bluetoothAdapter.commitConnection.mock.invocationCallOrder[0]
    ).toBeLessThan(owner.disconnect.mock.invocationCallOrder[0]);
    expect(coordinator.currentTransport).toBe(TRANSPORTS.BLUETOOTH);
    expect(coordinator.activeSession).toBe(btSession);
    expect(coordinator.getCoordinatorStatus().transitionCount).toBe(1);

    await expect(
      coordinator.handoverPeer(peer, TRANSPORTS.LAN, {
        adapter: { prepareConnection: jest.fn() },
      })
    ).rejects.toBeInstanceOf(TransportTransitionLimitError);
  });

  test("failed candidate preparation preserves the healthy active session", async () => {
    const owner = makeSignalingOwner();
    const failure = new Error("Bluetooth unavailable");
    const bluetoothAdapter = makeBluetoothAdapter({
      prepareConnection: jest.fn().mockRejectedValue(failure),
    });
    const coordinator = new ConnectionCoordinator({
      signalingOwner: owner,
      bluetoothAdapter,
    });
    const peer = makePeer({
      LAN: { host: "192.168.0.36", port: 8089 },
      BLUETOOTH: { address: "AA:BB:CC:DD:EE:04" },
    });
    await coordinator.connectLanPeer(peer, 5000);

    await expect(
      coordinator.handoverPeer(peer, TRANSPORTS.BLUETOOTH)
    ).rejects.toBe(failure);

    expect(owner.disconnect).not.toHaveBeenCalled();
    expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
    expect(coordinator.currentTransport).toBe(TRANSPORTS.LAN);
    expect(coordinator.activeSession).toBe(owner.session);
  });
});
