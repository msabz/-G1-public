package com.m200.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class G1IdentityFormatTest {
    private val userId = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    private val number = "G1-000G-40R4-0M30-E209-185G-8VY"

    @Test
    fun derivesStableKnownVectors() {
        assertEquals("G1-0000-0000-0000-0000-0000-WBT", G1IdentityFormat.deriveG1Number("0".repeat(64)))
        assertEquals("G1-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-CZE", G1IdentityFormat.deriveG1Number("f".repeat(64)))
        assertEquals(number, G1IdentityFormat.deriveG1Number(userId))
    }

    @Test
    fun normalizesHumanInputAndRejectsBadChecksum() {
        assertEquals(number, G1IdentityFormat.normalizeG1Number("g1 000g 40r4 0m30 e209 185g 8vy"))
        assertEquals(number, G1IdentityFormat.normalizeG1Number("G1-OOOG-4OR4-OM3O-E2O9-185G-8VY"))
        assertNull(G1IdentityFormat.normalizeG1Number("G1-000G-40R4-0M30-E209-185G-8VZ"))
    }

    @Test
    fun bindsVisibleNumberToFullUserIdentity() {
        assertTrue(G1IdentityFormat.matches(number, userId))
        assertFalse(G1IdentityFormat.matches(number, "100102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"))
    }
}
