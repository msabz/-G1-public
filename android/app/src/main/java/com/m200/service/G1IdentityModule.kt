package com.m200.service

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class G1IdentityModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val PREFS = "g1_user_identity_v1"
        private const val ROOT_ALIAS = "g1_user_root_signing_v1"
        private const val RECOVERY_WRAP_ALIAS = "g1_recovery_wrap_v1"
        private const val RECOVERY_PUBLIC = "recovery_public_spki"
        private const val RECOVERY_PRIVATE_CIPHER = "recovery_private_cipher"
        private const val RECOVERY_PRIVATE_IV = "recovery_private_iv"
        private const val PROFILE_NAME = "profile_name"
    }

    override fun getName() = "G1IdentityModule"

    private fun prefs() = reactContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun androidKeyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun getOrCreateRootKeyPair(): KeyPair {
        val store = androidKeyStore()
        if (store.containsAlias(ROOT_ALIAS)) {
            val privateKey = store.getKey(ROOT_ALIAS, null) as PrivateKey
            val publicKey = store.getCertificate(ROOT_ALIAS).publicKey
            return KeyPair(publicKey, privateKey)
        }

        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(
            KeyGenParameterSpec.Builder(
                ROOT_ALIAS,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
            )
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build()
        )
        return generator.generateKeyPair()
    }

    private fun getOrCreateRecoveryWrappingKey(): SecretKey {
        val store = androidKeyStore()
        val existing = store.getKey(RECOVERY_WRAP_ALIAS, null)
        if (existing is SecretKey) return existing

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                RECOVERY_WRAP_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build()
        )
        return generator.generateKey()
    }

    private fun getOrCreateRecoveryPublicKey(): java.security.PublicKey {
        val prefs = prefs()
        val publicB64 = prefs.getString(RECOVERY_PUBLIC, null)
        val cipherB64 = prefs.getString(RECOVERY_PRIVATE_CIPHER, null)
        val ivB64 = prefs.getString(RECOVERY_PRIVATE_IV, null)

        val hasAnyRecoveryState = publicB64 != null || cipherB64 != null || ivB64 != null
        if (hasAnyRecoveryState && (publicB64 == null || cipherB64 == null || ivB64 == null)) {
            throw IllegalStateException("Incomplete G1 recovery identity state")
        }

        if (publicB64 != null && cipherB64 != null && ivB64 != null) {
            if (!androidKeyStore().containsAlias(RECOVERY_WRAP_ALIAS)) {
                throw IllegalStateException("G1 recovery wrapping key is unavailable")
            }
            val publicBytes = Base64.decode(publicB64, Base64.NO_WRAP)
            return KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(publicBytes))
        }

        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = generator.generateKeyPair()

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateRecoveryWrappingKey())
        val encryptedPrivate = cipher.doFinal(pair.private.encoded)
        prefs.edit()
            .putString(RECOVERY_PUBLIC, Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP))
            .putString(RECOVERY_PRIVATE_CIPHER, Base64.encodeToString(encryptedPrivate, Base64.NO_WRAP))
            .putString(RECOVERY_PRIVATE_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
        return pair.public
    }

    private data class IdentitySnapshot(
        val root: KeyPair,
        val recoveryPublic: java.security.PublicKey,
        val userId: String,
        val g1Number: String,
        val profileName: String,
    )

    private fun snapshot(): IdentitySnapshot {
        val root = getOrCreateRootKeyPair()
        val recoveryPublic = getOrCreateRecoveryPublicKey()
        val userId = G1IdentityFormat.deriveUserId(root.public.encoded, recoveryPublic.encoded)
        return IdentitySnapshot(
            root = root,
            recoveryPublic = recoveryPublic,
            userId = userId,
            g1Number = G1IdentityFormat.deriveG1Number(userId),
            profileName = prefs().getString(PROFILE_NAME, "") ?: "",
        )
    }

    private fun decodeChallenge(value: String): ByteArray {
        val bytes = Base64.decode(value, Base64.NO_WRAP)
        require(bytes.size in 16..64) { "Invalid G1 auth challenge" }
        return bytes
    }

    private fun parseP256PublicKey(value: String, label: String): ECPublicKey {
        val bytes = Base64.decode(value, Base64.NO_WRAP)
        require(bytes.isNotEmpty() && bytes.size <= 4096) { "Invalid $label" }
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(bytes))
        require(key is ECPublicKey) { "Invalid $label type" }
        require(key.params.curve.field.fieldSize == 256 && key.params.order.bitLength() == 256) {
            "$label must use P-256"
        }
        return key
    }

    private fun verificationMap(
        verified: Boolean,
        reason: String,
        userId: String,
        g1Number: String,
        rootKeyFingerprint: String,
    ) = Arguments.createMap().apply {
        putBoolean("verified", verified)
        putString("reason", reason)
        putString("userId", userId)
        putString("g1Number", g1Number)
        putString("rootKeyFingerprint", rootKeyFingerprint)
    }

    @ReactMethod
    fun getUserIdentity(promise: Promise) {
        try {
            val identity = snapshot()
            promise.resolve(Arguments.createMap().apply {
                putInt("genesisVersion", G1IdentityFormat.GENESIS_VERSION)
                putString("userId", identity.userId)
                putString("g1Number", identity.g1Number)
                putString("profileName", identity.profileName)
                putString("rootAlgorithm", G1IdentityFormat.ROOT_ALGORITHM)
                putString("rootPublicKeySpki", Base64.encodeToString(identity.root.public.encoded, Base64.NO_WRAP))
                putString("recoveryAlgorithm", G1IdentityFormat.RECOVERY_ALGORITHM)
                putString("recoveryPublicKeySpki", Base64.encodeToString(identity.recoveryPublic.encoded, Base64.NO_WRAP))
                putString("identityStatus", "GENESIS_READY")
            })
        } catch (e: Exception) {
            promise.reject("G1_IDENTITY_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun setProfileName(name: String, promise: Promise) {
        try {
            val clean = name.trim().take(80)
            prefs().edit().putString(PROFILE_NAME, clean).apply()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("G1_PROFILE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun createAuthNonce(promise: Promise) {
        try {
            val nonce = ByteArray(32)
            SecureRandom().nextBytes(nonce)
            promise.resolve(Base64.encodeToString(nonce, Base64.NO_WRAP))
        } catch (e: Exception) {
            promise.reject("G1_NONCE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun signSessionAuth(
        purpose: String,
        requestId: String,
        challengeBase64: String,
        signerUserId: String,
        signerDeviceId: String,
        challengerUserId: String,
        challengerDeviceId: String,
        promise: Promise,
    ) {
        try {
            val identity = snapshot()
            val normalizedSignerUserId = G1IdentityFormat.normalizeUserId(signerUserId)
                ?: throw IllegalArgumentException("Invalid signer userId")
            require(normalizedSignerUserId == identity.userId) {
                "G1 root key cannot sign for a different user identity"
            }
            val transcript = G1SessionAuthFormat.canonicalTranscript(
                purpose = purpose,
                requestId = requestId,
                challenge = decodeChallenge(challengeBase64),
                signerUserId = identity.userId,
                signerDeviceId = signerDeviceId,
                challengerUserId = challengerUserId,
                challengerDeviceId = challengerDeviceId,
            )
            val signature = Signature.getInstance("SHA256withECDSA")
            signature.initSign(identity.root.private)
            signature.update(transcript)
            promise.resolve(Base64.encodeToString(signature.sign(), Base64.NO_WRAP))
        } catch (e: Exception) {
            promise.reject("G1_SESSION_SIGN_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun verifySessionAuth(
        rootPublicKeySpki: String,
        recoveryPublicKeySpki: String,
        claimedUserId: String,
        claimedG1Number: String,
        purpose: String,
        requestId: String,
        challengeBase64: String,
        signerDeviceId: String,
        challengerUserId: String,
        challengerDeviceId: String,
        signatureBase64: String,
        promise: Promise,
    ) {
        try {
            val rootPublic = parseP256PublicKey(rootPublicKeySpki, "G1 root public key")
            val recoveryPublic = parseP256PublicKey(recoveryPublicKeySpki, "G1 recovery public key")
            val derivedUserId = G1IdentityFormat.deriveUserId(rootPublic.encoded, recoveryPublic.encoded)
            val derivedG1Number = G1IdentityFormat.deriveG1Number(derivedUserId)
            val fingerprint = G1IdentityFormat.keyFingerprint(rootPublic.encoded)
            val normalizedClaimedUserId = G1IdentityFormat.normalizeUserId(claimedUserId)
            val normalizedClaimedNumber = G1IdentityFormat.normalizeG1Number(claimedG1Number)

            if (normalizedClaimedUserId != derivedUserId) {
                promise.resolve(verificationMap(false, "GENESIS_USER_ID_MISMATCH", derivedUserId, derivedG1Number, fingerprint))
                return
            }
            if (normalizedClaimedNumber != derivedG1Number) {
                promise.resolve(verificationMap(false, "G1_NUMBER_MISMATCH", derivedUserId, derivedG1Number, fingerprint))
                return
            }

            val transcript = G1SessionAuthFormat.canonicalTranscript(
                purpose = purpose,
                requestId = requestId,
                challenge = decodeChallenge(challengeBase64),
                signerUserId = derivedUserId,
                signerDeviceId = signerDeviceId,
                challengerUserId = challengerUserId,
                challengerDeviceId = challengerDeviceId,
            )
            val signatureBytes = Base64.decode(signatureBase64, Base64.NO_WRAP)
            require(signatureBytes.size in 8..512) { "Invalid G1 auth signature" }
            val verifier = Signature.getInstance("SHA256withECDSA")
            verifier.initVerify(rootPublic)
            verifier.update(transcript)
            val verified = verifier.verify(signatureBytes)
            promise.resolve(
                verificationMap(
                    verified,
                    if (verified) "SESSION_PROVEN" else "SIGNATURE_INVALID",
                    derivedUserId,
                    derivedG1Number,
                    fingerprint,
                )
            )
        } catch (e: Exception) {
            promise.reject("G1_SESSION_VERIFY_ERROR", e.message, e)
        }
    }

    /**
     * Legacy foundation primitive retained for compatibility with existing
     * callers. New session identity proof uses signSessionAuth(), which binds
     * both identities, device IDs, request ID, purpose and a fresh nonce.
     */
    @ReactMethod
    fun signRootChallenge(payloadBase64: String, promise: Promise) {
        try {
            val payload = Base64.decode(payloadBase64, Base64.NO_WRAP)
            require(payload.isNotEmpty() && payload.size <= 4096) { "Invalid challenge size" }
            val signature = Signature.getInstance("SHA256withECDSA")
            signature.initSign(getOrCreateRootKeyPair().private)
            signature.update(payload)
            promise.resolve(Base64.encodeToString(signature.sign(), Base64.NO_WRAP))
        } catch (e: Exception) {
            promise.reject("G1_SIGN_ERROR", e.message, e)
        }
    }
}
