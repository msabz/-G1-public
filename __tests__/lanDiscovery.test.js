import { NativeModules } from 'react-native';

jest.mock('react-native', () => {
  const mockLanModule = {
    startAdvertising: jest.fn().mockResolvedValue(true),
    stopAdvertising: jest.fn().mockResolvedValue(true),
    startDiscovery: jest.fn().mockResolvedValue(true),
    stopDiscovery: jest.fn().mockResolvedValue(true),
    getStatus: jest.fn().mockResolvedValue({ isAdvertising: true, isDiscovering: true }),
  };
  return {
    NativeModules: {
      LanDiscoveryModule: mockLanModule,
    },
    NativeEventEmitter: jest.fn().mockImplementation(() => ({
      addListener: jest.fn(() => ({ remove: jest.fn() })),
    })),
    Platform: { OS: 'android' },
  };
});

import { lanDiscovery } from '../src/network/LanDiscovery';
import { peerRegistry, TRANSPORTS } from '../src/network/PeerRegistry';

describe('LanDiscovery Manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lanDiscovery.clear();
    peerRegistry.clear();
  });

  test('starts advertising with device metadata', async () => {
    expect(lanDiscovery.isSupported()).toBe(true);

    const success = await lanDiscovery.startAdvertising({
      deviceId: 'dev-123',
      deviceName: 'Device 123',
      port: 8089,
    });
    expect(success).toBe(true);
    expect(NativeModules.LanDiscoveryModule.startAdvertising).toHaveBeenCalledWith(
      'dev-123',
      'Device 123',
      8089,
      {}
    );
  });

  test('handles discovered LAN peers and updates map', () => {
    const onPeerFound = jest.fn();
    lanDiscovery.startDiscovery({ onPeerFound });

    lanDiscovery._handlePeerFound({
      deviceId: 'remote-456',
      deviceName: 'Remote Phone',
      host: '192.168.1.50',
      port: 8089,
      serviceName: 'G1-remote-456',
      interfaceName: 'wlan0',
    });

    const peers = lanDiscovery.getDiscoveredPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0].deviceId).toBe('remote-456');
    expect(peers[0].host).toBe('192.168.1.50');
    expect(peers[0].interfaceName).toBe('wlan0');
    expect(onPeerFound).toHaveBeenCalledTimes(1);
  });

  test('handles lost LAN peers', () => {
    const onPeerLost = jest.fn();
    lanDiscovery.startDiscovery({ onPeerLost });

    lanDiscovery._handlePeerFound({
      deviceId: 'remote-789',
      deviceName: 'Remote Phone 2',
      host: '192.168.1.51',
      port: 8089,
    });
    expect(lanDiscovery.getDiscoveredPeers()).toHaveLength(1);

    lanDiscovery._handlePeerLost({ deviceId: 'remote-789' });
    expect(lanDiscovery.getDiscoveredPeers()).toHaveLength(0);
    expect(onPeerLost).toHaveBeenCalledTimes(1);
  });

  test('network refresh invalidates only LAN endpoints and advances generation', () => {
    const onPeerLost = jest.fn();
    lanDiscovery.startDiscovery({
      onPeerFound: peer => peerRegistry.upsertLanPeer(peer),
      onPeerLost,
    });

    lanDiscovery._handlePeerFound({
      deviceId: 'remote-1',
      deviceName: 'Remote Phone',
      host: '192.168.0.36',
      port: 8089,
      interfaceName: 'wlan0',
    });
    peerRegistry.upsertP2pPeer({
      deviceId: 'remote-1',
      deviceAddress: 'aa:bb:cc:dd:ee:ff',
      groupOwnerAddress: '192.168.49.1',
      interfaceName: 'p2p-wlan0-0',
    });

    expect(peerRegistry.getTransportGeneration(TRANSPORTS.LAN)).toBe(0);
    expect(peerRegistry.getPeer('remote-1').transports.LAN.isReachable).toBe(true);
    expect(peerRegistry.getPeer('remote-1').transports.P2P.isReachable).toBe(true);

    lanDiscovery._handleNetworkRefresh({ reason: 'p2p-network-lost' });

    const peer = peerRegistry.getPeer('remote-1');
    expect(peerRegistry.getTransportGeneration(TRANSPORTS.LAN)).toBe(1);
    expect(peer.transports.LAN.stale).toBe(true);
    expect(peer.transports.LAN.isReachable).toBe(false);
    expect(peer.transports.P2P.isReachable).toBe(true);
    expect(lanDiscovery.getDiscoveredPeers()).toHaveLength(0);
    expect(onPeerLost).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'remote-1',
      stale: true,
      invalidatedReason: 'p2p-network-lost',
    }));
  });
});
