const mockSetSignalingOwner = jest.fn();
const mockSignalingOwner = { name: 'live-signaling-owner' };
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

describe('G1 live connection runtime bootstrap', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('binds the live signaling owner before registering the React Native roots', () => {
    jest.isolateModules(() => {
      require('../index');
    });

    expect(mockSetSignalingOwner).toHaveBeenCalledTimes(1);
    expect(mockSetSignalingOwner).toHaveBeenCalledWith(mockSignalingOwner);
    expect(mockRegisterComponent).toHaveBeenCalledTimes(3);
    expect(mockSetSignalingOwner.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegisterComponent.mock.invocationCallOrder[0]
    );
  });
});
