jest.mock('react-native-tcp-socket', () => ({
  createServer: jest.fn(),
  createConnection: jest.fn(),
}));

import TcpSocket from 'react-native-tcp-socket';
import { PeerRegistry, PEER_STATUS, TRANSPORTS } from '../src/network/PeerRegistry';
import { ConnectionCoordinator, COORDINATOR_STATE } from '../src/network/ConnectionCoordinator';

function makeMockSocket() {
  const handlers = {};
  return {
    on: jest.fn((event, callback) => { handlers[event] = callback; }),
    once: jest.fn((event, callback) => { handlers[event] = callback; }),
    removeListener: jest.fn(),
    emit: (event, value) => { if (handlers[event]) handlers[event](value); },
    destroy: jest.fn(),
    write: jest.fn(),
    setKeepAlive: jest.fn(),
    setNoDelay: jest.fn(),
  };
}

describe('PeerRegistry and ConnectionCoordinator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('PeerRegistry', () => {
    test('upserts LAN peer and ignores self discovery', () => {
      const registry = new PeerRegistry({ myDeviceId: 'my-self-123' });

      expect(registry.upsertLanPeer({ deviceId: 'my-self-123', host: '192.168.1.10' })).toBeNull();

      const peer = registry.upsertLanPeer({
        deviceId: 'remote-456',
        deviceName: 'Alice Phone',
        host: '192.168.1.20',
        port: 8089,
        interfaceName: 'wlan0',
      });

      expect(peer).not.toBeNull();
      expect(peer.deviceId).toBe('remote-456');
      expect(peer.status).toBe(PEER_STATUS.ONLINE);
      expect(peer.transports.LAN.host).toBe('192.168.1.20');
      expect(peer.transports.LAN.interfaceName).toBe('wlan0');
      expect(peer.transports.LAN.generation).toBe(0);
      expect(registry.isTransportEndpointCurrent(peer.transports.LAN, TRANSPORTS.LAN)).toBe(true);
    });

    test('invalidates only the selected transport generation', () => {
      const registry = new PeerRegistry({ myDeviceId: 'self' });
      registry.upsertLanPeer({
        deviceId: 'peer-1',
        host: '192.168.0.36',
        interfaceName: 'wlan0',
      });
      registry.upsertP2pPeer({
        deviceId: 'peer-1',
        deviceAddress: 'aa:bb:cc:dd:ee:ff',
        groupOwnerAddress: '192.168.49.1',
        interfaceName: 'p2p-wlan0-0',
      });

      const before = registry.getPeer('peer-1');
      expect(before.transports.LAN.isReachable).toBe(true);
      expect(before.transports.P2P.isReachable).toBe(true);

      registry.invalidateTransport(TRANSPORTS.P2P, 'group-removed');

      const after = registry.getPeer('peer-1');
      expect(after.transports.P2P.isReachable).toBe(false);
      expect(after.transports.P2P.stale).toBe(true);
      expect(after.transports.LAN.isReachable).toBe(true);
      expect(registry.isTransportEndpointCurrent(after.transports.P2P, TRANSPORTS.P2P)).toBe(false);
      expect(registry.isTransportEndpointCurrent(after.transports.LAN, TRANSPORTS.LAN)).toBe(true);
    });

    test('fresh discovery after invalidation uses the new transport generation', () => {
      const registry = new PeerRegistry({ myDeviceId: 'self' });
      registry.upsertLanPeer({ deviceId: 'peer-1', host: '192.168.49.1', interfaceName: 'p2p-wlan0-0' });
      registry.invalidateTransport(TRANSPORTS.LAN, 'wifi-network-changed');

      const stale = registry.getPeer('peer-1').transports.LAN;
      expect(stale.stale).toBe(true);
      expect(registry.isTransportEndpointCurrent(stale, TRANSPORTS.LAN)).toBe(false);

      registry.upsertLanPeer({ deviceId: 'peer-1', host: '192.168.0.36', interfaceName: 'wlan0' });
      const fresh = registry.getPeer('peer-1').transports.LAN;
      expect(fresh.host).toBe('192.168.0.36');
      expect(fresh.interfaceName).toBe('wlan0');
      expect(fresh.generation).toBe(1);
      expect(fresh.stale).toBe(false);
      expect(registry.isTransportEndpointCurrent(fresh, TRANSPORTS.LAN)).toBe(true);
    });

    test('sorts peers correctly according to priority', () => {
      const registry = new PeerRegistry({ myDeviceId: 'self' });

      registry.upsertLanPeer({ deviceId: 'peer-offline', deviceName: 'Offline Peer', host: '1.1.1.1', isOnline: false });
      registry.upsertLanPeer({ deviceId: 'peer-online', deviceName: 'Online Peer', host: '1.1.1.2', isOnline: true });
      registry.upsertLanPeer({ deviceId: 'peer-trusted', deviceName: 'Trusted Peer', host: '1.1.1.3', isOnline: true });
      registry.setPeerTrusted('peer-trusted', true);
      registry.upsertLanPeer({ deviceId: 'peer-connected', deviceName: 'Connected Peer', host: '1.1.1.4', isOnline: true });
      registry.setPeerConnected('peer-connected', 'LAN');

      const sorted = registry.getAllPeers();
      expect(sorted[0].deviceId).toBe('peer-connected');
      expect(sorted[1].deviceId).toBe('peer-trusted');
      expect(sorted[2].deviceId).toBe('peer-online');
      expect(sorted[3].deviceId).toBe('peer-offline');
    });
  });

  describe('ConnectionCoordinator', () => {
    test('applies deterministic tie-breaking on simultaneous connection', () => {
      const coordinator = new ConnectionCoordinator({
        myDeviceId: 'device-bbb',
      });

      expect(coordinator.shouldYieldToInbound('device-ccc')).toBe(true);
      expect(coordinator.shouldYieldToInbound('device-aaa')).toBe(false);
    });

    test('accepts incoming session and transitions to CONNECTED state', () => {
      const onConnected = jest.fn();
      const coordinator = new ConnectionCoordinator({
        myDeviceId: 'device-1',
        onConnected,
      });

      const socket = makeMockSocket();
      const peerInfo = { deviceId: 'device-2', deviceName: 'Bob', transport: 'LAN' };

      const accepted = coordinator.handleIncomingSession(socket, peerInfo);
      expect(accepted).toBe(true);
      expect(coordinator.state).toBe(COORDINATOR_STATE.CONNECTED);
      expect(coordinator.getActivePeer()).toEqual(peerInfo);
      expect(onConnected).toHaveBeenCalledWith(peerInfo, 'LAN');

      coordinator.disconnect();
      expect(coordinator.state).toBe(COORDINATOR_STATE.IDLE);
    });
  });
});
