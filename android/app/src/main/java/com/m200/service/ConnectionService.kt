package com.m200.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Foreground availability service for G1 DirectChat.
 *
 * IDLE mode keeps the process eligible to receive LAN/P2P signaling while the
 * UI is backgrounded, but releases CPU/Wi-Fi performance locks. ACTIVE mode is
 * used while a live session exists and holds the locks required for long calls
 * and transfers. Android Force Stop remains an OS-level hard stop by design.
 */
class ConnectionService : Service() {

    companion object {
        const val CHANNEL_ID = "g1_connection"
        const val MESSAGE_CHANNEL_ID = "g1_messages"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = "com.m200.START_CONNECTION_SERVICE"
        const val ACTION_IDLE = "com.m200.IDLE_CONNECTION_SERVICE"
        const val ACTION_STOP = "com.m200.STOP_CONNECTION_SERVICE"
        const val ACTION_UPDATE = "com.m200.UPDATE_CONNECTION_SERVICE"
        const val EXTRA_STATUS = "status"
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var activeMode = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(
            CHANNEL_ID, "اتصال G1", NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "يبقي G1 DirectChat جاهزاً لاستقبال الاتصالات"
            setShowBadge(false)
            enableVibration(false)
        })
        nm.createNotificationChannel(NotificationChannel(
            MESSAGE_CHANNEL_ID, "رسائل G1", NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "إشعارات الرسائل والملفات والمكالمات الواردة"
            enableVibration(true)
        })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                activeMode = false
                releaseLocks()
                stopForeground(true)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_IDLE -> {
                activeMode = false
                releaseLocks()
                startForeground(
                    NOTIFICATION_ID,
                    buildNotification(intent.getStringExtra(EXTRA_STATUS) ?: "جاهز لاستقبال الأجهزة القريبة")
                )
            }
            ACTION_START, ACTION_UPDATE -> {
                activeMode = true
                val status = intent.getStringExtra(EXTRA_STATUS) ?: "متصل"
                startForeground(NOTIFICATION_ID, buildNotification(status))
                acquireLocks()
            }
            else -> {
                // START_STICKY restart after process pressure: restore only the
                // low-power availability state. JS/native listeners can rebind
                // when the React process becomes ready without burning locks.
                activeMode = false
                releaseLocks()
                startForeground(NOTIFICATION_ID, buildNotification("G1 جاهز للاستقبال"))
            }
        }
        return START_STICKY
    }

    private fun buildNotification(status: String): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("G1 DirectChat")
            .setContentText(status)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pending)
            .build()
    }

    private fun acquireLocks() {
        try {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "G1::ConnectionLock").apply {
                    setReferenceCounted(false)
                }
            }
            if (wakeLock?.isHeld != true) wakeLock?.acquire(4 * 60 * 60 * 1000L)
        } catch (_: Exception) {}

        try {
            if (wifiLock == null) {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                    WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
                wifiLock = wm.createWifiLock(mode, "G1::WifiLock").apply { setReferenceCounted(false) }
            }
            if (wifiLock?.isHeld != true) wifiLock?.acquire()
        } catch (_: Exception) {}
    }

    private fun releaseLocks() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {}
        try { if (wifiLock?.isHeld == true) wifiLock?.release() } catch (_: Exception) {}
        wakeLock = null
        wifiLock = null
    }

    override fun onDestroy() {
        releaseLocks()
        super.onDestroy()
    }
}
