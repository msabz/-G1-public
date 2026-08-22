package com.m200.filesharing

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Base64
import androidx.core.content.FileProvider
import com.facebook.react.bridge.*
import java.io.File
import java.util.zip.Deflater

class FilePickerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext), ActivityEventListener {
    private var pickPromise: Promise? = null
    private val REQUEST_CODE = 7421
    private val CAPTURE_CODE = 7422
    private var captureUri: Uri? = null
    private var captureFile: File? = null

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getName() = "FilePickerModule"

    @ReactMethod
    fun pickFile(promise: Promise) {
        val activity = currentActivity
        if (activity == null) { promise.reject("ERROR", "لا يوجد نشاط حالي"); return }
        pickPromise = promise
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
        intent.addCategory(Intent.CATEGORY_OPENABLE)
        intent.type = "*/*"
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        try {
            activity.startActivityForResult(intent, REQUEST_CODE)
        } catch (e: Exception) {
            pickPromise?.reject("ERROR", e.message)
            pickPromise = null
        }
    }

    override fun onActivityResult(activity: Activity?, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == CAPTURE_CODE) {
            val promise = pickPromise ?: return
            pickPromise = null
            if (resultCode != Activity.RESULT_OK || captureFile == null || !captureFile!!.exists()) {
                promise.reject("CANCELLED", "تم الإلغاء")
                return
            }
            val f = captureFile!!
            val result = Arguments.createMap().apply {
                putString("uri", f.absolutePath)
                putString("name", f.name)
                putString("mimeType", "image/jpeg")
                putDouble("size", f.length().toDouble())
            }
            promise.resolve(result)
            return
        }
        if (requestCode != REQUEST_CODE) return
        val promise = pickPromise ?: return
        pickPromise = null
        if (resultCode != Activity.RESULT_OK || (data?.data == null && data?.clipData == null)) {
            promise.reject("CANCELLED", "تم الإلغاء")
            return
        }
        try {
            val resolver = reactApplicationContext.contentResolver
            val uris = mutableListOf<Uri>()
            val clip = data.clipData
            if (clip != null) {
                for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
            } else {
                data.data?.let { uris.add(it) }
            }

            if (uris.isEmpty()) {
                promise.reject("CANCELLED", "لم يتم اختيار أي ملف")
                return
            }

            val arr = Arguments.createArray()
            for (uri in uris) {
                var name = "file"
                var size = 0L
                resolver.query(uri, null, null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (nameIdx >= 0) name = cursor.getString(nameIdx) ?: name
                        if (sizeIdx >= 0) size = cursor.getLong(sizeIdx)
                    }
                }
                val mimeType = resolver.getType(uri) ?: "application/octet-stream"
                arr.pushMap(Arguments.createMap().apply {
                    putString("uri", uri.toString())
                    putString("name", name)
                    putString("mimeType", mimeType)
                    putDouble("size", size.toDouble())
                })
            }

            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    override fun onNewIntent(intent: Intent?) {}

