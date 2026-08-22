jest.mock("react-native-tcp-socket", () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import {
  TransportFallbackEngine,
  TransportFallbackExhaustedError,
  TransportSelectionBusyError,
  TRANSPORT_MODE,
} from "../src/network/TransportFallbackEngine";

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeAllTransportPeer(deviceId = "peer-device") {
  return {
    deviceId,
    transports: {
      BLUETOOTH: { address: "AA:BB:CC:DD:EE:FF" },
      P2P: { deviceAddress: "02:00:00:00:00:01" },
      LAN: { host: "192.168.0.36", port: 8089 },
    },
  };
}

describe("TransportFallbackEngine deterministic bounded policy", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test("candidate order is deterministic and independent from endpoint insertion order", () => {
    const coordinator = {
      connectLanPeer: jest.fn(),
      connectP2pPeer: jest.fn(),
      connectBluetoothPeer: jest.fn(),
      cancelConnecting: jest.fn(),
      setFallbackEngine: jest.fn(),
    };
    const engine = new TransportFallbackEngine({ coordinator });

    expect(engine.getCandidatePlan(makeAllTransportPeer())).toEqual([
      "LAN",
      "P2P",
      "BLUETOOTH",
    ]);
  });

  test("maxAttempts bounds fallback without reaching later available transports", async () => {
    const coordinator = {
      connectLanPeer: jest.fn().mockRejectedValue(new Error("LAN failed")),
      connectP2pPeer: jest.fn().mockRejectedValue(new Error("P2P failed")),
      connectBluetoothPeer: jest.fn().mockResolvedValue({ id: "bt-session" }),
      cancelConnecting: jest.fn(),
      setFallbackEngine: jest.fn(),
    };
    const engine = new TransportFallbackEngine({ coordinator, maxAttempts: 2 });

    await expect(engine.connect(makeAllTransportPeer())).rejects.toMatchObject({
      name: "TransportFallbackExhaustedError",
      attempts: [
        expect.objectContaining({ transport: "LAN" }),
        expect.objectContaining({ transport: "P2P" }),
      ],
    });
    expect(coordinator.connectBluetoothPeer).not.toHaveBeenCalled();
  });

  test("coalesces duplicate peer intents into one physical attempt", async () => {
    const pending = deferred();
    const coordinator = {
      connectLanPeer: jest.fn(() => pending.promise),
      connectP2pPeer: jest.fn(),
      connectBluetoothPeer: jest.fn(),
      cancelConnecting: jest.fn(),
      setFallbackEngine: jest.fn(),
    };
    const engine = new TransportFallbackEngine({ coordinator });
    const peer = makeAllTransportPeer();

    const first = engine.connect(peer);
    const duplicate = engine.connect(peer);

    expect(duplicate).toBe(first);
    await Promise.resolve();
    expect(coordinator.connectLanPeer).toHaveBeenCalledTimes(1);
    expect(engine.getStatus().pendingAttempt.token).toEqual(
      expect.objectContaining({
        generation: 1,
        peerId: "peer-device",
      })
    );

    const session = { id: "lan-session" };
    pending.resolve(session);
    await expect(first).resolves.toEqual({ transport: "LAN", session });
    await expect(duplicate).resolves.toEqual({ transport: "LAN", session });
  });

  test("rejects a competing peer while the bounded selector is busy", async () => {
    const pending = deferred();
    const coordinator = {
      connectLanPeer: jest.fn(() => pending.promise),
      cancelConnecting: jest.fn(),
      setFallbackEngine: jest.fn(),
    };
    const engine = new TransportFallbackEngine({ coordinator });

    const first = engine.connect({
      deviceId: "peer-one",
      transports: { LAN: { host: "192.168.0.10" } },
    });
    await expect(
      engine.connect({
        deviceId: "peer-two",
        transports: { LAN: { host: "192.168.0.11" } },
      })
    ).rejects.toBeInstanceOf(TransportSelectionBusyError);

    pending.resolve({ id: "session-one" });
    await first;
  });

  test("Bluetooth-only mode delegates to the coordinator-owned injected adapter path", async () => {
    const session = { id: "bt-session" };
    const coordinator = {
      connectBluetoothPeer: jest.fn().mockResolvedValue(session),
      cancelConnecting: jest.fn(),
      setFallbackEngine: jest.fn(),
    };
    const engine = new TransportFallbackEngine({
      coordinator,
      mode: TRANSPORT_MODE.BLUETOOTH_ONLY,
      bluetoothTimeoutMs: 6100,
    });
    const peer = {
      deviceId: "peer-bt",
      transports: { BLUETOOTH: { address: "AA:BB:CC:DD:EE:01" } },
    };

    await expect(engine.connect(peer)).resolves.toEqual({
      transport: "BLUETOOTH",
      result: session,
    });
    expect(coordinator.connectBluetoothPeer).toHaveBeenCalledWith(peer, 6100);
  });

  test("forced mode without a current endpoint fails with structured diagnostics", async () => {
    const coordinator = {
      connectLanPeer: jest.fn(),
      setFallbackEngine: jest.fn(),
    };
    const engine = new TransportFallbackEngine({
      coordinator,
      mode: TRANSPORT_MODE.LAN_ONLY,
    });

    await expect(
      engine.connect({ deviceId: "missing-lan", transports: {} })
    ).rejects.toBeInstanceOf(TransportFallbackExhaustedError);
  });
});
