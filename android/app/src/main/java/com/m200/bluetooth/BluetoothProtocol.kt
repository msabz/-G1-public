package com.m200.bluetooth

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.UUID

/**
 * Small binary protocol carried inside Android's authenticated RFCOMM socket.
 *
 * The Bluetooth link already supplies authentication and encryption after the
 * devices have been paired. This layer adds strict framing, a versioned hello
 * and install-scoped node IDs so simultaneous incoming/outgoing sockets can be
 * resolved deterministically instead of leaving each phone on a different
 * half of two duplicate connections.
 */
internal object BluetoothProtocol {
    const val VERSION = 1
    const val ROLE_DIALER = 1
    const val ROLE_ACCEPTOR = 2
    const val MAX_MESSAGE_BYTES = 64 * 1024

    private const val MAGIC = 0x47314254 // "G1BT"

    data class Hello(
        val version: Int,
        val role: Int,
        val nodeId: String,
        val connectionId: String,
    )

    @Throws(IOException::class)
    fun writeHello(
        output: DataOutputStream,
        role: Int,
        nodeId: String,
        connectionId: String,
    ) {
        requireRole(role)
        val nodeUuid = parseUuid(nodeId, "node ID")
        val connectionUuid = parseUuid(connectionId, "connection ID")

        output.writeInt(MAGIC)
        output.writeByte(VERSION)
        output.writeByte(role)
        output.writeLong(nodeUuid.mostSignificantBits)
        output.writeLong(nodeUuid.leastSignificantBits)
        output.writeLong(connectionUuid.mostSignificantBits)
        output.writeLong(connectionUuid.leastSignificantBits)
        output.flush()
    }

    @Throws(IOException::class)
    fun readHello(input: DataInputStream): Hello {
        if (input.readInt() != MAGIC) throw IOException("Invalid G1 Bluetooth protocol header")
        val version = input.readUnsignedByte()
        if (version != VERSION) throw IOException("Unsupported G1 Bluetooth protocol version: $version")
        val role = input.readUnsignedByte()
        requireRole(role)
        val nodeId = UUID(input.readLong(), input.readLong()).toString()
        val connectionId = UUID(input.readLong(), input.readLong()).toString()
        return Hello(version, role, nodeId, connectionId)
    }

    @Throws(IOException::class)
    fun writeMessage(output: DataOutputStream, text: String) {
        val bytes = text.toByteArray(StandardCharsets.UTF_8)
        if (bytes.size > MAX_MESSAGE_BYTES) {
            throw IOException("Bluetooth message exceeds $MAX_MESSAGE_BYTES bytes")
        }
        output.writeInt(bytes.size)
        output.write(bytes)
        output.flush()
    }

    @Throws(IOException::class)
    fun readMessage(input: DataInputStream): String {
        val size = input.readInt()
        if (size < 0 || size > MAX_MESSAGE_BYTES) {
            throw IOException("Invalid Bluetooth message size: $size")
        }
        val bytes = ByteArray(size)
        input.readFully(bytes)
        return try {
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        } catch (e: Exception) {
            throw IOException("Bluetooth message is not valid UTF-8", e)
        }
    }

    @Throws(IOException::class)
    private fun requireRole(role: Int) {
        if (role != ROLE_DIALER && role != ROLE_ACCEPTOR) {
            throw IOException("Invalid G1 Bluetooth hello role: $role")
        }
    }

    @Throws(IOException::class)
    private fun parseUuid(value: String, label: String): UUID = try {
        UUID.fromString(value)
    } catch (e: IllegalArgumentException) {
        throw IOException("Invalid Bluetooth $label", e)
    }
}
