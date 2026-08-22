package com.m200.bluetooth

import org.junit.Assert.assertEquals
import org.junit.Test

class BluetoothConnectionArbitratorTest {
    private fun rank(
        peer: String = "peer",
        connection: String,
        initiator: String,
        activatedAt: Long = 1_000L,
    ) = BluetoothConnectionArbitrator.ConnectionRank(peer, connection, initiator, activatedAt)

    @Test
    fun acceptsWhenNoSocketIsActive() {
        val decision = BluetoothConnectionArbitrator.decide(
            active = null,
            candidate = rank(connection = "candidate", initiator = "node-a"),
            nowMs = 1_100L,
        )

        assertEquals(BluetoothConnectionArbitrator.Decision.ACCEPT, decision)
    }

    @Test
    fun simultaneousSocketsSelectSameLowestInitiatorOnBothPhones() {
        val active = rank(connection = "from-b", initiator = "node-b")
        val candidate = rank(connection = "from-a", initiator = "node-a")

        val decision = BluetoothConnectionArbitrator.decide(active, candidate, nowMs = 1_200L)

        assertEquals(BluetoothConnectionArbitrator.Decision.REPLACE_ACTIVE, decision)
    }

    @Test
    fun lateDuplicateCannotDisplaceHealthySession() {
        val active = rank(connection = "healthy", initiator = "node-z")
        val candidate = rank(connection = "late", initiator = "node-a", activatedAt = 9_000L)

        val decision = BluetoothConnectionArbitrator.decide(active, candidate, nowMs = 9_000L)

        assertEquals(BluetoothConnectionArbitrator.Decision.REJECT_DUPLICATE, decision)
    }

    @Test
    fun differentPeerIsRejectedAsBusy() {
        val active = rank(peer = "peer-one", connection = "one", initiator = "node-a")
        val candidate = rank(peer = "peer-two", connection = "two", initiator = "node-b")

        val decision = BluetoothConnectionArbitrator.decide(active, candidate, nowMs = 1_100L)

        assertEquals(BluetoothConnectionArbitrator.Decision.REJECT_BUSY, decision)
    }
}
