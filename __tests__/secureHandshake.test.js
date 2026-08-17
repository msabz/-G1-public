import { SecureHandshakeManager, PROTOCOL_VERSION, APP_IDENTIFIER } from '../src/network/SecureHandshake';

describe('SecureHandshakeManager', () => {
  let handshake;

  beforeEach(() => {
    handshake = new SecureHandshakeManager({
      myDeviceId: 'my-phone-1',
      myDeviceName: 'My Phone',
    });
  });

  test('generates valid hello payload', () => {
    const hello = handshake.createHelloPayload();
    expect(hello.type).toBe('handshake-hello');
    expect(hello.protoVer).toBe(PROTOCOL_VERSION);
    expect(hello.app).toBe(APP_IDENTIFIER);
    expect(hello.deviceId).toBe('my-phone-1');
  });

  test('validates hello message from remote peer', () => {
    const validHello = {
      type: 'handshake-hello',
      protoVer: 1,
      app: 'G1',
      deviceId: 'remote-phone-2',
      deviceName: 'Remote Phone',
      timestamp: Date.now(),
    };

    const res = handshake.validateHello(validHello);
    expect(res.valid).toBe(true);
    expect(res.peerInfo.deviceId).toBe('remote-phone-2');
  });

  test('rejects hello message with mismatched app or protocol version', () => {
    const wrongApp = {
      type: 'handshake-hello',
      protoVer: 1,
      app: 'OtherApp',
      deviceId: 'remote-2',
      timestamp: Date.now(),
    };
    expect(handshake.validateHello(wrongApp).valid).toBe(false);

    const wrongProto = {
      type: 'handshake-hello',
      protoVer: 999,
      app: 'G1',
      deviceId: 'remote-2',
      timestamp: Date.now(),
    };
    expect(handshake.validateHello(wrongProto).valid).toBe(false);
  });

  test('rejects self hello message', () => {
    const selfHello = {
      type: 'handshake-hello',
      protoVer: 1,
      app: 'G1',
      deviceId: 'my-phone-1',
      timestamp: Date.now(),
    };
    const res = handshake.validateHello(selfHello);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/Self connection/);
  });
});
