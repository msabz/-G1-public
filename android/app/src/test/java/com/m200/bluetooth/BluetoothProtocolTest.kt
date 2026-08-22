package com.m200.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.util.UUID

class BluetoothProtocolTest {
    @Test
    fun helloRoundTripsWithVersionRoleAndIds() {
        val nodeId = UUID.randomUUID().toString()
        val connectionId = UUID.randomUUID().toString()
        val bytes = ByteArrayOutputStream()

        BluetoothProtocol.writeHello(
            DataOutputStream(bytes),
            BluetoothProtocol.ROLE_DIALER,
            nodeId,
            connectionId,
        )
        val hello = BluetoothProtocol.readHello(DataInputStream(ByteArrayInputStream(bytes.toByteArray())))

        assertEquals(BluetoothProtocol.VERSION, hello.version)
        assertEquals(BluetoothProtocol.ROLE_DIALER, hello.role)
        assertEquals(nodeId, hello.nodeId)
        assertEquals(connectionId, hello.connectionId)
    }

    @Test
    fun unicodeMessageRoundTripsAsOneFrame() {
        val bytes = ByteArrayOutputStream()
        BluetoothProtocol.writeMessage(DataOutputStream(bytes), "مرحبا\nG1 👋")

        val decoded = BluetoothProtocol.readMessage(DataInputStream(ByteArrayInputStream(bytes.toByteArray())))

        assertEquals("مرحبا\nG1 👋", decoded)
    }

    @Test
    fun oversizedOutboundMessageIsRejected() {
        val oversized = "x".repeat(BluetoothProtocol.MAX_MESSAGE_BYTES + 1)

        assertThrows(IOException::class.java) {
            BluetoothProtocol.writeMessage(DataOutputStream(ByteArrayOutputStream()), oversized)
        }
    }

    @Test
    fun oversizedInboundLengthIsRejectedBeforeAllocation() {
        val bytes = ByteArrayOutputStream().also {
            DataOutputStream(it).writeInt(BluetoothProtocol.MAX_MESSAGE_BYTES + 1)
        }

        assertThrows(IOException::class.java) {
            BluetoothProtocol.readMessage(DataInputStream(ByteArrayInputStream(bytes.toByteArray())))
        }
    }
}