    @ReactMethod
    fun captureImage(promise: Promise) {
        val activity = currentActivity
        if (activity == null) { promise.reject("ERROR", "لا يوجد نشاط حالي"); return }
        try {
            val dir = File(reactApplicationContext.cacheDir, "captures").apply { mkdirs() }
            val file = File(dir, "IMG_${System.currentTimeMillis()}.jpg")
            captureFile = file
            val uri = FileProvider.getUriForFile(
                reactApplicationContext,
                "${reactApplicationContext.packageName}.fileprovider",
                file
            )
            captureUri = uri
            pickPromise = promise

            val intent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
            intent.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, uri)
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            activity.startActivityForResult(intent, CAPTURE_CODE)
        } catch (e: Exception) {
            pickPromise = null
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun listInstalledApps(promise: Promise) {
        try {
            val pm = reactApplicationContext.packageManager
            val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
            val arr = Arguments.createArray()
            for (app in apps) {
                val isSystem = (app.flags and ApplicationInfo.FLAG_SYSTEM) != 0
                val isUpdatedSystem = (app.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
                if (isSystem && !isUpdatedSystem) continue
                val apkPath = app.sourceDir ?: continue
                val apkFile = File(apkPath)
                if (!apkFile.exists()) continue

                val splitPaths = app.splitSourceDirs
                val totalSize = apkFile.length() +
                    (splitPaths?.sumOf { p -> File(p).let { if (it.exists()) it.length() else 0L } } ?: 0L)

                val splitsArr = Arguments.createArray()
                splitPaths?.forEach { sp -> if (File(sp).exists()) splitsArr.pushString(sp) }
                val appLabel = pm.getApplicationLabel(app).toString()

                arr.pushMap(Arguments.createMap().apply {
                    putString("packageName", app.packageName)
                    putString("appName", appLabel)
                    putString("apkPath", apkPath)
                    putArray("splitPaths", splitsArr)
                    putInt("splitCount", splitsArr.size())
                    putBoolean("hasSplits", splitsArr.size() > 0)
                    putDouble("size", totalSize.toDouble())
                    putString("suggestedFileName", buildApkFileName(appLabel, app.packageName, splitsArr.size() > 0))
                })
            }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    private fun buildApkFileName(appLabel: String, packageName: String, hasSplits: Boolean): String {
        val safeLabel = appLabel
            .replace(Regex("[\\\\/:*?\"<>|]"), "")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(50)
            .ifBlank { packageName }
        val ext = if (hasSplits) "apks" else "apk"
        return "$safeLabel.$ext"
    }

    /**
     * Use PackageManager's authoritative sourceDir/splitSourceDirs only.
     * A peer receives one stable package artifact regardless of transport:
     * a named .apk for single-APK apps or a named .apks ZIP for split apps.
     */
    private fun collectApkFiles(app: ApplicationInfo): List<File> {
        val files = linkedSetOf<File>()
        File(app.sourceDir).let { if (it.exists()) files.add(it) }
        app.splitSourceDirs?.forEach { sp -> File(sp).let { if (it.exists()) files.add(it) } }
        return files.toList()
    }

    @ReactMethod
    fun packageAppForSending(packageName: String, promise: Promise) {
        try {
            val pm = reactApplicationContext.packageManager
            val app = pm.getApplicationInfo(packageName, 0)
            val label = pm.getApplicationLabel(app).toString()
            val allApks = collectApkFiles(app)
            if (allApks.isEmpty()) throw Exception("لم يتم العثور على ملفات التطبيق")

            val outDir = File(reactApplicationContext.cacheDir, "apks").apply { mkdirs() }

            if (allApks.size == 1) {
                // Never return /data/app/.../base.apk directly. FileTransfer
                // intentionally derives wire metadata from the source artifact,
                // so returning base.apk loses the app's real name at the receiver.
                val source = allApks.first()
                val outFile = File(outDir, buildApkFileName(label, packageName, false))
                if (outFile.exists()) outFile.delete()
                source.inputStream().buffered().use { input ->
                    outFile.outputStream().buffered().use { output -> input.copyTo(output, 64 * 1024) }
                }
                if (outFile.length() != source.length()) {
                    outFile.delete()
                    throw Exception("فشل تجهيز نسخة APK كاملة للإرسال")
                }
                promise.resolve(Arguments.createMap().apply {
                    putString("path", outFile.absolutePath)
                    putString("fileName", outFile.name)
                    putString("mimeType", "application/vnd.android.package-archive")
                    putDouble("size", outFile.length().toDouble())
                    putBoolean("bundled", false)
                    putInt("splitCount", 0)
                })
                return
            }

            val outFile = File(outDir, buildApkFileName(label, packageName, true))
            if (outFile.exists()) outFile.delete()

            java.util.zip.ZipOutputStream(outFile.outputStream().buffered()).use { zip ->
                // APK splits are ZIP archives already. Deflating them again is
                // CPU-expensive and normally saves negligible space, delaying
                // the visible start of transfer. Level 0 preserves the same
                // .apks container/protocol while streaming entries quickly.
                zip.setLevel(Deflater.NO_COMPRESSION)
                allApks.forEachIndexed { index, f ->
                    val rawName = if (index == 0) "base.apk" else f.name
                    val safeEntry = rawName.substringAfterLast('/').substringAfterLast('\\')
                    zip.putNextEntry(java.util.zip.ZipEntry(safeEntry))
                    f.inputStream().buffered().use { it.copyTo(zip, 64 * 1024) }
                    zip.closeEntry()
                }
            }

            if (outFile.length() <= 0L) {
                outFile.delete()
                throw Exception("فشل تجهيز حزمة التطبيق للإرسال")
            }

            promise.resolve(Arguments.createMap().apply {
                putString("path", outFile.absolutePath)
                putString("fileName", outFile.name)
                putString("mimeType", "application/vnd.g1.apks")
                putDouble("size", outFile.length().toDouble())
                putBoolean("bundled", true)
                putInt("splitCount", allApks.size - 1)
            })
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun openReceivedFile(pathOrUri: String, mimeType: String, promise: Promise) {
        try {
            val activity = currentActivity ?: reactApplicationContext
            val uri: Uri = if (pathOrUri.startsWith("content://")) {
                Uri.parse(pathOrUri)
            } else {
                FileProvider.getUriForFile(
                    reactApplicationContext,
                    "${reactApplicationContext.packageName}.fileprovider",
                    File(pathOrUri.replace("file://", ""))
                )
            }
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, if (mimeType.isBlank()) "*/*" else mimeType)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(Intent.createChooser(intent, "فتح باستخدام").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", "لا يوجد تطبيق يستطيع فتح هذا الملف")
        }
    }
}
