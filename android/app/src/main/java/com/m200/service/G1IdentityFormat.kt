package com.m200.service

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale

object G1IdentityFormat {
    const val GENESIS_VERSION = 1
    const val ROOT_ALGORITHM = "P256-SHA256-ECDSA"
    const val RECOVERY_ALGORITHM = "P256-SHA256-ECDSA"

    private const val PREFIX = "G1"
    private const val PAYLOAD_CHARS = 20
    private const val CHECK_CHARS = 3
    private const val COMPACT_CHARS = PAYLOAD_CHARS + CHECK_CHARS
    private const val USER_ID_HEX_CHARS = 64
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val GENESIS_DOMAIN = "G1-USER-GENESIS-V1".toByteArray(Charsets.UTF_8)

    fun normalizeUserId(value: String?): String? {
        val text = value?.trim()?.lowercase(Locale.US) ?: return null
        if (text.length != USER_ID_HEX_CHARS || text.any { it !in '0'..'9' && it !in 'a'..'f' }) return null
        return text
    }

    fun bytesToHex(bytes: ByteArray): String = buildString(bytes.size * 2) {
        for (b in bytes) append("%02x".format(Locale.US, b.toInt() and 0xff))
    }

    private fun hexToBytes(hex: String): ByteArray {
        val out = ByteArray(hex.length / 2)
        for (i in out.indices) {
            out[i] = hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
        return out
    }

    fun canonicalGenesis(rootPublic: ByteArray, recoveryPublic: ByteArray): ByteArray {
        require(rootPublic.isNotEmpty() && rootPublic.size <= 4096) { "Invalid G1 root public key" }
        require(recoveryPublic.isNotEmpty() && recoveryPublic.size <= 4096) { "Invalid G1 recovery public key" }
        val out = ByteArrayOutputStream()
        DataOutputStream(out).use { data ->
            data.writeInt(GENESIS_DOMAIN.size)
            data.write(GENESIS_DOMAIN)
            data.writeInt(GENESIS_VERSION)
            val rootAlg = ROOT_ALGORITHM.toByteArray(Charsets.US_ASCII)
            data.writeInt(rootAlg.size)
            data.write(rootAlg)
            data.writeInt(rootPublic.size)
            data.write(rootPublic)
            val recoveryAlg = RECOVERY_ALGORITHM.toByteArray(Charsets.US_ASCII)
            data.writeInt(recoveryAlg.size)
            data.write(recoveryAlg)
            data.writeInt(recoveryPublic.size)
            data.write(recoveryPublic)
        }
        return out.toByteArray()
    }

    fun deriveUserId(rootPublic: ByteArray, recoveryPublic: ByteArray): String =
        bytesToHex(MessageDigest.getInstance("SHA-256").digest(canonicalGenesis(rootPublic, recoveryPublic)))

    fun keyFingerprint(publicKey: ByteArray): String =
        bytesToHex(MessageDigest.getInstance("SHA-256").digest(publicKey))

    private fun encodeBits(bytes: ByteArray, bitLength: Int): String {
        val chars = (bitLength + 4) / 5
        return buildString(chars) {
            for (i in 0 until chars) {
                var value = 0
                for (j in 0 until 5) {
                    val bitIndex = i * 5 + j
                    value = value shl 1
                    if (bitIndex < bitLength) {
                        val byteIndex = bitIndex / 8
                        val shift = 7 - (bitIndex % 8)
                        value = value or ((bytes[byteIndex].toInt() ushr shift) and 1)
                    }
                }
                append(ALPHABET[value])
            }
        }
    }

    private fun crc16CcittAscii(text: String): Int {
        var crc = 0xffff
        for (b in text.toByteArray(StandardCharsets.US_ASCII)) {
            crc = crc xor ((b.toInt() and 0xff) shl 8)
            repeat(8) {
                crc = if ((crc and 0x8000) != 0) {
                    ((crc shl 1) xor 0x1021) and 0xffff
                } else {
                    (crc shl 1) and 0xffff
                }
            }
        }
        return crc and 0xffff
    }

    private fun encodeFixedBase32(value: Int, chars: Int): String {
        var remaining = value
        val out = CharArray(chars) { '0' }
        for (i in chars - 1 downTo 0) {
            out[i] = ALPHABET[remaining and 31]
            remaining = remaining ushr 5
        }
        return String(out)
    }

    private fun checksumForPayload(payload: String): String =
        encodeFixedBase32(crc16CcittAscii(payload) and 0x7fff, CHECK_CHARS)

    private fun formatCompact(compact: String): String {
        val payload = compact.substring(0, PAYLOAD_CHARS)
        val check = compact.substring(PAYLOAD_CHARS)
        val groups = mutableListOf<String>()
        var i = 0
        while (i < payload.length) {
            groups += payload.substring(i, (i + 4).coerceAtMost(payload.length))
            i += 4
        }
        groups += check
        return "$PREFIX-${groups.joinToString("-")}"
    }

    fun deriveG1Number(userId: String): String {
        val normalized = normalizeUserId(userId)
            ?: throw IllegalArgumentException("Invalid 256-bit G1 userId")
        val payload = encodeBits(hexToBytes(normalized), PAYLOAD_CHARS * 5)
        return formatCompact(payload + checksumForPayload(payload))
    }

    private fun normalizeCrockfordChar(char: Char): Char = when (char) {
        'O' -> '0'
        'I', 'L' -> '1'
        else -> char
    }

    fun normalizeG1Number(value: String?): String? {
        var text = value?.trim()?.uppercase(Locale.US) ?: return null
        if (text.startsWith(PREFIX)) {
            text = text.substring(PREFIX.length)
            while (text.startsWith("-") || text.startsWith("_") || text.startsWith(":") || text.startsWith(" ")) {
                text = text.substring(1)
            }
        }
        text = text.filterNot { it == '-' || it.isWhitespace() }
            .map(::normalizeCrockfordChar)
            .joinToString("")
        if (text.length != COMPACT_CHARS || text.any { ALPHABET.indexOf(it) < 0 }) return null
        val payload = text.substring(0, PAYLOAD_CHARS)
        val suppliedCheck = text.substring(PAYLOAD_CHARS)
        if (suppliedCheck != checksumForPayload(payload)) return null
        return formatCompact(text)
    }

    fun matches(g1Number: String?, userId: String?): Boolean {
        val normalizedNumber = normalizeG1Number(g1Number) ?: return false
        val normalizedUserId = normalizeUserId(userId) ?: return false
        return normalizedNumber == deriveG1Number(normalizedUserId)
    }
}
