package com.m200.directconnection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectedPeerAddressTest {
    @Test
    fun connectionEventOnlyRunsForTheCurrentGeneration() {
        assertTrue(isCurrentConnectionEpoch(7L, 7L))
        assertFalse(isCurrentConnectionEpoch(6L, 7L))
    }

    @Test
    fun clientUsesTheGroupOwnerAddress() {
        assertEquals(
            "02:00:00:00:00:0A",
            connectedPeerAddress(false, "02:00:00:00:00:0A", emptyList())
        )
    }

    @Test
    fun ownerUsesItsOnlyClientAddress() {
        assertEquals(
            "02:00:00:00:00:0B",
            connectedPeerAddress(true, "02:00:00:00:00:0A", listOf("02:00:00:00:00:0B"))
        )
    }

    @Test
    fun ownerDoesNotGuessWhenSeveralClientsExist() {
        assertNull(
            connectedPeerAddress(
                true,
                "02:00:00:00:00:0A",
                listOf("02:00:00:00:00:0B", "02:00:00:00:00:0C")
            )
        )
    }

    @Test
    fun emptyAddressIsNotUsed() {
        assertNull(connectedPeerAddress(false, "  ", emptyList()))
        assertNull(connectedPeerAddress(true, null, listOf(" ")))
    }
}
