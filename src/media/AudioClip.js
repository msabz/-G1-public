import { NativeModules } from 'react-native';
const { AudioClipModule } = NativeModules;

// بترجع مسار الملف المسجّل (مش base64) عشان ينبعت ببث خام
export function startVoiceRecording() { return AudioClipModule.startRecording(); }
export function stopVoiceRecording() { return AudioClipModule.stopRecording(); }
export function playVoiceFile(path) { return AudioClipModule.playAudioFile(path); }
export function stopVoicePlayback() { return AudioClipModule.stopPlayback(); }

// نغمات المكالمة
// نغمات الرنين موجودة بوحدة مستقلة (RingtoneModule) — منعيد تصديرها
// من هون عشان يضل الاستيراد بمكان واحد
export {
  startIncomingRing as startRingtone,
  startOutgoingTone as startRingback,
  playEndTone,
  stopRingtone,
} from './Ringtone';
