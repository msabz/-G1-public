const mockSetSignalingOwner = jest.fn();
const mockSetP2pAdapter = jest.fn();
const mockSetBluetoothAdapter = jest.fn();
const mockStartP2pObserving = jest.fn();
const mockStartBluetoothObserving = jest.fn();
const mockSetPassiveInboundAdmissionHandler = jest.fn();
const mockSignalingOwner = { name: 'live-signaling-owner' };
const mockP2pAdapter = { startObserving: mockStartP2pObserving };
const mockBluetoothAdapter = { startObserving: mockStartBluetoothObserving };
const mockLanPassiveAdmissionHandler = jest.fn();
const mockRegisterComponent = jest.fn();

jest.mock('react-native', () => ({
  AppRegistry: {
    registerComponent: mockRegisterComponent,
  },
}));

jest.mock('../src/App', () => () => null);

jest.mock('../src/services/BackgroundRuntime', () => ({
  setUiAttached: jest.fn(),
}));

jest.mock('../src/network/ConnectionCoordinator', () => ({
  connectionCoordinator: {
    setSignalingOwner: mockSetSignalingOwner,
    setP2pAdapter: mockSetP2pAdapter,
    setBluetoothAdapter: mockSetBluetoothAdapter,
  },
}));

jest.mock('../src/network/WifiDirectTransportAdapter', () => ({
  wifiDirectTransportAdapter: mockP2pAdapter,
}));

jest.mock('../src/bluetooth/BluetoothManager', () => ({
  bluetoothTransport: mockBluetoothAdapter,
}));

jest.mock('../src/webrtc/signalingOwner', () => ({
  signalingOwner: mockSignalingOwner,
}));

jest.mock('../src/webrtc/signaling', () => ({
  setPassiveInboundAdmissionHandler: mockSetPassiveInboundAdmissionHandler,
}));

jest.mock('../src/network/LanPassiveAdmission', () => ({
  lanPassiveAdmissionHandler: mockLanPassiveAdmissionHandler,
}), { virtual: true });

describe('G1 live connection runtime bootstrap', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('binds signaling/P2P ownership and passive LAN admission before registering React Native roots', () => {
    jest.isolateModules(() => {
      require('../index');
    });

    expect(mockSetSignalingOwner).toHaveBeenCalledTimes(1);
    expect(mockSetSignalingOwner).toHaveBeenCalledWith(mockSignalingOwner);
    expect(mockSetP2pAdapter).toHaveBeenCalledTimes(1);
    expect(mockSetP2pAdapter).toHaveBeenCalledWith(mockP2pAdapter);
    expect(mockSetBluetoothAdapter).toHaveBeenCalledTimes(1);
    expect(mockSetBluetoothAdapter).toHaveBeenCalledWith(mockBluetoothAdapter);
    expect(mockStartP2pObserving).toHaveBeenCalledTimes(1);
    expect(mockStartBluetoothObserving).toHaveBeenCalledTimes(1);
    expect(mockSetPassiveInboundAdmissionHandler).toHaveBeenCalledTimes(1);
    expect(mockSetPassiveInboundAdmissionHandler).toHaveBeenCalledWith(mockLanPassiveAdmissionHandler);
    expect(mockRegisterComponent).toHaveBeenCalledTimes(3);

    expect(mockSetSignalingOwner.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetP2pAdapter.mock.invocationCallOrder[0]
    );
    expect(mockSetP2pAdapter.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetBluetoothAdapter.mock.invocationCallOrder[0]
    );
    expect(mockSetBluetoothAdapter.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartP2pObserving.mock.invocationCallOrder[0]
    );
    expect(mockStartP2pObserving.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartBluetoothObserving.mock.invocationCallOrder[0]
    );
    expect(mockStartBluetoothObserving.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetPassiveInboundAdmissionHandler.mock.invocationCallOrder[0]
    );
    expect(mockSetPassiveInboundAdmissionHandler.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegisterComponent.mock.invocationCallOrder[0]
    );
  });
});
