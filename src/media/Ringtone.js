import { NativeModules } from 'react-native';
const { RingtoneModule } = NativeModules;

// نغمة النظام الافتراضية للمكالمة الواردة
export function startIncomingRing() { return RingtoneModule.startIncomingRing().catch(() => {}); }
// نبضات انتظار للمتصل تدل إن الطرف الآخر يرن
export function startOutgoingTone() { return RingtoneModule.startOutgoingTone().catch(() => {}); }
export function playEndTone() { return RingtoneModule.playEndTone().catch(() => {}); }
export function stopRingtone() { return RingtoneModule.stopAll().catch(() => {}); }
