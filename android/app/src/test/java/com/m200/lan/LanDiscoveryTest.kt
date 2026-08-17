package com.m200.lan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LanDiscoveryTest {
    @Test
    fun formatsServiceNameCorrectly() {
        assertEquals("G1-abc-123", LanDiscoveryHelper.buildServiceName("abc-123"))
        assertEquals("G1-Unknown", LanDiscoveryHelper.buildServiceName("   "))
    }

    @Test
    fun extractsDeviceIdFromAttributesFirst() {
        assertEquals(
            "attr-dev-id",
            LanDiscoveryHelper.extractDeviceId("G1-other-name", "attr-dev-id")
        )
    }

    @Test
    fun extractsDeviceIdFromServiceNameFallback() {
        assertEquals(
            "fallback-id",
            LanDiscoveryHelper.extractDeviceId("G1-fallback-id", null)
        )
    }

    @Test
    fun detectsSelfDiscovery() {
        assertTrue(LanDiscoveryHelper.isSelfDiscovery("my-device-123", "my-device-123"))
        assertTrue(LanDiscoveryHelper.isSelfDiscovery("MY-DEVICE-123", "my-device-123"))
        assertFalse(LanDiscoveryHelper.isSelfDiscovery("my-device-123", "other-device-456"))
        assertFalse(LanDiscoveryHelper.isSelfDiscovery("", "other-device-456"))
    }

    @Test
    fun cleansScopedIpv6HostAddresses() {
        assertEquals("fe80::1", LanDiscoveryHelper.cleanHostAddress("fe80::1%wlan0"))
        assertEquals("192.168.1.100", LanDiscoveryHelper.cleanHostAddress("192.168.1.100"))
    }

    @Test
    fun identifiesWifiDirectInterfacesWithoutHardcodedSubnet() {
        assertTrue(LanDiscoveryHelper.isP2pInterfaceName("p2p-wlan0-0"))
        assertTrue(LanDiscoveryHelper.isP2pInterfaceName("P2P-p2p0"))
        assertFalse(LanDiscoveryHelper.isP2pInterfaceName("wlan0"))
        assertFalse(LanDiscoveryHelper.isP2pInterfaceName("rmnet_data0"))
        assertFalse(LanDiscoveryHelper.isP2pInterfaceName(null))
    }
}
