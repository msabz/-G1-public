const mockSetSignalingOwner = jest.fn();
const mockSetPassiveInboundAdmissionHandler = jest.fn();
const mockSignalingOwner = { name: 'live-signaling-owner' };
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
  },
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

  test('binds signaling ownership and passive LAN admission before registering React Native roots', () => {
    jest.isolateModules(() => {
      require('../index');
    });

    expect(mockSetSignalingOwner).toHaveBeenCalledTimes(1);
    expect(mockSetSignalingOwner).toHaveBeenCalledWith(mockSignalingOwner);
    expect(mockSetPassiveInboundAdmissionHandler).toHaveBeenCalledTimes(1);
    expect(mockSetPassiveInboundAdmissionHandler).toHaveBeenCalledWith(mockLanPassiveAdmissionHandler);
    expect(mockRegisterComponent).toHaveBeenCalledTimes(3);

    expect(mockSetSignalingOwner.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetPassiveInboundAdmissionHandler.mock.invocationCallOrder[0]
    );
    expect(mockSetPassiveInboundAdmissionHandler.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegisterComponent.mock.invocationCallOrder[0]
    );
  });
});
