package com.m200.lan

object LanDiscoveryHelper {
    fun buildServiceName(deviceId: String): String {
        val cleanId = deviceId.trim()
        return if (cleanId.isNotEmpty()) "G1-$cleanId" else "G1-Unknown"
    }

    fun extractDeviceId(serviceName: String, attrDeviceId: String?): String {
        if (!attrDeviceId.isNullOrBlank()) {
            return attrDeviceId.trim()
        }
        if (serviceName.startsWith("G1-")) {
            return serviceName.removePrefix("G1-").trim()
        }
        return serviceName.trim()
    }

    fun isSelfDiscovery(myDeviceId: String, discoveredDeviceId: String): Boolean {
        if (myDeviceId.isBlank() || discoveredDeviceId.isBlank()) return false
        return myDeviceId.trim().equals(discoveredDeviceId.trim(), ignoreCase = true)
    }

    fun cleanHostAddress(rawHost: String): String {
        return if (rawHost.contains("%")) {
            rawHost.substringBefore("%")
        } else {
            rawHost.trim()
        }
    }

    /**
     * Wi-Fi Direct interface names are vendor-dependent but Android consistently
     * exposes the P2P role with "p2p" in the interface name (for example
     * p2p-wlan0-0). Keep this check independent from any hard-coded subnet.
     */
    fun isP2pInterfaceName(interfaceName: String?): Boolean {
        if (interfaceName.isNullOrBlank()) return false
        return interfaceName.contains("p2p", ignoreCase = true)
    }
}
