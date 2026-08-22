package com.m200.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import com.facebook.react.bridge.*

class CallNotificationModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val CHANNEL_ID = "g1_calls"
        const val PREFS = "g1_pending_call"
        const val EVENT_CALL_ACTION = "G1_CALL_ACTION"
        private const val ACTION_MAX_AGE_MS = 5 * 60 * 1000L

        private val SESSION_KEYS = arrayOf(
            "sessionCallId",
            "sessionPeerId",
            "sessionPeerName",
            "sessionDirection",
            "sessionMediaType",
            "sessionState",
            "sessionStartedAt",
            "sessionRingingAt",
            "sessionAnsweredAt",
            "sessionActiveAt",
            "sessionLastTransitionAt",
            "sessionCorrelationMode"
        )

        fun notificationId(callId: String): Int {
            val hash = callId.hashCode() and 0x7fffffff
            return 20000 + (hash % 1000000)
        }
    }

    override fun getName() = "CallNotificationModule"

    init {
        createChannel()
    }

    private fun ReadableMap.stringOrNull(key: String): String? =
        if (hasKey(key) && !isNull(key)) getString(key) else null

    private fun ReadableMap.longOrNull(key: String): Long? =
        if (hasKey(key) && !isNull(key)) getDouble(key).toLong() else null

    private fun WritableMap.putNullableTimestamp(key: String, value: Long?) {
        if (value == null || value <= 0L) putNull(key) else putDouble(key, value.toDouble())
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "مكالمات G1", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "إشعارات المكالمات الواردة في G1 DirectChat"
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                enableVibration(true)
                // RingtoneModule owns the ringtone to avoid double audio from
                // both the notification channel and G1 call state machine.
                setSound(null, null)
            }
        )
    }

    private fun actionPendingIntent(action: String, callId: String, requestOffset: Int): PendingIntent {
        val intent = Intent(reactApplicationContext, CallActionReceiver::class.java).apply {
            this.action = action
            putExtra("callId", callId)
        }
        return PendingIntent.getBroadcast(
            reactApplicationContext,
            notificationId(callId) + requestOffset,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        )
    }

    private fun launchPendingIntent(callId: String): PendingIntent {
        val launchIntent = reactApplicationContext.packageManager
            .getLaunchIntentForPackage(reactApplicationContext.packageName)
            ?.apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("g1CallId", callId)
                putExtra("g1CallAction", "open")
            }
            ?: Intent()
        return PendingIntent.getActivity(
            reactApplicationContext,
            notificationId(callId),
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        )
    }

    @ReactMethod
    fun showIncomingCall(callId: String, callerName: String, video: Boolean, promise: Promise) {
        try {
            require(callId.isNotBlank()) { "callId is required" }
            createChannel()

            reactApplicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString("callId", callId)
                .putString("callerName", callerName)
                .putBoolean("video", video)
                .putLong("receivedAt", System.currentTimeMillis())
                .apply()

            val answer = actionPendingIntent(CallActionReceiver.ACTION_ACCEPT, callId, 1)
            val decline = actionPendingIntent(CallActionReceiver.ACTION_REJECT, callId, 2)
            val open = launchPendingIntent(callId)
            val caller = Person.Builder()
                .setName(callerName.ifBlank { "G1 DirectChat" })
                .setImportant(true)
                .build()

            val notification = NotificationCompat.Builder(reactApplicationContext, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.sym_call_incoming)
                .setContentTitle(callerName.ifBlank { "G1 DirectChat" })
                .setContentText(if (video) "مكالمة فيديو واردة" else "مكالمة صوتية واردة")
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(open)
                .setFullScreenIntent(open, true)
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
                .build()

            val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(notificationId(callId), notification)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun showMissedCall(callId: String, callerName: String, video: Boolean, promise: Promise) {
        try {
            require(callId.isNotBlank()) { "callId is required" }
            createChannel()
            val open = launchPendingIntent(callId)
            val notification = NotificationCompat.Builder(reactApplicationContext, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.sym_call_missed)
                .setContentTitle(callerName.ifBlank { "G1 DirectChat" })
                .setContentText(if (video) "مكالمة فيديو فائتة" else "مكالمة صوتية فائتة")
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(false)
                .setAutoCancel(true)
                .setContentIntent(open)
                .build()

            val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(notificationId(callId), notification)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun cancelIncomingCall(callId: String, promise: Promise) {
        try {
            val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(notificationId(callId))
            val prefs = reactApplicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (prefs.getString("callId", null) == callId) {
                prefs.edit()
                    .remove("callId")
                    .remove("callerName")
                    .remove("video")
                    .remove("receivedAt")
                    .apply()
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getPendingIncomingCall(promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val callId = prefs.getString("callId", null)
            if (callId.isNullOrBlank()) {
                promise.resolve(null)
                return
            }
            promise.resolve(Arguments.createMap().apply {
                putString("callId", callId)
                putString("callerName", prefs.getString("callerName", "G1 DirectChat"))
                putBoolean("video", prefs.getBoolean("video", false))
                putDouble("receivedAt", prefs.getLong("receivedAt", 0L).toDouble())
            })
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun saveCallSession(session: ReadableMap, promise: Promise) {
        try {
            val callId = session.stringOrNull("callId")
                ?: throw IllegalArgumentException("callId is required")
            val peerId = session.stringOrNull("peerId")
                ?: throw IllegalArgumentException("peerId is required")
            val editor = reactApplicationContext
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString("sessionCallId", callId)
                .putString("sessionPeerId", peerId)
                .putString("sessionPeerName", session.stringOrNull("peerName") ?: "G1 Device")
                .putString("sessionDirection", session.stringOrNull("direction") ?: "incoming")
                .putString("sessionMediaType", session.stringOrNull("mediaType") ?: "voice")
                .putString("sessionState", session.stringOrNull("state") ?: "ringing")
                .putLong("sessionStartedAt", session.longOrNull("startedAt") ?: System.currentTimeMillis())
                .putLong("sessionLastTransitionAt", session.longOrNull("lastTransitionAt") ?: System.currentTimeMillis())
                .putString("sessionCorrelationMode", session.stringOrNull("correlationMode") ?: "call-id")

            mapOf(
                "sessionRingingAt" to session.longOrNull("ringingAt"),
                "sessionAnsweredAt" to session.longOrNull("answeredAt"),
                "sessionActiveAt" to session.longOrNull("activeAt")
            ).forEach { (key, value) ->
                if (value == null || value <= 0L) editor.remove(key) else editor.putLong(key, value)
            }
            promise.resolve(editor.commit())
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getPendingCallSession(promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val callId = prefs.getString("sessionCallId", null)
            if (callId.isNullOrBlank()) {
                promise.resolve(null)
                return
            }
            promise.resolve(Arguments.createMap().apply {
                putString("callId", callId)
                putString("peerId", prefs.getString("sessionPeerId", "unknown-peer"))
                putString("peerName", prefs.getString("sessionPeerName", "G1 Device"))
                putString("direction", prefs.getString("sessionDirection", "incoming"))
                putString("mediaType", prefs.getString("sessionMediaType", "voice"))
                putString("state", prefs.getString("sessionState", "ringing"))
                putDouble("startedAt", prefs.getLong("sessionStartedAt", 0L).toDouble())
                putNullableTimestamp("ringingAt", if (prefs.contains("sessionRingingAt")) prefs.getLong("sessionRingingAt", 0L) else null)
                putNullableTimestamp("answeredAt", if (prefs.contains("sessionAnsweredAt")) prefs.getLong("sessionAnsweredAt", 0L) else null)
                putNullableTimestamp("activeAt", if (prefs.contains("sessionActiveAt")) prefs.getLong("sessionActiveAt", 0L) else null)
                putDouble("lastTransitionAt", prefs.getLong("sessionLastTransitionAt", 0L).toDouble())
                putString("correlationMode", prefs.getString("sessionCorrelationMode", "call-id"))
            })
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun clearCallSession(callId: String, promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (prefs.getString("sessionCallId", null) == callId) {
                val editor = prefs.edit()
                SESSION_KEYS.forEach { key -> editor.remove(key) }
                editor.apply()
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun consumePendingCallAction(promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val action = prefs.getString("pendingAction", null)
            val callId = prefs.getString("pendingActionCallId", null)
            val actionAt = prefs.getLong("pendingActionAt", 0L)
            if (action.isNullOrBlank() || callId.isNullOrBlank()) {
                promise.resolve(null)
                return
            }
            if (actionAt <= 0L || System.currentTimeMillis() - actionAt > ACTION_MAX_AGE_MS) {
                prefs.edit()
                    .remove("pendingAction")
                    .remove("pendingActionCallId")
                    .remove("pendingActionAt")
                    .apply()
                promise.resolve(null)
                return
            }
            promise.resolve(Arguments.createMap().apply {
                putString("action", action)
                putString("callId", callId)
                putDouble("actionAt", actionAt.toDouble())
            })
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun acknowledgeCallAction(callId: String, action: String, actionAt: Double, promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val storedAt = prefs.getLong("pendingActionAt", 0L)
            val matches = prefs.getString("pendingActionCallId", null) == callId &&
                prefs.getString("pendingAction", null) == action &&
                (actionAt <= 0.0 || storedAt == actionAt.toLong())
            if (matches) {
                prefs.edit()
                    .remove("pendingAction")
                    .remove("pendingActionCallId")
                    .remove("pendingActionAt")
                    .apply()
            }
            promise.resolve(matches)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required by NativeEventEmitter contract.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required by NativeEventEmitter contract.
    }
}
