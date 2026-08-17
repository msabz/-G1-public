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

        fun notificationId(callId: String): Int {
            val hash = callId.hashCode() and 0x7fffffff
            return 20000 + (hash % 1000000)
        }
    }

    override fun getName() = "CallNotificationModule"

    init {
        createChannel()
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
    fun consumePendingCallAction(promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val action = prefs.getString("pendingAction", null)
            val callId = prefs.getString("pendingActionCallId", null)
            if (action.isNullOrBlank() || callId.isNullOrBlank()) {
                promise.resolve(null)
                return
            }
            prefs.edit()
                .remove("pendingAction")
                .remove("pendingActionCallId")
                .remove("pendingActionAt")
                .apply()
            promise.resolve(Arguments.createMap().apply {
                putString("action", action)
                putString("callId", callId)
            })
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
