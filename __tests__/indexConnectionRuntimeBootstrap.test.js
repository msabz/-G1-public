const mockSetSignalingOwner = jest.fn();
const mockSetIdentityAuthenticator = jest.fn();
const mockSetP2pAdapter = jest.fn();
const mockStartP2pObserving = jest.fn();
const mockSetPassiveInboundAdmissionHandler = jest.fn();
const mockSubscribeMessage = jest.fn(() => ({ remove: jest.fn() }));
const mockSubscribeDisconnect = jest.fn(() => ({ remove: jest.fn() }));
const mockSignalingOwner = {
  name: 'live-signaling-owner',
  subscribeMessage: mockSubscribeMessage,
  subscribeDisconnect: mockSubscribeDisconnect,
};
const mockP2pAdapter = { startObserving: mockStartP2pObserving };
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
    setIdentityAuthenticator: mockSetIdentityAuthenticator,
    setP2pAdapter: mockSetP2pAdapter,
  },
}));

jest.mock('../src/network/WifiDirectTransportAdapter', () => ({
  wifiDirectTransportAdapter: mockP2pAdapter,
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

  test('binds signaling/auth/P2P ownership and passive LAN admission before registering React Native roots', () => {
    jest.isolateModules(() => {
      require('../index');
    });

    expect(mockSetSignalingOwner).toHaveBeenCalledTimes(1);
    expect(mockSetSignalingOwner).toHaveBeenCalledWith(mockSignalingOwner);
    expect(mockSubscribeMessage).toHaveBeenCalledTimes(1);
    expect(mockSubscribeDisconnect).toHaveBeenCalledTimes(1);
    expect(mockSetIdentityAuthenticator).toHaveBeenCalledTimes(1);
    expect(mockSetIdentityAuthenticator.mock.calls[0][0]).toEqual(expect.objectContaining({
      signalingOwner: mockSignalingOwner,
    }));
    expect(mockSetP2pAdapter).toHaveBeenCalledTimes(1);
    expect(mockSetP2pAdapter).toHaveBeenCalledWith(mockP2pAdapter);
    expect(mockStartP2pObserving).toHaveBeenCalledTimes(1);
    expect(mockSetPassiveInboundAdmissionHandler).toHaveBeenCalledTimes(1);
    expect(mockSetPassiveInboundAdmissionHandler).toHaveBeenCalledWith(mockLanPassiveAdmissionHandler);
    expect(mockRegisterComponent).toHaveBeenCalledTimes(3);

    expect(mockSetSignalingOwner.mock.invocationCallOrder[0]).toBeLessThan(
      mockSubscribeMessage.mock.invocationCallOrder[0]
    );
    expect(mockSubscribeMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetIdentityAuthenticator.mock.invocationCallOrder[0]
    );
    expect(mockSetIdentityAuthenticator.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetP2pAdapter.mock.invocationCallOrder[0]
    );
    expect(mockSetP2pAdapter.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartP2pObserving.mock.invocationCallOrder[0]
    );
    expect(mockStartP2pObserving.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetPassiveInboundAdmissionHandler.mock.invocationCallOrder[0]
    );
    expect(mockSetPassiveInboundAdmissionHandler.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegisterComponent.mock.invocationCallOrder[0]
    );
  });
});
