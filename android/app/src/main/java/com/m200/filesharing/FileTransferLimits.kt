package com.m200.filesharing

import java.io.File
import java.io.IOException

// Streaming transfer never buffers the full payload in memory. Keep a generous
// safety cap so modern games/app bundles are not rejected at 512 MiB while still
// bounding a malicious or corrupted endless stream.
internal const val MAX_FILE_SIZE_BYTES = 4L * 1024L * 1024L * 1024L

/**
 * Tracks an incoming transfer. A declared size of zero is the explicit
 * "unknown size" marker and is completed at EOF; negative values are invalid.
 */
internal class IncomingTransferLimit(private val declaredSize: Long) {
    var received: Long = 0
        private set

    init {
        if (declaredSize < 0L || declaredSize > MAX_FILE_SIZE_BYTES) {
            throw IOException("حجم الملف غير صالح أو يتجاوز الحد المسموح")
        }
    }

    fun nextReadLimit(bufferSize: Int): Int {
        val remainingCap = MAX_FILE_SIZE_BYTES - received
        if (remainingCap <= 0L) return 0
        val remainingDeclared = if (declaredSize == 0L) remainingCap else declaredSize - received
        return minOf(bufferSize.toLong(), remainingCap, remainingDeclared).toInt()
    }

    fun record(bytes: Int) {
        if (bytes < 0 || received + bytes > MAX_FILE_SIZE_BYTES ||
            (declaredSize > 0L && received + bytes > declaredSize)) {
            throw IOException("حجم الملف يتجاوز الحد المسموح")
        }
        received += bytes
    }

    fun isDeclaredSizeComplete() = declaredSize > 0L && received == declaredSize

    fun verifyEof() {
        if (declaredSize > 0L && received != declaredSize) {
            throw IOException("حجم الملف المستلم لا يطابق الحجم المعلن")
        }
    }
}

internal fun deletePartialCacheFile(file: File?) {
    try { file?.delete() } catch (_: Exception) {}
}
