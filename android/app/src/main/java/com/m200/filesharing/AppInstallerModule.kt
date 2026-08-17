package com.m200.filesharing

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedInputStream
import java.io.File
import java.io.InputStream
import java.util.zip.ZipInputStream
import kotlin.concurrent.thread

/**
 * Installs received single APKs and split-APK bundles. A normal single APK is
 * handed to Android's interactive package installer so the user immediately
 * sees the familiar install UI. APKS bundles still require one PackageInstaller
 * session containing base.apk + all splits.
 */
class AppInstallerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val ACTION_INSTALL_RESULT = "com.m200.INSTALL_RESULT"
    }

    private var receiverRegistered = false

    override fun getName() = "AppInstallerModule"

    private fun sendEvent(name: String, params: WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, params)
        } catch (_: Exception) {}
    }

    private fun ensureReceiver() {
        if (receiverRegistered) return
        val filter = IntentFilter(ACTION_INSTALL_RESULT)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val status = intent?.getIntExtra(PackageInstaller.EXTRA_STATUS, -999) ?: -999
                val message = intent?.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)

                when (status) {
                    PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                        val confirmIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            intent?.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                        } else {
                            @Suppress("DEPRECATION")
                            intent?.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                        }
                        confirmIntent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        try { reactApplicationContext.startActivity(confirmIntent) } catch (_: Exception) {}
                    }
                    PackageInstaller.STATUS_SUCCESS -> {
                        sendEvent("APP_INSTALL_RESULT", Arguments.createMap().apply {
                            putBoolean("success", true)
                            putString("message", "تم التثبيت بنجاح")
                        })
                    }
                    else -> {
                        sendEvent("APP_INSTALL_RESULT", Arguments.createMap().apply {
                            putBoolean("success", false)
                            putString("message", message ?: "فشل التثبيت (رمز $status)")
                        })
                    }
                }
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            reactApplicationContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            reactApplicationContext.registerReceiver(receiver, filter)
        }
        receiverRegistered = true
    }

    private fun openStream(pathOrUri: String): InputStream {
        return if (pathOrUri.startsWith("content://")) {
            reactApplicationContext.contentResolver.openInputStream(Uri.parse(pathOrUri))
                ?: throw Exception("تعذّر فتح الملف المستلم")
        } else {
            File(pathOrUri.removePrefix("file://")).inputStream()
        }
    }

    private fun toReadableUri(pathOrUri: String): Uri {
        if (pathOrUri.startsWith("content://")) return Uri.parse(pathOrUri)
        val file = File(pathOrUri.removePrefix("file://"))
        if (!file.exists() || !file.isFile) throw Exception("ملف التطبيق غير موجود")
        return FileProvider.getUriForFile(
            reactApplicationContext,
            "${reactApplicationContext.packageName}.fileprovider",
            file
        )
    }

    private fun isZipArchive(pathOrUri: String): Boolean {
        return try {
            openStream(pathOrUri).use { input ->
                val sig = ByteArray(4)
                if (input.read(sig) < 4) return false
                sig[0] == 0x50.toByte() && sig[1] == 0x4B.toByte()
            }
        } catch (_: Exception) { false }
    }

    private fun containsApkEntries(pathOrUri: String): Boolean {
        return try {
            ZipInputStream(BufferedInputStream(openStream(pathOrUri))).use { zip ->
                var entry = zip.nextEntry
                while (entry != null) {
                    if (!entry.isDirectory && entry.name.endsWith(".apk", ignoreCase = true)) return true
                    zip.closeEntry()
                    entry = zip.nextEntry
                }
            }
            false
        } catch (_: Exception) { false }
    }

    private fun ensureInstallPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (reactApplicationContext.packageManager.canRequestPackageInstalls()) return

        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${reactApplicationContext.packageName}")
        ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        try { reactApplicationContext.startActivity(intent) } catch (_: Exception) {}
        throw SecurityException("اسمح لـ G1 DirectChat بتثبيت التطبيقات من هذا المصدر ثم اضغط تثبيت مرة أخرى")
    }

    @ReactMethod
    fun installFromFile(pathOrUri: String, promise: Promise) {
        thread(start = true, name = "G1-AppInstaller") {
            try {
                ensureInstallPermission()
                val isBundle = isZipArchive(pathOrUri) && containsApkEntries(pathOrUri)

                if (isBundle) {
                    ensureReceiver()
                    installBundle(pathOrUri)
                } else {
                    installSingleInteractive(pathOrUri)
                }

                promise.resolve(Arguments.createMap().apply {
                    putBoolean("started", true)
                    putBoolean("bundle", isBundle)
                    putBoolean("interactive", !isBundle)
                })
            } catch (e: SecurityException) {
                promise.reject("INSTALL_PERMISSION_REQUIRED", e.message, e)
            } catch (e: Exception) {
                promise.reject("ERROR", e.message ?: "فشل بدء التثبيت", e)
            }
        }
    }

    /**
     * Single APKs should behave like a normal user-initiated Android install.
     * Let the platform installer own staging/progress/confirmation UI instead
     * of copying bytes into a hidden PackageInstaller session first.
     */
    private fun installSingleInteractive(pathOrUri: String) {
        val uri = toReadableUri(pathOrUri)
        val intent = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
            data = uri
            clipData = ClipData.newRawUri("G1 APK", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        reactApplicationContext.startActivity(intent)
    }

    private fun installBundle(pathOrUri: String) {
        val packageInstaller = reactApplicationContext.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) setInstallReason(PackageManager.INSTALL_REASON_USER)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
            }
        }

        var session: PackageInstaller.Session? = null
        try {
            val sessionId = packageInstaller.createSession(params)
            session = packageInstaller.openSession(sessionId)

            var index = 0
            var baseFound = false
            ZipInputStream(BufferedInputStream(openStream(pathOrUri))).use { zip ->
                var entry = zip.nextEntry
                while (entry != null) {
                    if (!entry.isDirectory && entry.name.endsWith(".apk", ignoreCase = true)) {
                        val leaf = entry.name.substringAfterLast('/').substringAfterLast('\\')
                        if (leaf.equals("base.apk", ignoreCase = true)) baseFound = true
                        val declaredSize = if (entry.size > 0) entry.size else -1L
                        session.openWrite("${index++}.apk", 0, declaredSize).use { out ->
                            val buffer = ByteArray(256 * 1024)
                            var count: Int
                            while (zip.read(buffer).also { count = it } != -1) out.write(buffer, 0, count)
                            session.fsync(out)
                        }
                    }
                    zip.closeEntry()
                    entry = zip.nextEntry
                }
            }

            if (index == 0) throw Exception("لم يتم العثور على أي ملف APK داخل الحزمة")
            if (!baseFound) throw Exception("حزمة التطبيق لا تحتوي base.apk")
            session.commit(buildCallback(sessionId).intentSender)
        } catch (e: Exception) {
            try { session?.abandon() } catch (_: Exception) {}
            throw e
        } finally {
            try { session?.close() } catch (_: Exception) {}
        }
    }

    private fun buildCallback(sessionId: Int): PendingIntent {
        val intent = Intent(ACTION_INSTALL_RESULT).setPackage(reactApplicationContext.packageName)
        return PendingIntent.getBroadcast(
            reactApplicationContext,
            sessionId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_MUTABLE else 0)
        )
    }
}
