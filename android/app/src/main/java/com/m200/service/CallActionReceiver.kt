package com.m200.service

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.m200.MainApplication

/**
 * Handles CallStyle Answer/Reject actions without depending on an Activity.
 * When the React runtime is alive (the normal removed-from-Recents case because
 * ConnectionService is foreground), the action is emitted immediately. If the
 * runtime is temporarily unavailable, the action is persisted and consumed on
 * the next JS startup instead of being dropped.
 */
class CallActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_ACCEPT = "com.m200.G1_CALL_ACCEPT"
        const val ACTION_REJECT = "com.m200.G1_CALL_REJECT"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val callId = intent.getStringExtra("callId") ?: return
        val action = when (intent.action) {
            ACTION_ACCEPT -> "accept"
            ACTION_REJECT -> "reject"
            else -> return
        }

        val prefs = context.getSharedPreferences(CallNotificationModule.PREFS, Context.MODE_PRIVATE)
        prefs.edit()
            .putString("pendingAction", action)
            .putString("pendingActionCallId", callId)
            .putLong("pendingActionAt", System.currentTimeMillis())
            .apply()

        val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.cancel(CallNotificationModule.notificationId(callId))

        var emitted = false
        try {
            val application = context.applicationContext as? MainApplication
            val reactContext = application
                ?.reactNativeHost
                ?.reactInstanceManager
                ?.currentReactContext
            if (reactContext != null) {
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit(CallNotificationModule.EVENT_CALL_ACTION, Arguments.createMap().apply {
                        putString("action", action)
                        putString("callId", callId)
                    })
                prefs.edit()
                    .remove("pendingAction")
                    .remove("pendingActionCallId")
                    .remove("pendingActionAt")
                    .apply()
                emitted = true
            }
        } catch (_: Exception) {}

        // Answer should surface the call UI. This launch is user-initiated via
        // a PendingIntent, so it is the correct place to bring the Activity up.
        // Reject remains silent when JS is alive; if JS was unavailable we also
        // open the app so the persisted action can be consumed and signaled.
        if (action == "accept" || !emitted) {
            try {
                context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra("g1CallId", callId)
                    putExtra("g1CallAction", action)
                }?.let(context::startActivity)
            } catch (_: Exception) {}
        }
    }
}
