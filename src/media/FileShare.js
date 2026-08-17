import { NativeModules, NativeEventEmitter } from 'react-native';
import { getActivePeerAddress } from '../webrtc/signaling';

const { FilePickerModule, FileTransferModule } = NativeModules;
const ftEmitter = new NativeEventEmitter(FileTransferModule);
let transferServerPromise = null;

function normalizePeerAddress(value) {
  if (!value || typeof value !== 'string') return null;
  let address = value.trim();
  if (!address) return null;
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  return address || null;
}

export function resolveFileTransferTarget(peerIp) {
  const sessionAddress = normalizePeerAddress(getActivePeerAddress());
  const explicit = normalizePeerAddress(peerIp);
  return {
    target: sessionAddress || explicit,
    source: sessionAddress ? 'active-session' : explicit ? 'cached-fallback' : 'none',
    sessionAddress,
    explicit,
  };
}

function ensureTransferServer() {
  if (!FileTransferModule?.startServer) {
    return Promise.reject(new Error('خدمة نقل الملفات غير متاحة'));
  }
  if (!transferServerPromise) {
    transferServerPromise = FileTransferModule.startServer().catch(error => {
      transferServerPromise = null;
      throw error;
    });
  }
  return transferServerPromise;
}

// Keep the data-plane listener available independently from the UI lifecycle.
ensureTransferServer().catch(() => {});

export function pickFile() { return FilePickerModule.pickFile(); }
export function captureImage() { return FilePickerModule.captureImage(); }
export function listInstalledApps() { return FilePickerModule.listInstalledApps(); }
export function packageAppForSending(packageName) { return FilePickerModule.packageAppForSending(packageName); }
export function openReceivedFile(pathOrUri, mimeType) { return FilePickerModule.openReceivedFile(pathOrUri, mimeType || '*/*'); }
export function startTransferServer() { return ensureTransferServer(); }
export function stopTransferServer() {
  transferServerPromise = null;
  return FileTransferModule.stopServer();
}
export function cancelTransfer(transferId) {
  if (transferId && FileTransferModule.cancelTransferById) {
    return FileTransferModule.cancelTransferById(transferId);
  }
  return FileTransferModule.cancelTransfer();
}

/**
 * Send raw file data on TCP 8090. The live signaling socket is the route source
 * of truth. peerIp is only a compatibility fallback and may be null.
 */
export async function sendFileNative(peerIp, uri, transferId, kind = 'file') {
  const route = resolveFileTransferTarget(peerIp);
  if (!route.target) {
    throw new Error('لم يتم تحديد مسار الجهاز الآخر من جلسة الاتصال الحالية');
  }

  await ensureTransferServer();
  console.log(
    `[G1/FILE] SEND_START peer=${route.target} source=${route.source} cached=${route.explicit || 'none'} kind=${kind} id=${transferId}`
  );
  return FileTransferModule.sendFile(route.target, uri, transferId, kind);
}

export function onTransferProgress(cb) { return ftEmitter.addListener('FT_PROGRESS', cb); }
export function onIncomingStart(cb) { return ftEmitter.addListener('FT_INCOMING_START', cb); }
export function onIncomingDone(cb) { return ftEmitter.addListener('FT_INCOMING_DONE', cb); }
export function onSentDone(cb) { return ftEmitter.addListener('FT_SENT_DONE', cb); }
export function onTransferError(cb) { return ftEmitter.addListener('FT_ERROR', cb); }
