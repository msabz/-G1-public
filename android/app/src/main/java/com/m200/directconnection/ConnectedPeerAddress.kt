package com.m200.directconnection

internal fun isCurrentConnectionEpoch(eventEpoch: Long, connectionGeneration: Long): Boolean =
    eventEpoch == connectionGeneration

/**
 * Derives the remote Wi-Fi Direct device address from group membership.
 *
 * A group owner can only identify a remote device when exactly one client is
 * present. A client can identify its remote peer as the group's owner. Empty
 * and ambiguous values deliberately produce null rather than a guess.
 */
internal fun connectedPeerAddress(
    isGroupOwner: Boolean,
    groupOwnerAddress: String?,
    clientAddresses: Collection<String?>
): String? {
    fun normalized(address: String?): String? = address?.trim()?.takeIf { it.isNotEmpty() }

    if (!isGroupOwner) {
        return normalized(groupOwnerAddress)
    }

    val clients = clientAddresses.mapNotNull(::normalized).distinct()
    return clients.singleOrNull()
}
