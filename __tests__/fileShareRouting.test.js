jest.mock('react-native', () => {
  const listeners = [];
  return {
    NativeModules: {
      FilePickerModule: {},
      FileTransferModule: {
        startServer: jest.fn().mockResolvedValue(true),
        stopServer: jest.fn().mockResolvedValue(true),
        sendFile: jest.fn().mockResolvedValue({ id: 'done' }),
        cancelTransfer: jest.fn().mockResolvedValue(true),
      },
    },
    NativeEventEmitter: jest.fn().mockImplementation(() => ({
      addListener: jest.fn((name, cb) => {
        listeners.push({ name, cb });
        return { remove: jest.fn() };
      }),
    })),
  };
});

jest.mock('../src/webrtc/signaling', () => ({ getActivePeerAddress: jest.fn() }));

import { NativeModules } from 'react-native';
import { getActivePeerAddress } from '../src/webrtc/signaling';
import { resolveFileTransferTarget, sendFileNative } from '../src/media/FileShare';

describe('FileShare routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    NativeModules.FileTransferModule.startServer.mockResolvedValue(true);
    NativeModules.FileTransferModule.sendFile.mockResolvedValue({ id: 'done' });
  });

  test('prefers the live signaling remote address over a stale cached P2P address', async () => {
    getActivePeerAddress.mockReturnValue('::ffff:192.168.0.36');
    await sendFileNative('192.168.49.1', 'content://example/file', 'transfer-1', 'file');
    expect(NativeModules.FileTransferModule.sendFile).toHaveBeenCalledWith('192.168.0.36', 'content://example/file', 'transfer-1', 'file');
  });

  test('can send with no cached peerIp when an active signaling route exists', async () => {
    getActivePeerAddress.mockReturnValue('192.168.0.55');
    await sendFileNative(null, 'content://example/file', 'transfer-live', 'file');
    expect(NativeModules.FileTransferModule.sendFile).toHaveBeenCalledWith('192.168.0.55', 'content://example/file', 'transfer-live', 'file');
  });

  test('uses explicit endpoint only when no active signaling endpoint exists', async () => {
    getActivePeerAddress.mockReturnValue(null);
    await sendFileNative('192.168.49.1', 'content://example/file', 'transfer-2', 'image');
    expect(NativeModules.FileTransferModule.sendFile).toHaveBeenCalledWith('192.168.49.1', 'content://example/file', 'transfer-2', 'image');
  });

  test('normalizes and reports route source deterministically', () => {
    getActivePeerAddress.mockReturnValue('[fe80::1]');
    expect(resolveFileTransferTarget('192.168.49.1')).toMatchObject({ target: 'fe80::1', source: 'active-session' });
  });
});
