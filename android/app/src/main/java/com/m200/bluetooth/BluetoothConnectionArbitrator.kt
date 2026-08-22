package com.m200.bluetooth

/** Pure duplicate-socket policy, kept separate so races can be unit tested. */
internal object BluetoothConnectionArbitrator {
    const val DUPLICATE_SETTLE_WINDOW_MS = 4_000L

    data class ConnectionRank(
        val peerNodeId: String,
        val connectionId: String,
        val initiatorNodeId: String,
        val activatedAtMs: Long,
    )

    enum class Decision {
        ACCEPT,
        REPLACE_ACTIVE,
        REJECT_DUPLICATE,
        REJECT_BUSY,
    }

    fun decide(
        active: ConnectionRank?,
        candidate: ConnectionRank,
        nowMs: Long,
        settleWindowMs: Long = DUPLICATE_SETTLE_WINDOW_MS,
    ): Decision {
        if (active == null) return Decision.ACCEPT
        if (active.peerNodeId != candidate.peerNodeId) return Decision.REJECT_BUSY
        if (active.connectionId == candidate.connectionId) return Decision.REJECT_DUPLICATE

        // A healthy established session is never displaced by a late dial.
        if (nowMs - active.activatedAtMs > settleWindowMs) return Decision.REJECT_DUPLICATE

        // Both phones see the same initiator IDs. Selecting the lexicographically
        // smaller one guarantees that both ends keep the same physical socket.
        return if (candidate.initiatorNodeId < active.initiatorNodeId) {
            Decision.REPLACE_ACTIVE
        } else {
            Decision.REJECT_DUPLICATE
        }
    }
}
