package com.m200.media

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.media.RingtoneManager
import android.os.Build
import com.facebook.react.bridge.*
import java.io.File

class AudioClipModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    private var recorder: MediaRecorder? = null
    private var recordFile: File? = null
    private var player: MediaPlayer? = null
    private var ringPlayer: MediaPlayer? = null

    override fun getName() = "AudioClipModule"

    @ReactMethod
    fun startRecording(promise: Promise) {
        try {
            val file = File(reactApplicationContext.cacheDir, "voice_${System.currentTimeMillis()}.m4a")
            recordFile = file
            val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(reactApplicationContext) else @Suppress("DEPRECATION") MediaRecorder()
            rec.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioEncodingBitRate(32000)
                setAudioSamplingRate(22050)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }
            recorder = rec
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    /**
     * بترجع مسار الملف بدل محتواه.
     * سابقاً كانت ترجّع base64 للملف كامل عبر الجسر — وهاد يلي كان بيفشل
     * مع التسجيلات الطويلة. هلق التسجيل بينبعت ببث خام متل باقي الملفات.
     */
    @ReactMethod
    fun stopRecording(promise: Promise) {
        try {
            recorder?.apply { stop(); release() }
            recorder = null
            val file = recordFile
            if (file != null && file.exists()) {
                val result = Arguments.createMap().apply {
                    putString("path", file.absolutePath)
                    putDouble("size", file.length().toDouble())
                }
                promise.resolve(result)
            } else {
                promise.reject("ERROR", "لم يتم العثور على الملف الصوتي")
            }
        } catch (e: Exception) {
            try { recorder?.release() } catch (ex: Exception) {}
            recorder = null
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun playAudioFile(path: String, promise: Promise) {
        try {
            player?.release()
            val mp = MediaPlayer()
            mp.setDataSource(path)
            mp.setOnCompletionListener { p -> p.release(); if (player == p) player = null }
            mp.prepare()
            mp.start()
            player = mp
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun stopPlayback(promise: Promise) {
        try {
            player?.release()
            player = null
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    // ===================== نغمة الرنين =====================

    /**
     * تشغيل نغمة الرنين للمكالمة الواردة (متكررة لحد ما يرد أو يرفض).
     * منستخدم نغمة النظام الافتراضية فما بنحتاج نضيف ملف صوتي للتطبيق.
     */
    @ReactMethod
    fun startRingtone(promise: Promise) {
        try {
            stopRingInternal()
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val mp = MediaPlayer()
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            mp.setDataSource(reactApplicationContext, uri)
            mp.isLooping = true
            mp.prepare()
            mp.start()
            ringPlayer = mp
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    /** نغمة انتظار للمتصل — نبضات هادئة تدل إن الجرس شغّال عند الطرف الآخر */
    @ReactMethod
    fun startRingback(promise: Promise) {
        try {
            stopRingInternal()
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val mp = MediaPlayer()
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            mp.setDataSource(reactApplicationContext, uri)
            mp.isLooping = true
            mp.setVolume(0.3f, 0.3f)
            mp.prepare()
            mp.start()
            ringPlayer = mp
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun stopRingtone(promise: Promise) {
        stopRingInternal()
        promise.resolve(true)
    }

    private fun stopRingInternal() {
        try { ringPlayer?.stop() } catch (e: Exception) {}
        try { ringPlayer?.release() } catch (e: Exception) {}
        ringPlayer = null
    }
}
