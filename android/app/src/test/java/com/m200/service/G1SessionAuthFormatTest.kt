package com.m200.service

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class G1SessionAuthFormatTest {

    private fun keyPair() = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec("secp256r1"))
        generateKeyPair()
    }

    @Test
    fun `P256 signature proves the exact domain separated G1 session transcript`() {
        val signerRoot = keyPair()
        val signerRecovery = keyPair()
        val challengerRoot = keyPair()
        val challengerRecovery = keyPair()
        val signerUserId = G1IdentityFormat.deriveUserId(
            signerRoot.public.encoded,
            signerRecovery.public.encoded,
        )
        val challengerUserId = G1IdentityFormat.deriveUserId(
            challengerRoot.public.encoded,
            challengerRecovery.public.encoded,
        )
        val challenge = ByteArray(32) { index -> (index + 1).toByte() }
        val transcript = G1SessionAuthFormat.canonicalTranscript(
            purpose = G1SessionAuthFormat.PURPOSE_PROOF,
            requestId = "request-123",
            challenge = challenge,
            signerUserId = signerUserId,
            signerDeviceId = "device-signer",
            challengerUserId = challengerUserId,
            challengerDeviceId = "device-challenger",
        )

        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(signerRoot.private)
        signer.update(transcript)
        val signature = signer.sign()

        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(signerRoot.public)
        verifier.update(transcript)
        assertTrue(verifier.verify(signature))

        val changedDeviceTranscript = G1SessionAuthFormat.canonicalTranscript(
            purpose = G1SessionAuthFormat.PURPOSE_PROOF,
            requestId = "request-123",
            challenge = challenge,
            signerUserId = signerUserId,
            signerDeviceId = "different-device",
            challengerUserId = challengerUserId,
            challengerDeviceId = "device-challenger",
        )
        val changedVerifier = Signature.getInstance("SHA256withECDSA")
        changedVerifier.initVerify(signerRoot.public)
        changedVerifier.update(changedDeviceTranscript)
        assertFalse(changedVerifier.verify(signature))
    }

    @Test
    fun `genesis commits both root and recovery keys into UserId`() {
        val root = keyPair()
        val recoveryA = keyPair()
        val recoveryB = keyPair()
        val userA = G1IdentityFormat.deriveUserId(root.public.encoded, recoveryA.public.encoded)
        val userB = G1IdentityFormat.deriveUserId(root.public.encoded, recoveryB.public.encoded)

        assertNotEquals(userA, userB)
        assertTrue(G1IdentityFormat.matches(G1IdentityFormat.deriveG1Number(userA), userA))
        assertTrue(G1IdentityFormat.matches(G1IdentityFormat.deriveG1Number(userB), userB))
    }
}
