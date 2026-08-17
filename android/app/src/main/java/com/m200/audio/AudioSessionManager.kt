package com.m200.audio

import android.content.Context
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.atomic.AtomicReference

/**
 * المالك الوحيد لدورة حياة الصوت أثناء المكالمة.
 *
 * القاعدة الصارمة:
 *   JavaScript بيطلب START / STOP فقط.
 *   هالوحدة بتملك الحالة، بتراقبها، وبتنفّذ التنظيف.
 *
 * ليش هالبنية: قبلها كانت حالة الصوت موزّعة على JavaScript، وكل مسار
 * إغلاق بمكان. لو تأخّر JS أو تعلّق أو رجع للدردشة بدون ما يكمّل
 * التنظيف، الميكروفون بيضل مفتوح — لأن اللي بيمسكه الطبقة الأصلية
 * مش JS. هلق مصدر الحقيقة هون، مش الشاشة الظاهرة.
 */
class AudioSessionManager(private val reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "AUDIO"
        private const val WATCHDOG_INTERVAL_MS = 1000L

        // الحالات — مصدر الحقيقة الوحيد لحالة الصوت
        const val STATE_IDLE = "IDLE"
        const val STATE_ACTIVE = "ACTIVE"
        const val STATE_STOPPING = "STOPPING"
    }

    private val state = AtomicReference(STATE_IDLE)
    private val mainHandler = Handler(Looper.getMainLooper())

    private var previousAudioMode: Int? = null
    private var previousSpeaker = false
    private var focusRequested = false

    private var watchdogRunning = false
    private var watchdogRunnable: Runnable? = null

    // JavaScript بيبلّغنا إذا لسا في موارد صوتية شغّالة (مسارات WebRTC).
    // الحارس بيستخدمها ليكشف التسريب.
    @Volatile private var jsReportsLiveAudio = false

    override fun getName() = "AudioSessionManager"

    private fun log(msg: String) {
        Log.i(TAG, msg)
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("AUDIO_SESSION_LOG", Arguments.createMap().apply {
                    putString("line", msg)
                    putString("state", state.get())
                })
        } catch (e: Exception) {}
    }

    private fun am(): AudioManager =
        reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    // ===================== بدء الجلسة =====================

    /**
     * تهيئة بيئة الصوت للمكالمة. ما بتفتح ميكروفون —
     * WebRTC هي يلي بتفتحه، وهاي بس بتهيّئ التوجيه والمستوى.
     */
    @ReactMethod
    fun startSession(useSpeaker: Boolean, promise: Promise) {
        try {
            log("[AUDIO] START requested (speaker=$useSpeaker)")

            val audio = am()
            if (previousAudioMode == null) {
                previousAudioMode = audio.mode
                previousSpeaker = audio.isSpeakerphoneOn
            }

            audio.mode = AudioManager.MODE_IN_COMMUNICATION
            audio.isSpeakerphoneOn = useSpeaker

            @Suppress("DEPRECATION")
            audio.requestAudioFocus(
                null,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
            )
            focusRequested = true

            // مستوى معتدل: الأقصى بيغرق ملغي الصدى فيرجع الصدى
            try {
                val max = audio.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
                val target = (max * (if (useSpeaker) 0.5 else 0.85)).toInt().coerceAtLeast(1)
                audio.setStreamVolume(AudioManager.STREAM_VOICE_CALL, target, 0)
            } catch (e: Exception) {}

            state.set(STATE_ACTIVE)
            log("[AUDIO] ACTIVE")

            startWatchdog()
            promise.resolve(true)
        } catch (e: Exception) {
            log("[AUDIO] START failed: ${e.message}")
            promise.reject("ERROR", e.message)
        }
    }

    // ===================== إيقاف الجلسة =====================

    /**
     * إيقاف كامل. آمن للاستدعاء المتكرر (idempotent):
     * ثلاث أوامر إيقاف متتالية ما بتنهار ولا بتحرّر نفس المورد مرتين.
     */
    @ReactMethod
    fun stopEverything(promise: Promise) {
        val result = stopInternal("JS")
        promise.resolve(result)
    }

    @Synchronized
    private fun stopInternal(source: String): Boolean {
        val current = state.get()

        // إذا خلصنا أصلاً، ما منعيد التحرير — بس منأكّد التنظيف بهدوء
        if (current == STATE_IDLE) {
            releaseAudioResources(silent = true)
            return true
        }

        if (current == STATE_STOPPING) {
            log("[AUDIO] STOP ignored (already stopping)")
            return true
        }

        state.set(STATE_STOPPING)
        log("[AUDIO] STOP requested (by $source)")

        // الترتيب مقصود: تحرير الموارد ثم التوجيه ثم التركيز
        releaseAudioResources(silent = false)

        state.set(STATE_IDLE)
        log("[AUDIO] IDLE")
        return true
    }

    private fun releaseAudioResources(silent: Boolean) {
        val audio = am()

        if (!silent) log("[AUDIO] releasing audio resources")

        try {
            audio.isSpeakerphoneOn = previousSpeaker
            audio.mode = previousAudioMode ?: AudioManager.MODE_NORMAL
        } catch (e: Exception) {}
        previousAudioMode = null

        if (focusRequested) {
            try {
                @Suppress("DEPRECATION")
                audio.abandonAudioFocus(null)
                if (!silent) log("[AUDIO] abandoning audio focus")
            } catch (e: Exception) {}
            focusRequested = false
        }
    }

    // ===================== الحالة =====================

    @ReactMethod
    fun getState(promise: Promise) {
        promise.resolve(state.get())
    }

    /**
     * JavaScript بيبلّغنا إذا لسا في مسارات صوتية حيّة بـ WebRTC.
     * الحارس بيقارنها بالحالة ليكشف التسريب.
     */
    @ReactMethod
    fun reportLiveAudio(live: Boolean, promise: Promise) {
        jsReportsLiveAudio = live
        promise.resolve(true)
    }

    @ReactMethod
    fun setSpeaker(useSpeaker: Boolean, promise: Promise) {
        try {
            val audio = am()
            if (audio.mode != AudioManager.MODE_IN_COMMUNICATION) {
                audio.mode = AudioManager.MODE_IN_COMMUNICATION
            }
            audio.isSpeakerphoneOn = useSpeaker
            try {
                val max = audio.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
                val target = (max * (if (useSpeaker) 0.5 else 0.85)).toInt().coerceAtLeast(1)
                audio.setStreamVolume(AudioManager.STREAM_VOICE_CALL, target, 0)
            } catch (e: Exception) {}
            promise.resolve(useSpeaker)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun setVolume(fraction: Double, promise: Promise) {
        try {
            val audio = am()
            val max = audio.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
            val target = (max * fraction).toInt().coerceIn(0, max)
            audio.setStreamVolume(AudioManager.STREAM_VOICE_CALL, target, 0)
            promise.resolve(target)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    // ===================== الحارس =====================

    /**
     * شبكة أمان فقط — مش الآلية الأساسية.
     * التسلسل الطبيعي هو الأصل، وهاد بيتدخّل بس لو تسرّب شي.
     * وأي تدخّل بينسجّل كخلل، مش كحالة طبيعية منخبّيها.
     */
    private fun startWatchdog() {
        if (watchdogRunning) return
        watchdogRunning = true

        val runnable = object : Runnable {
            override fun run() {
                if (!watchdogRunning) return
                try {
                    val s = state.get()
                    if (s == STATE_IDLE && jsReportsLiveAudio) {
                        log("[AUDIO-WATCHDOG] IDLE but audio resource still active")
                        log("[AUDIO-WATCHDOG] force cleanup")
                        // نبلّغ JS ليقفل مسارات WebRTC، ومننظّف من طرفنا
                        try {
                            reactContext
                                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                .emit("AUDIO_FORCE_STOP", Arguments.createMap())
                        } catch (e: Exception) {}
                        releaseAudioResources(silent = true)
                    }
                } catch (e: Exception) {}
                mainHandler.postDelayed(this, WATCHDOG_INTERVAL_MS)
            }
        }
        watchdogRunnable = runnable
        mainHandler.postDelayed(runnable, WATCHDOG_INTERVAL_MS)
    }

    @ReactMethod
    fun stopWatchdog(promise: Promise) {
        watchdogRunning = false
        watchdogRunnable?.let { mainHandler.removeCallbacks(it) }
        watchdogRunnable = null
        promise.resolve(true)
    }

    override fun onCatalystInstanceDestroy() {
        // انهيار أو إعادة تحميل JS — منحرّر كل شي
        watchdogRunning = false
        watchdogRunnable?.let { mainHandler.removeCallbacks(it) }
        stopInternal("catalyst-destroy")
        super.onCatalystInstanceDestroy()
    }
}
