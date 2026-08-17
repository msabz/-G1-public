package com.m200.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean

class CameraStreamModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var imageReader: ImageReader? = null
    private var backgroundThread: HandlerThread? = null
    private var backgroundHandler: Handler? = null
    private var frameCounter = 0
    // تخفيف حمل الفيديو: إطار من كل ٣ بدل كل ٢ — الفيديو كان يزاحم الصوت
    // على الشبكة ويسبب تقطيعه. أقل إطارات = صوت أنظف.
    private val frameSkip = 2
    private val startResolved = AtomicBoolean(false)

    // اتجاه حسّاس الكاميرا بالدرجات — بمعظم أجهزة أندرويد الحسّاس مركّب مدوّر ٩٠ درجة،
    // وهاد بالضبط سبب الصورة المقلوبة. لازم ندوّر الصورة بنفس المقدار قبل ما نبعتها.
    private var sensorOrientation = 0
    private var isFrontCamera = true
    @Volatile private var streaming = false

    override fun getName() = "CameraStreamModule"

    private fun startBackgroundThread() {
        if (backgroundThread != null) return
        backgroundThread = HandlerThread("CameraBackground").also { it.start() }
        backgroundHandler = Handler(backgroundThread!!.looper)
    }

    private fun stopBackgroundThread() {
        backgroundThread?.quitSafely()
        try { backgroundThread?.join() } catch (e: Exception) {}
        backgroundThread = null
        backgroundHandler = null
    }

    @ReactMethod
    fun startCapture(promise: Promise) {
        openCameraInternal(isFrontCamera,
            onOk = { promise.resolve(true) },
            onErr = { msg -> promise.reject("ERROR", msg) })
    }

    // تبديل بين الكاميرا الأمامية والخلفية أثناء المكالمة
    @ReactMethod
    fun switchCamera(promise: Promise) {
        val target = !isFrontCamera
        closeCameraOnly()
        openCameraInternal(target,
            onOk = { promise.resolve(target) },
            onErr = { msg -> promise.reject("ERROR", msg) })
    }

    private fun openCameraInternal(front: Boolean, onOk: () -> Unit, onErr: (String?) -> Unit) {
        try {
            startResolved.set(false)
            startBackgroundThread()
            val manager = reactApplicationContext.getSystemService(Context.CAMERA_SERVICE) as CameraManager

            val wantedFacing = if (front) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK
            val cameraId = manager.cameraIdList.firstOrNull { id ->
                manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) == wantedFacing
            } ?: manager.cameraIdList.firstOrNull()

            if (cameraId == null) { onErr("لا توجد كاميرا متاحة"); return }

            val chars = manager.getCameraCharacteristics(cameraId)
            sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
            isFrontCamera = chars.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT

            streaming = true
            imageReader = ImageReader.newInstance(400, 300, ImageFormat.YUV_420_888, 2).apply {
                setOnImageAvailableListener({ reader ->
                    val image = try { reader.acquireLatestImage() } catch (e: Exception) { null }
                    if (image != null) {
                        frameCounter++
                        if (streaming && frameCounter % (frameSkip + 1) == 0) {
                            val jpegBase64 = imageToJpegBase64(image)
                            if (jpegBase64 != null) {
                                sendEvent("CAMERA_FRAME", Arguments.createMap().apply { putString("data", jpegBase64) })
                            }
                        }
                        image.close()
                    }
                }, backgroundHandler)
            }

            manager.openCamera(cameraId, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    cameraDevice = camera
                    val surface = imageReader!!.surface
                    camera.createCaptureSession(listOf(surface), object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(session: CameraCaptureSession) {
                            captureSession = session
                            try {
                                val rb = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                                rb.addTarget(surface)
                                rb.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                                // تثبيت التعرّض وتوازن الأبيض يمنع تذبذب السطوع بين إطار وإطار
                                rb.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                                rb.set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO)
                                rb.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                                session.setRepeatingRequest(rb.build(), null, backgroundHandler)
                                if (startResolved.compareAndSet(false, true)) onOk()
                            } catch (e: Exception) {
                                if (startResolved.compareAndSet(false, true)) onErr(e.message)
                            }
                        }
                        override fun onConfigureFailed(session: CameraCaptureSession) {
                            if (startResolved.compareAndSet(false, true)) onErr("فشل تهيئة جلسة الكاميرا")
                        }
                    }, backgroundHandler)
                }
                override fun onDisconnected(camera: CameraDevice) {
                    camera.close(); cameraDevice = null
                }
                override fun onError(camera: CameraDevice, error: Int) {
                    camera.close(); cameraDevice = null
                    if (startResolved.compareAndSet(false, true)) onErr("خطأ كاميرا: $error")
                }
            }, backgroundHandler)
        } catch (e: Exception) {
            if (startResolved.compareAndSet(false, true)) onErr(e.message)
        }
    }

    private fun imageToJpegBase64(image: Image): String? {
        return try {
            // قراءة صحيحة لمستويات YUV مع احترام rowStride/pixelStride —
            // النسخة القديمة كانت تفترض إن البيانات متلاصقة، وهاد بيسبب تشويش
            // على الأجهزة يلي بتحط padding بالذاكرة.
            val width = image.width
            val height = image.height
            val yPlane = image.planes[0]
            val uPlane = image.planes[1]
            val vPlane = image.planes[2]

            val nv21 = ByteArray(width * height * 3 / 2)

            var pos = 0
            val yBuffer = yPlane.buffer
            val yRowStride = yPlane.rowStride
            val yPixelStride = yPlane.pixelStride
            if (yPixelStride == 1 && yRowStride == width) {
                yBuffer.get(nv21, 0, width * height)
                pos = width * height
            } else {
                val rowData = ByteArray(yRowStride)
                for (row in 0 until height) {
                    yBuffer.position(row * yRowStride)
                    val toRead = minOf(yRowStride, yBuffer.remaining())
                    yBuffer.get(rowData, 0, toRead)
                    for (col in 0 until width) {
                        nv21[pos++] = rowData[col * yPixelStride]
                    }
                }
            }

            // تشابك V ثم U (صيغة NV21) مع احترام الـ strides
            val chromaHeight = height / 2
            val chromaWidth = width / 2
            val uBuffer = uPlane.buffer
            val vBuffer = vPlane.buffer
            val uRowStride = uPlane.rowStride
            val vRowStride = vPlane.rowStride
            val uPixelStride = uPlane.pixelStride
            val vPixelStride = vPlane.pixelStride

            for (row in 0 until chromaHeight) {
                for (col in 0 until chromaWidth) {
                    val vIndex = row * vRowStride + col * vPixelStride
                    val uIndex = row * uRowStride + col * uPixelStride
                    nv21[pos++] = if (vIndex < vBuffer.limit()) vBuffer.get(vIndex) else 0
                    nv21[pos++] = if (uIndex < uBuffer.limit()) uBuffer.get(uIndex) else 0
                }
            }

            val yuvImage = YuvImage(nv21, ImageFormat.NV21, width, height, null)
            val out = ByteArrayOutputStream()
            yuvImage.compressToJpeg(Rect(0, 0, width, height), 42, out)
            var jpegBytes = out.toByteArray()

            // تصحيح الدوران حسب اتجاه الحسّاس + عكس أفقي للكاميرا الأمامية (زي المرآة).
            // ملاحظة: للكاميرا الأمامية منستخدم زاوية الحسّاس مباشرةً — استخدام
            // (360 - sensor) كان بيقلب الصورة رأساً على عقب بفرق ١٨٠ درجة.
            val rotation = sensorOrientation
            if (rotation != 0 || isFrontCamera) {
                jpegBytes = rotateJpeg(jpegBytes, rotation.toFloat(), isFrontCamera) ?: jpegBytes
            }

            Base64.encodeToString(jpegBytes, Base64.NO_WRAP)
        } catch (e: Exception) { null }
    }

    private fun rotateJpeg(jpeg: ByteArray, degrees: Float, mirror: Boolean): ByteArray? {
        return try {
            val bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: return null
            val matrix = Matrix()
            matrix.postRotate(degrees)
            if (mirror) matrix.postScale(-1f, 1f)
            val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
            val out = ByteArrayOutputStream()
            rotated.compress(Bitmap.CompressFormat.JPEG, 42, out)
            if (rotated != bitmap) rotated.recycle()
            bitmap.recycle()
            out.toByteArray()
        } catch (e: Exception) { null }
    }

    private fun closeCameraOnly() {
        streaming = false
        try { captureSession?.stopRepeating() } catch (e: Exception) {}
        try { captureSession?.close() } catch (e: Exception) {}
        captureSession = null
        try { cameraDevice?.close() } catch (e: Exception) {}
        cameraDevice = null
        try { imageReader?.close() } catch (e: Exception) {}
        imageReader = null
    }

    @ReactMethod
    fun stopCapture(promise: Promise) {
        try {
            closeCameraOnly()
            stopBackgroundThread()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    private fun sendEvent(name: String, params: WritableMap) {
        reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, params)
    }
}
