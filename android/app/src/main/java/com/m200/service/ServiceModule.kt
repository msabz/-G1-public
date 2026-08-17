package com.m200.service

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.*

class ServiceModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ServiceModule"

    private fun startServiceIntent(intent: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactApplicationContext.startForegroundService(intent)
        } else {
            reactApplicationContext.startService(intent)
        }
    }

    @ReactMethod
    fun startConnectionService(status: String, promise: Promise) {
        try {
            startServiceIntent(Intent(reactApplicationContext, ConnectionService::class.java).apply {
                action = ConnectionService.ACTION_START
                putExtra(ConnectionService.EXTRA_STATUS, status)
            })
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun startAvailabilityService(status: String, promise: Promise) {
        try {
            startServiceIntent(Intent(reactApplicationContext, ConnectionService::class.java).apply {
                action = ConnectionService.ACTION_IDLE
                putExtra(ConnectionService.EXTRA_STATUS, status)
            })
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun updateConnectionStatus(status: String, promise: Promise) {
        try {
            startServiceIntent(Intent(reactApplicationContext, ConnectionService::class.java).apply {
                action = ConnectionService.ACTION_UPDATE
                putExtra(ConnectionService.EXTRA_STATUS, status)
            })
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun stopConnectionService(promise: Promise) {
        try {
            startServiceIntent(Intent(reactApplicationContext, ConnectionService::class.java).apply {
                action = ConnectionService.ACTION_IDLE
                putExtra(ConnectionService.EXTRA_STATUS, "جاهز لاستقبال الأجهزة القريبة")
            })
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun stopAvailabilityService(promise: Promise) {
        try {
            reactApplicationContext.startService(Intent(reactApplicationContext, ConnectionService::class.java).apply {
                action = ConnectionService.ACTION_STOP
            })
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun showMessageNotification(title: String, body: String, promise: Promise) {
        try {
            val nm = reactApplicationContext
                .getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            val launchIntent = reactApplicationContext.packageManager
                .getLaunchIntentForPackage(reactApplicationContext.packageName)?.apply {
                    flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
            val pending = android.app.PendingIntent.getActivity(
                reactApplicationContext, 0, launchIntent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) android.app.PendingIntent.FLAG_IMMUTABLE else 0)
            )

            val notification = NotificationCompat.Builder(reactApplicationContext, ConnectionService.MESSAGE_CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pending)
                .build()

            nm.notify(System.currentTimeMillis().toInt(), notification)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun clearMessageNotifications(promise: Promise) {
        try {
            val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                nm.activeNotifications
                    .filter { it.id != ConnectionService.NOTIFICATION_ID }
                    .forEach { nm.cancel(it.id) }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }
}
