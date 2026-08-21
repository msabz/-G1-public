package com.m200.service

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.WriterException
import com.google.zxing.integration.android.IntentIntegrator
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.EnumMap

class G1QrModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    private var pendingScanPromise: Promise? = null

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getName() = "G1QrModule"

    private fun qrBitmap(payload: String, requestedSize: Int): Bitmap {
        require(payload.isNotBlank() && payload.length <= 4096) { "Invalid G1 QR payload size" }
        val size = requestedSize.coerceIn(240, 1400)
        val hints = EnumMap<EncodeHintType, Any>(EncodeHintType::class.java).apply {
            put(EncodeHintType.CHARACTER_SET, "UTF-8")
            put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M)
            put(EncodeHintType.MARGIN, 2)
        }
        val matrix = try {
            QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size, hints)
        } catch (e: WriterException) {
            throw IllegalArgumentException("Unable to encode G1 QR", e)
        }
        val pixels = IntArray(size * size)
        for (y in 0 until size) {
            val row = y * size
            for (x in 0 until size) {
                pixels[row + x] = if (matrix[x, y]) Color.BLACK else Color.WHITE
            }
        }
        return Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888).apply {
            setPixels(pixels, 0, size, 0, 0, size, size)
        }
    }

    @ReactMethod
    fun renderQrDataUri(payload: String, size: Int, promise: Promise) {
        try {
            val bitmap = qrBitmap(payload, size)
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            bitmap.recycle()
            val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            promise.resolve("data:image/png;base64,$b64")
        } catch (e: Exception) {
            promise.reject("G1_QR_RENDER_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun copyText(text: String, promise: Promise) {
        try {
            require(text.length <= 4096) { "Text too large" }
            val clipboard = reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("G1 Number", text))
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("G1_CLIPBOARD_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun shareQrCode(payload: String, g1Number: String, promise: Promise) {
        try {
            val bitmap = qrBitmap(payload, 1024)
            val dir = File(reactContext.cacheDir, "g1-share").apply { mkdirs() }
            // Bound cache growth: retain only a few previous share images.
            dir.listFiles()
                ?.filter { it.isFile && it.name.startsWith("g1-contact-") && it.name.endsWith(".png") }
                ?.sortedByDescending { it.lastModified() }
                ?.drop(7)
                ?.forEach { runCatching { it.delete() } }
            val file = File(dir, "g1-contact-${System.currentTimeMillis()}.png")
            FileOutputStream(file).use { stream ->
                if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) {
                    throw IllegalStateException("Failed to encode QR image")
                }
            }
            bitmap.recycle()

            val uri: Uri = FileProvider.getUriForFile(
                reactContext,
                "${reactContext.packageName}.fileprovider",
                file
            )
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "image/png"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_TEXT, g1Number)
                clipData = ClipData.newRawUri("G1 QR", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, "مشاركة رمز G1")
            val activity = currentActivity
            if (activity != null) {
                activity.startActivity(chooser)
            } else {
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactContext.startActivity(chooser)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("G1_QR_SHARE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun scanQrCode(promise: Promise) {
        try {
            if (pendingScanPromise != null) {
                promise.reject("G1_QR_SCAN_BUSY", "A G1 QR scan is already active")
                return
            }
            val activity = currentActivity
            if (activity == null) {
                promise.reject("G1_QR_SCAN_NO_ACTIVITY", "No foreground activity is available")
                return
            }
            if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                promise.reject("G1_QR_CAMERA_PERMISSION", "Camera permission is required")
                return
            }

            pendingScanPromise = promise
            IntentIntegrator(activity).apply {
                setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
                setPrompt("امسح رمز G1")
                setBeepEnabled(false)
                setBarcodeImageEnabled(false)
                setOrientationLocked(false)
                initiateScan()
            }
        } catch (e: Exception) {
            pendingScanPromise = null
            promise.reject("G1_QR_SCAN_ERROR", e.message, e)
        }
    }

    override fun onActivityResult(activity: Activity?, requestCode: Int, resultCode: Int, data: Intent?) {
        val promise = pendingScanPromise ?: return
        val result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data) ?: return
        pendingScanPromise = null
        promise.resolve(result.contents)
    }

    override fun onNewIntent(intent: Intent?) = Unit
}
