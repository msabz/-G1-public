package com.m200.service

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream

object G1SessionAuthFormat {
    const val VERSION = 1
    const val PURPOSE_PROOF = "PROOF"
    const val PURPOSE_CONFIRM = "CONFIRM"
    private const val MAX_DEVICE_ID_CHARS = 200
    private const val MAX_REQUEST_ID_CHARS = 256
    private val DOMAIN = "G1-SESSION-AUTH-V1".toByteArray(Charsets.UTF_8)

    private fun requiredText(value: String?, label: String, maxChars: Int): String {
        val clean = value?.trim().orEmpty()
        require(clean.isNotEmpty() && clean.length <= maxChars) { "Invalid $label" }
        return clean
    }

    private fun normalizedPurpose(value: String?): String {
        val clean = value?.trim().orEmpty()
        require(clean == PURPOSE_PROOF || clean == PURPOSE_CONFIRM) { "Invalid G1 auth purpose" }
        return clean
    }

    fun canonicalTranscript(
        purpose: String,
        requestId: String,
        challenge: ByteArray,
        signerUserId: String,
        signerDeviceId: String,
        challengerUserId: String,
        challengerDeviceId: String,
    ): ByteArray {
        val normalizedPurpose = normalizedPurpose(purpose)
        val normalizedRequestId = requiredText(requestId, "G1 auth requestId", MAX_REQUEST_ID_CHARS)
        require(challenge.size in 16..64) { "Invalid G1 auth challenge" }
        val normalizedSignerUserId = G1IdentityFormat.normalizeUserId(signerUserId)
            ?: throw IllegalArgumentException("Invalid signer userId")
        val normalizedChallengerUserId = G1IdentityFormat.normalizeUserId(challengerUserId)
            ?: throw IllegalArgumentException("Invalid challenger userId")
        val normalizedSignerDeviceId = requiredText(signerDeviceId, "signer deviceId", MAX_DEVICE_ID_CHARS)
        val normalizedChallengerDeviceId = requiredText(challengerDeviceId, "challenger deviceId", MAX_DEVICE_ID_CHARS)

        val out = ByteArrayOutputStream()
        DataOutputStream(out).use { data ->
            data.writeInt(DOMAIN.size)
            data.write(DOMAIN)
            data.writeInt(VERSION)
            writeUtf8(data, normalizedPurpose)
            writeUtf8(data, normalizedRequestId)
            data.writeInt(challenge.size)
            data.write(challenge)
            writeUtf8(data, normalizedSignerUserId)
            writeUtf8(data, normalizedSignerDeviceId)
            writeUtf8(data, normalizedChallengerUserId)
            writeUtf8(data, normalizedChallengerDeviceId)
        }
        return out.toByteArray()
    }

    private fun writeUtf8(data: DataOutputStream, value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        data.writeInt(bytes.size)
        data.write(bytes)
    }
}
