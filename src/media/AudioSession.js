import { NativeModules, NativeEventEmitter } from 'react-native';
const { AudioSessionManager } = NativeModules;
const emitter = new NativeEventEmitter(AudioSessionManager);

/**
 * الواجهة الوحيدة لدورة حياة الصوت.
 * JavaScript بيطلب START / STOP فقط — الملكية والمراقبة بالطبقة الأصلية.
 */
export function startAudioSession(useSpeaker) {
  return AudioSessionManager.startSession(!!useSpeaker).catch(() => {});
}

export function stopAudioSession() {
  return AudioSessionManager.stopEverything().catch(() => {});
}

export function getAudioState() {
  return AudioSessionManager.getState().catch(() => 'IDLE');
}

// نبلّغ الطبقة الأصلية إذا لسا في مسارات صوتية حيّة — الحارس بيستخدمها
export function reportLiveAudio(live) {
  return AudioSessionManager.reportLiveAudio(!!live).catch(() => {});
}

export function setSpeaker(useSpeaker) {
  return AudioSessionManager.setSpeaker(!!useSpeaker).catch(() => {});
}

export function setCallVolume(fraction) {
  return AudioSessionManager.setVolume(fraction).catch(() => {});
}

// سجلات دورة حياة الصوت — مفيدة للتشخيص
export function onAudioLog(cb) {
  return emitter.addListener('AUDIO_SESSION_LOG', cb);
}

// الحارس اكتشف تسريباً وبيطلب إغلاق قسري
export function onForceStop(cb) {
  return emitter.addListener('AUDIO_FORCE_STOP', cb);
}
