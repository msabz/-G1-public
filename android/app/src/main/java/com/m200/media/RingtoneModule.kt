package com.m200.media

import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.os.Build
import com.facebook.react.bridge.*

/**
 * نغمة الرنين للمكالمات الواردة، ونغمة الانتظار للمتصل.
 *
 * منستخدم نغمة النظام الافتراضية بدل ملف صوتي — هيك ما منزيد حجم
 * التطبيق ومنحترم إعدادات المستخدم (الوضع الصامت مثلاً).
 */
class RingtoneModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private var ringtone: Ringtone? = null
    private var toneGen: ToneGenerator? = null

    override fun getName() = "RingtoneModule"

    /** رنين المكالمة الواردة — نغمة النظام، متكررة */
    @ReactMethod
    fun startIncomingRing(promise: Promise) {
        try {
            stopAllInternal()

            val uri = RingtoneManager.getActualDefaultRingtoneUri(
                reactApplicationContext, RingtoneManager.TYPE_RINGTONE
            ) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)

            val rt = RingtoneManager.getRingtone(reactApplicationContext, uri)
            if (rt != null) {
                rt.audioAttributes = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    rt.isLooping = true
                }
                rt.play()
                ringtone = rt
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    /** نغمة انتظار للمتصل — نبضات هادئة تدل إن الطرف الآخر يرن */
    @ReactMethod
    fun startOutgoingTone(promise: Promise) {
        try {
            stopAllInternal()
            val tg = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 60)
            tg.startTone(ToneGenerator.TONE_SUP_RINGTONE)
            toneGen = tg
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    /** نغمة قصيرة عند الرفض أو انتهاء المكالمة */
    @ReactMethod
    fun playEndTone(promise: Promise) {
        try {
            stopAllInternal()
            val tg = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 60)
            tg.startTone(ToneGenerator.TONE_PROP_PROMPT, 300)
            toneGen = tg
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun stopAll(promise: Promise) {
        stopAllInternal()
        promise.resolve(true)
    }

    private fun stopAllInternal() {
        try { ringtone?.stop() } catch (e: Exception) {}
        ringtone = null
        try { toneGen?.stopTone(); toneGen?.release() } catch (e: Exception) {}
        toneGen = null
    }
}
