package com.m200.filesharing

import java.io.File
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FileTransferLimitsTest {
    @Test
    fun zeroSizeIsUnknownUntilEof() {
        val limit = IncomingTransferLimit(0)
        limit.record(3)

        limit.verifyEof()

        assertEquals(3L, limit.received)
        assertFalse(limit.isDeclaredSizeComplete())
    }

    @Test
    fun unknownSizeAtLimitIsAcceptedButAnyAdditionalByteIsRejected() {
        val limit = IncomingTransferLimit(0)
        val chunkSize = 64 * 1024
        repeat((MAX_FILE_SIZE_BYTES / chunkSize).toInt()) {
            limit.record(chunkSize)
        }

        assertEquals(MAX_FILE_SIZE_BYTES, limit.received)
        assertEquals(0, limit.nextReadLimit(chunkSize))
        limit.verifyEof()

        try {
            limit.record(1)
            fail("Expected an additional byte to exceed the transfer limit")
        } catch (_: IOException) {
            // Expected: an unknown-size transfer must not exceed the hard cap.
        }
    }

    @Test(expected = IOException::class)
    fun rejectsNegativeSize() {
        IncomingTransferLimit(-1)
    }

    @Test(expected = IOException::class)
    fun rejectsSizeOverTheLimit() {
        IncomingTransferLimit(MAX_FILE_SIZE_BYTES + 1)
    }

    @Test(expected = IOException::class)
    fun rejectsIncompleteKnownSizeAtEof() {
        val limit = IncomingTransferLimit(4)
        limit.record(3)
        limit.verifyEof()
    }

    @Test
    fun deletesPartialCacheFile() {
        val file = File.createTempFile("musabchat-transfer", ".tmp")
        assertTrue(file.exists())

        deletePartialCacheFile(file)

        assertFalse(file.exists())
    }
}
