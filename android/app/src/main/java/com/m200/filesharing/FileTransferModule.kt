package com.m200.filesharing

import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.OpenableColumns
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Raw streaming data plane on TCP 8090. It is deliberately independent from
 * signaling 8089: a transfer failure never owns or tears down the chat/call
 * session. Completion is transactional: receiver persists + hashes the payload
 * and returns an ACK before sender reports success.
 */
class FileTransferModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val PORT = 8090
    private val BUFFER_SIZE = 256 * 1024
    private val SOCKET_BUFFER_BYTES = 1024 * 1024
    private val PROGRESS_BYTES = 4L * 1024L * 1024L
    private val PROGRESS_INTERVAL_MS = 300L
    private val ACK_MAX_BYTES = 8 * 1024
    private val DOWNLOAD_RELATIVE_PATH = "Download/G1 DirectChat"
    private var serverSocket: ServerSocket? = null
    @Volatile private var serverRunning = false
    private val outgoingCancelFlags = ConcurrentHashMap<String, AtomicBoolean>()

    override fun getName() = "FileTransferModule"

    private fun sendEvent(name: String, params: WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, params)
        } catch (_: Exception) {}
    }

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    private fun cleanPath(value: String): String = value.removePrefix("file://")

    private fun averageMbps(bytes: Long, elapsedMs: Long): Double {
        if (bytes <= 0L || elapsedMs <= 0L) return 0.0
        return (bytes.toDouble() * 8.0) / (elapsedMs.toDouble() * 1000.0)
    }

    private fun shouldReportProgress(bytesSinceLast: Long, elapsedSinceLastMs: Long, complete: Boolean): Boolean {
        return complete || bytesSinceLast >= PROGRESS_BYTES || elapsedSinceLastMs >= PROGRESS_INTERVAL_MS
    }

    private fun tuneSocket(socket: Socket) {
        try { socket.tcpNoDelay = true } catch (_: Exception) {}
        try { socket.keepAlive = true } catch (_: Exception) {}
        try { socket.sendBufferSize = SOCKET_BUFFER_BYTES } catch (_: Exception) {}
        try { socket.receiveBufferSize = SOCKET_BUFFER_BYTES } catch (_: Exception) {}
    }

    private fun mimeForPlainFile(fileName: String, kind: String): String {
        val lower = fileName.lowercase()
        return when {
            kind == "voice" -> "audio/mp4"
            lower.endsWith(".apk") -> "application/vnd.android.package-archive"
            lower.endsWith(".apks") -> "application/vnd.g1.apks"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".webp") -> "image/webp"
            else -> "application/octet-stream"
        }
    }

    /**
     * Android/MediaStore may resolve duplicate names as `name.apk (1)`, which
     * destroys the effective APK extension. G1 owns collision resolution so the
     * suffix always appears before the extension: `name (1).apk`.
     */
    private fun splitFileNameForCollision(fileName: String): Pair<String, String> {
        val leaf = fileName.substringAfterLast('/').substringAfterLast('\\').ifBlank { "file" }
        val lower = leaf.lowercase()
        val extension = when {
            lower.endsWith(".apks") -> leaf.takeLast(5)
            lower.endsWith(".apk") -> leaf.takeLast(4)
            else -> {
                val dot = leaf.lastIndexOf('.')
                if (dot > 0 && dot < leaf.length - 1) leaf.substring(dot) else ""
            }
        }
        val stem = if (extension.isNotEmpty()) leaf.dropLast(extension.length) else leaf
        return stem.ifBlank { "file" } to extension
    }

    private fun isDisplayNameTaken(collection: Uri, displayName: String): Boolean {
        val resolver = reactApplicationContext.contentResolver
        return try {
            resolver.query(
                collection,
                arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns.DISPLAY_NAME}=?",
                arrayOf(displayName),
                null
            )?.use { it.moveToFirst() } ?: false
        } catch (_: Exception) {
            false
        }
    }

    private fun readDisplayName(uri: Uri): String? {
        return try {
            reactApplicationContext.contentResolver.query(
                uri,
                arrayOf(MediaStore.MediaColumns.DISPLAY_NAME),
                null,
                null,
                null
            )?.use { cursor ->
                if (!cursor.moveToFirst()) return@use null
                val idx = cursor.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME)
                if (idx >= 0 && !cursor.isNull(idx)) cursor.getString(idx) else null
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun hasRequiredPackageExtension(displayName: String, requestedName: String): Boolean {
        val requested = requestedName.lowercase()
        val actual = displayName.lowercase()
        return when {
            requested.endsWith(".apks") -> actual.endsWith(".apks")
            requested.endsWith(".apk") -> actual.endsWith(".apk")
            else -> true
        }
    }

    /**
     * Query + insert are serialized inside this process to avoid two concurrent
     * incoming transfers selecting the same candidate. We then verify the name
     * MediaStore actually committed; vendor implementations are not trusted to
     * preserve APK/APKS extensions during collision handling.
     */
    @Synchronized
    private fun createDownloadDestination(requestedName: String, mimeType: String): Pair<Uri, String> {
        val resolver = reactApplicationContext.contentResolver
        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Downloads.EXTERNAL_CONTENT_URI
        } else {
            MediaStore.Files.getContentUri("external")
        }
        val (stem, extension) = splitFileNameForCollision(requestedName)

        for (index in 0..9999) {
            val candidate = if (index == 0) "$stem$extension" else "$stem ($index)$extension"
            if (isDisplayNameTaken(collection, candidate)) continue

            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, candidate)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(MediaStore.MediaColumns.RELATIVE_PATH, DOWNLOAD_RELATIVE_PATH)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
            }
            val uri = resolver.insert(collection, values) ?: continue
            val actualName = readDisplayName(uri) ?: candidate

            if (hasRequiredPackageExtension(actualName, requestedName)) {
                return uri to actualName
            }

            try { resolver.delete(uri, null, null) } catch (_: Exception) {}
        }
        throw IOException("تعذّر إنشاء اسم ملف فريد مع الحفاظ على الامتداد")
    }

    private fun writeCompletionAck(socket: Socket, transferId: String, size: Long, sha256: String) {
        val ack = JSONObject().apply {
            put("type", "complete")
            put("id", transferId)
            put("size", size)
            put("sha256", sha256)
        }.toString().toByteArray(Charsets.UTF_8)
        if (ack.size > ACK_MAX_BYTES) throw IOException("رد اكتمال النقل أكبر من الحد المسموح")
        val output = DataOutputStream(BufferedOutputStream(socket.getOutputStream()))
        output.writeInt(ack.size)
        output.write(ack)
        output.flush()
    }

    private fun readAndVerifyCompletionAck(
        socket: Socket,
        transferId: String,
        sent: Long,
        senderSha256: String
    ) {
        val input = DataInputStream(BufferedInputStream(socket.getInputStream()))
        val ackLen = input.readInt()
        if (ackLen <= 0 || ackLen > ACK_MAX_BYTES) throw IOException("رد اكتمال نقل الملف غير صالح")
        val ackBytes = ByteArray(ackLen)
        input.readFully(ackBytes)
        val ack = JSONObject(String(ackBytes, Charsets.UTF_8))
        if (ack.optString("type") != "complete") throw IOException("لم يؤكد الطرف الآخر اكتمال الملف")
        if (ack.optString("id") != transferId) throw IOException("معرّف تأكيد الملف لا يطابق عملية النقل")
        if (ack.optLong("size", -1L) != sent) throw IOException("حجم الملف المؤكد من الطرف الآخر لا يطابق الحجم المرسل")
        val receiverSha256 = ack.optString("sha256")
        if (receiverSha256.isBlank() || !receiverSha256.equals(senderSha256, ignoreCase = true)) {
            throw IOException("فشل التحقق من سلامة الملف بعد النقل")
        }
    }

    @ReactMethod
    fun startServer(promise: Promise) {
        if (serverRunning && serverSocket?.isClosed == false) { promise.resolve(true); return }
        try {
            try { serverSocket?.close() } catch (_: Exception) {}
            val ss = ServerSocket()
            ss.reuseAddress = true
            ss.bind(InetSocketAddress("0.0.0.0", PORT))
            serverSocket = ss
            serverRunning = true

            thread(start = true, name = "G1-FileServer") {
                while (serverRunning) {
                    try {
                        val client = ss.accept()
                        tuneSocket(client)
                        thread(start = true, name = "G1-FileIncoming") { handleIncoming(client) }
                    } catch (_: Exception) {
                        if (!serverRunning) break
                    }
                }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            serverRunning = false
            serverSocket = null
            promise.reject("ERROR", e.message)
        }
    }

    private fun handleIncoming(socket: Socket) {
        var transferId = ""
        var cacheFile: File? = null
        var outUri: Uri? = null
        var output: java.io.OutputStream? = null
        var completed = false
        var storedFileName = "file"
        val startedAt = SystemClock.elapsedRealtime()
        try {
            socket.soTimeout = 120000
            val input = DataInputStream(BufferedInputStream(socket.getInputStream(), BUFFER_SIZE))
            val headerLen = input.readInt()
            if (headerLen <= 0 || headerLen > 64 * 1024) throw IOException("رأس نقل الملف غير صالح")
            val headerBytes = ByteArray(headerLen)
            input.readFully(headerBytes)
            val header = JSONObject(String(headerBytes, Charsets.UTF_8))

            transferId = header.optString("id")
            if (transferId.isBlank()) throw IOException("معرّف نقل الملف مفقود")
            val rawFileName = header.optString("fileName", "file")
            val fileName = rawFileName.substringAfterLast('/').substringAfterLast('\\').ifBlank { "file" }
            storedFileName = fileName
            val mimeType = header.optString("mimeType", "application/octet-stream")
            val kind = header.optString("kind", "file")
            val totalSize = header.optLong("size", 0L).coerceAtLeast(0L)

            val transferLimit = IncomingTransferLimit(totalSize)
            val digest = MessageDigest.getInstance("SHA-256")

            if (kind == "voice") {
                cacheFile = File(reactApplicationContext.cacheDir, "voice_${System.currentTimeMillis()}.m4a")
                output = BufferedOutputStream(cacheFile.outputStream(), BUFFER_SIZE)
            } else {
                val destination = createDownloadDestination(fileName, mimeType)
                outUri = destination.first
                storedFileName = destination.second
                output = BufferedOutputStream(
                    reactApplicationContext.contentResolver.openOutputStream(outUri, "w")
                        ?: throw IOException("تعذّر فتح ملف الاستقبال"),
                    BUFFER_SIZE
                )
            }

            sendEvent("FT_INCOMING_START", Arguments.createMap().apply {
                putString("id", transferId)
                putString("fileName", storedFileName)
                putString("mimeType", mimeType)
                putString("kind", kind)
                putDouble("size", totalSize.toDouble())
            })

            val buffer = ByteArray(BUFFER_SIZE)
            var lastReportBytes = 0L
            var lastReportAt = SystemClock.elapsedRealtime()
            while (true) {
                val toRead = transferLimit.nextReadLimit(BUFFER_SIZE)
                if (toRead <= 0) {
                    if (totalSize == 0L && input.read() != -1) throw IOException("حجم الملف يتجاوز الحد المسموح")
                    break
                }
                val read = input.read(buffer, 0, toRead)
                if (read == -1) break
                output.write(buffer, 0, read)
                digest.update(buffer, 0, read)
                transferLimit.record(read)

                val now = SystemClock.elapsedRealtime()
                val complete = transferLimit.isDeclaredSizeComplete()
                if (shouldReportProgress(transferLimit.received - lastReportBytes, now - lastReportAt, complete)) {
                    lastReportBytes = transferLimit.received
                    lastReportAt = now
                    sendEvent("FT_PROGRESS", Arguments.createMap().apply {
                        putString("id", transferId)
                        putString("direction", "in")
                        putDouble("received", transferLimit.received.toDouble())
                        putDouble("total", totalSize.toDouble())
                        putDouble("progress", if (totalSize > 0) transferLimit.received.toDouble() / totalSize else 0.0)
                    })
                }
                if (complete) break
            }

            transferLimit.verifyEof()
            output.flush()
            output.close()
            output = null

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && outUri != null) {
                val publish = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                reactApplicationContext.contentResolver.update(outUri, publish, null, null)
            }

            val receiverSha256 = hex(digest.digest())
            writeCompletionAck(socket, transferId, transferLimit.received, receiverSha256)
            completed = true
            val elapsedMs = (SystemClock.elapsedRealtime() - startedAt).coerceAtLeast(1L)

            sendEvent("FT_INCOMING_DONE", Arguments.createMap().apply {
                putString("id", transferId)
                putString("fileName", storedFileName)
                putString("mimeType", mimeType)
                putString("kind", kind)
                putDouble("size", transferLimit.received.toDouble())
                putString("sha256", receiverSha256)
                putString("path", cacheFile?.absolutePath ?: outUri?.toString())
                putDouble("elapsedMs", elapsedMs.toDouble())
                putDouble("averageMbps", averageMbps(transferLimit.received, elapsedMs))
            })
            socket.close()
        } catch (e: Exception) {
            try { output?.close() } catch (_: Exception) {}
            if (!completed) {
                deletePartialCacheFile(cacheFile)
                try { outUri?.let { reactApplicationContext.contentResolver.delete(it, null, null) } } catch (_: Exception) {}
            }
            sendEvent("FT_ERROR", Arguments.createMap().apply {
                putString("id", transferId)
                putString("direction", "in")
                putString("message", e.message ?: "خطأ بالاستقبال")
            })
            try { socket.close() } catch (_: Exception) {}
        }
    }

    @ReactMethod
    fun stopServer(promise: Promise) {
        serverRunning = false
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
        promise.resolve(true)
    }

    /** Backward-compatible: cancel every currently active outgoing transfer. */
    @ReactMethod
    fun cancelTransfer(promise: Promise) {
        outgoingCancelFlags.values.forEach { it.set(true) }
        promise.resolve(true)
    }

    /** Preferred cancellation API: only the selected transfer is cancelled. */
    @ReactMethod
    fun cancelTransferById(transferId: String, promise: Promise) {
        val flag = outgoingCancelFlags[transferId]
        if (flag != null) {
            flag.set(true)
            promise.resolve(true)
        } else {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun sendFile(peerIp: String, uriString: String, transferId: String, kind: String, promise: Promise) {
        if (transferId.isBlank()) {
            promise.reject("ERROR", "معرّف نقل الملف مفقود")
            return
        }

        val cancelFlag = AtomicBoolean(false)
        if (outgoingCancelFlags.putIfAbsent(transferId, cancelFlag) != null) {
            promise.reject("ERROR", "عملية نقل بنفس المعرّف ما زالت نشطة")
            return
        }

        thread(start = true, name = "G1-FileOutgoing-$transferId") {
            var socket: Socket? = null
            var input: BufferedInputStream? = null
            val startedAt = SystemClock.elapsedRealtime()
            try {
                val resolver = reactApplicationContext.contentResolver
                val normalizedPath = cleanPath(uriString)
                val isContentUri = uriString.startsWith("content://")

                var fileName = "file"
                var size = 0L
                var mimeType = "application/octet-stream"

                if (!isContentUri) {
                    val f = File(normalizedPath)
                    if (!f.exists() || !f.isFile) throw IOException("ملف الإرسال غير موجود")
                    fileName = f.name
                    size = f.length().coerceAtLeast(0L)
                    mimeType = mimeForPlainFile(fileName, kind)
                } else {
                    val uri = Uri.parse(uriString)
                    resolver.query(uri, null, null, null, null)?.use { c ->
                        if (c.moveToFirst()) {
                            val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
                            if (nameIdx >= 0) fileName = c.getString(nameIdx) ?: fileName
                            if (sizeIdx >= 0 && !c.isNull(sizeIdx)) size = c.getLong(sizeIdx).coerceAtLeast(0L)
                        }
                    }
                    mimeType = resolver.getType(uri) ?: mimeForPlainFile(fileName, kind)
                }

                IncomingTransferLimit(size)

                socket = Socket().apply {
                    tuneSocket(this)
                    connect(InetSocketAddress(peerIp, PORT), 15000)
                    soTimeout = 120000
                }
                val out = DataOutputStream(BufferedOutputStream(socket.getOutputStream(), BUFFER_SIZE))

                val header = JSONObject().apply {
                    put("id", transferId)
                    put("fileName", fileName)
                    put("mimeType", mimeType)
                    put("kind", kind)
                    put("size", size)
                    put("ack", "sha256-v1")
                }.toString().toByteArray(Charsets.UTF_8)
                out.writeInt(header.size)
                out.write(header)

                input = if (!isContentUri) {
                    BufferedInputStream(File(normalizedPath).inputStream(), BUFFER_SIZE)
                } else {
                    BufferedInputStream(
                        resolver.openInputStream(Uri.parse(uriString)) ?: throw IOException("تعذّر فتح ملف الإرسال"),
                        BUFFER_SIZE
                    )
                }

                val digest = MessageDigest.getInstance("SHA-256")
                val buffer = ByteArray(BUFFER_SIZE)
                var sent = 0L
                var lastReportBytes = 0L
                var lastReportAt = SystemClock.elapsedRealtime()

                while (true) {
                    if (cancelFlag.get()) throw IOException("تم إلغاء الإرسال")
                    val read = input.read(buffer)
                    if (read == -1) break
                    if (sent + read > MAX_FILE_SIZE_BYTES) throw IOException("حجم الملف يتجاوز الحد المسموح")
                    out.write(buffer, 0, read)
                    digest.update(buffer, 0, read)
                    sent += read

                    val now = SystemClock.elapsedRealtime()
                    val complete = size > 0 && sent >= size
                    if (shouldReportProgress(sent - lastReportBytes, now - lastReportAt, complete)) {
                        lastReportBytes = sent
                        lastReportAt = now
                        sendEvent("FT_PROGRESS", Arguments.createMap().apply {
                            putString("id", transferId)
                            putString("direction", "out")
                            putDouble("sent", sent.toDouble())
                            putDouble("total", size.toDouble())
                            putDouble("progress", if (size > 0) sent.toDouble() / size else 0.0)
                        })
                    }
                }

                if (size > 0L && sent != size) throw IOException("حجم الملف المرسل لا يطابق الحجم المعلن")

                // Flush once at the end of the hot data path. Frequent flushes
                // used to defeat BufferedOutputStream and materially reduce LAN
                // throughput on large files.
                out.flush()
                input.close()
                input = null
                val senderSha256 = hex(digest.digest())
                socket.shutdownOutput()
                readAndVerifyCompletionAck(socket, transferId, sent, senderSha256)
                socket.close()
                socket = null
                val elapsedMs = (SystemClock.elapsedRealtime() - startedAt).coerceAtLeast(1L)

                sendEvent("FT_SENT_DONE", Arguments.createMap().apply {
                    putString("id", transferId)
                    putString("fileName", fileName)
                    putString("mimeType", mimeType)
                    putString("kind", kind)
                    putDouble("size", sent.toDouble())
                    putString("sha256", senderSha256)
                    putDouble("elapsedMs", elapsedMs.toDouble())
                    putDouble("averageMbps", averageMbps(sent, elapsedMs))
                })

                promise.resolve(Arguments.createMap().apply {
                    putString("id", transferId)
                    putString("fileName", fileName)
                    putString("mimeType", mimeType)
                    putDouble("size", sent.toDouble())
                    putString("sha256", senderSha256)
                    putDouble("elapsedMs", elapsedMs.toDouble())
                    putDouble("averageMbps", averageMbps(sent, elapsedMs))
                })
            } catch (e: Exception) {
                try { input?.close() } catch (_: Exception) {}
                try { socket?.close() } catch (_: Exception) {}
                sendEvent("FT_ERROR", Arguments.createMap().apply {
                    putString("id", transferId)
                    putString("direction", "out")
                    putString("message", e.message ?: "فشل الإرسال")
                })
                promise.reject("ERROR", e.message)
            } finally {
                outgoingCancelFlags.remove(transferId, cancelFlag)
            }
        }
    }
}
