package com.m200.lan

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.net.InetAddress
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean

class LanDiscoveryModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val MODULE_NAME = "LanDiscoveryModule"
        const val SERVICE_TYPE = "_g1chat._tcp."
        const val TAG = "LanDiscoveryModule"

        const val EVENT_PEER_FOUND = "LAN_PEER_FOUND"
        const val EVENT_PEER_LOST = "LAN_PEER_LOST"
        const val EVENT_STATUS = "LAN_DISCOVERY_STATUS"
        const val EVENT_NETWORK_REFRESH = "LAN_NETWORK_REFRESH"

        private const val NETWORK_REFRESH_DELAY_MS = 900L
    }

    private val nsdManager: NsdManager? by lazy {
        reactContext.getSystemService(Context.NSD_SERVICE) as? NsdManager
    }

    private val wifiManager: WifiManager? by lazy {
        reactContext.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    }

    private val connectivityManager: ConnectivityManager? by lazy {
        reactContext.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    }

    private var multicastLock: WifiManager.MulticastLock? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    private var myDeviceId: String = ""
    private var myDeviceName: String = ""
    private val isAdvertising = AtomicBoolean(false)
    private val isDiscovering = AtomicBoolean(false)
    private val discoveryRequested = AtomicBoolean(false)

    private var registrationListener: NsdManager.RegistrationListener? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var discoveryGeneration = 0L

    private val resolveQueue = ConcurrentLinkedQueue<NsdServiceInfo>()
    private val isResolving = AtomicBoolean(false)
    private val discoveredServices = ConcurrentHashMap<String, String>() // serviceName -> deviceId

    private val p2pNetworks = ConcurrentHashMap.newKeySet<Network>()
    private var networkCallbackRegistered = false
    private var pendingRefreshReason = "network-transition"

    private val discoveryRefreshRunnable = Runnable {
        if (!discoveryRequested.get()) return@Runnable
        val reason = pendingRefreshReason
        Log.d(TAG, "Refreshing LAN NSD after network transition reason=$reason")
        emitNetworkRefresh(reason)
        restartDiscoveryInternal()
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            inspectNetworkForP2p(network)
        }

        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            val iface = linkProperties.interfaceName
            if (LanDiscoveryHelper.isP2pInterfaceName(iface)) {
                if (p2pNetworks.add(network)) {
                    Log.d(TAG, "Observed Wi-Fi Direct network on interface $iface")
                }
            }
        }

        override fun onLost(network: Network) {
            if (p2pNetworks.remove(network)) {
                Log.d(TAG, "Wi-Fi Direct network disappeared; scheduling clean LAN NSD refresh")
                scheduleDiscoveryRefresh("p2p-network-lost")
            }
        }
    }

    override fun getName(): String = MODULE_NAME

    private fun sendEvent(eventName: String, params: WritableMap?) {
        try {
            if (reactContext.hasActiveReactInstance()) {
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit(eventName, params)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to emit event $eventName: ${e.message}")
        }
    }

    private fun emitStatus(error: String? = null) {
        val params = Arguments.createMap().apply {
            putBoolean("isAdvertising", isAdvertising.get())
            putBoolean("isDiscovering", isDiscovering.get())
            putString("myDeviceId", myDeviceId)
            if (error != null) putString("error", error)
        }
        sendEvent(EVENT_STATUS, params)
    }

    private fun emitNetworkRefresh(reason: String) {
        val params = Arguments.createMap().apply {
            putString("reason", reason)
            putDouble("timestamp", System.currentTimeMillis().toDouble())
            putDouble("nativeDiscoveryGeneration", discoveryGeneration.toDouble())
        }
        Log.d(TAG, "Emitting LAN_NETWORK_REFRESH reason=$reason generation=$discoveryGeneration")
        sendEvent(EVENT_NETWORK_REFRESH, params)
    }

    private fun acquireMulticastLock() {
        try {
            if (multicastLock == null) {
                multicastLock = wifiManager?.createMulticastLock("G1LanDiscoveryLock")?.apply {
                    setReferenceCounted(true)
                }
            }
            if (multicastLock?.isHeld != true) {
                multicastLock?.acquire()
                Log.d(TAG, "MulticastLock acquired")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to acquire MulticastLock: ${e.message}")
        }
    }

    private fun releaseMulticastLock() {
        try {
            if (multicastLock?.isHeld == true) {
                multicastLock?.release()
                Log.d(TAG, "MulticastLock released")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to release MulticastLock: ${e.message}")
        }
    }

    @ReactMethod
    fun startAdvertising(
        deviceId: String,
        deviceName: String,
        port: Int,
        attributes: ReadableMap?,
        promise: Promise
    ) {
        if (nsdManager == null) {
            promise.reject("NSD_UNAVAILABLE", "NsdManager is not available on this device")
            return
        }

        if (isAdvertising.get()) {
            stopAdvertisingInternal()
        }

        myDeviceId = deviceId
        myDeviceName = deviceName

        val serviceInfo = NsdServiceInfo().apply {
            this.serviceName = "G1-$deviceId"
            this.serviceType = SERVICE_TYPE
            this.port = port

            setAttribute("deviceId", deviceId)
            setAttribute("deviceName", deviceName)
            setAttribute("protoVer", "1")
            setAttribute("app", "G1")

            attributes?.let {
                val iterator = it.keySetIterator()
                while (iterator.hasNextKey()) {
                    val key = iterator.nextKey()
                    val value = it.getString(key) ?: ""
                    setAttribute(key, value)
                }
            }
        }

        registrationListener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(registeredService: NsdServiceInfo) {
                Log.d(TAG, "Service registered: ${registeredService.serviceName} on port ${registeredService.port}")
                isAdvertising.set(true)
                emitStatus()
                try { promise.resolve(true) } catch (_: Exception) {}
            }

            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.e(TAG, "Registration failed with code: $errorCode")
                isAdvertising.set(false)
                emitStatus("Registration failed: $errorCode")
                try { promise.reject("REGISTRATION_FAILED", "ErrorCode: $errorCode") } catch (_: Exception) {}
            }

            override fun onServiceUnregistered(arg0: NsdServiceInfo) {
                Log.d(TAG, "Service unregistered")
                isAdvertising.set(false)
                emitStatus()
            }

            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "Unregistration failed: $errorCode")
                isAdvertising.set(false)
                emitStatus("Unregistration failed: $errorCode")
            }
        }

        try {
            nsdManager?.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, registrationListener)
        } catch (e: Exception) {
            isAdvertising.set(false)
            promise.reject("REGISTER_EXCEPTION", e.message, e)
        }
    }

    private fun stopAdvertisingInternal() {
        val listener = registrationListener
        registrationListener = null
        if (listener != null && isAdvertising.get()) {
            try {
                nsdManager?.unregisterService(listener)
            } catch (e: Exception) {
                Log.w(TAG, "Error unregistering service: ${e.message}")
            }
        }
        isAdvertising.set(false)
    }

    @ReactMethod
    fun stopAdvertising(promise: Promise) {
        stopAdvertisingInternal()
        emitStatus()
        promise.resolve(true)
    }

    @ReactMethod
    fun startDiscovery(promise: Promise) {
        if (nsdManager == null) {
            promise.reject("NSD_UNAVAILABLE", "NsdManager is not available on this device")
            return
        }
        discoveryRequested.set(true)
        ensureNetworkCallback()
        startDiscoveryInternal(promise)
    }

    private fun startDiscoveryInternal(promise: Promise? = null) {
        if (nsdManager == null) {
            promise?.reject("NSD_UNAVAILABLE", "NsdManager is not available on this device")
            return
        }

        if (isDiscovering.get()) {
            promise?.resolve(true)
            return
        }

        val generation = ++discoveryGeneration
        acquireMulticastLock()
        discoveredServices.clear()
        resolveQueue.clear()

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) {
                if (generation != discoveryGeneration) return
                Log.d(TAG, "Service discovery started: $regType generation=$generation")
                isDiscovering.set(true)
                emitStatus()
                try { promise?.resolve(true) } catch (_: Exception) {}
            }

            override fun onServiceFound(service: NsdServiceInfo) {
                if (generation != discoveryGeneration) return
                Log.d(TAG, "Service found: ${service.serviceName} type: ${service.serviceType}")
                if (service.serviceType.contains("_g1chat") || service.serviceType.contains("_tcp")) {
                    enqueueResolve(service, generation)
                }
            }

            override fun onServiceLost(service: NsdServiceInfo) {
                if (generation != discoveryGeneration) return
                Log.d(TAG, "Service lost: ${service.serviceName}")
                val devId = discoveredServices.remove(service.serviceName) ?: ""
                emitPeerLost(service.serviceName, devId)
            }

            override fun onDiscoveryStopped(serviceType: String) {
                if (generation != discoveryGeneration) return
                Log.d(TAG, "Discovery stopped: $serviceType")
                isDiscovering.set(false)
                releaseMulticastLock()
                emitStatus()
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                if (generation != discoveryGeneration) return
                Log.e(TAG, "Discovery failed to start: $errorCode")
                isDiscovering.set(false)
                releaseMulticastLock()
                emitStatus("Discovery failed to start: $errorCode")
                try { promise?.reject("START_DISCOVERY_FAILED", "ErrorCode: $errorCode") } catch (_: Exception) {}
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                if (generation != discoveryGeneration) return
                Log.w(TAG, "Stop discovery failed: $errorCode")
                isDiscovering.set(false)
                releaseMulticastLock()
                emitStatus("Stop discovery failed: $errorCode")
            }
        }

        discoveryListener = listener
        try {
            nsdManager?.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (e: Exception) {
            if (generation == discoveryGeneration) {
                isDiscovering.set(false)
                releaseMulticastLock()
            }
            promise?.reject("DISCOVERY_EXCEPTION", e.message, e)
        }
    }

    private fun enqueueResolve(serviceInfo: NsdServiceInfo, generation: Long) {
        if (generation != discoveryGeneration) return
        resolveQueue.add(serviceInfo)
        processNextResolve(generation)
    }

    @Synchronized
    private fun processNextResolve(generation: Long = discoveryGeneration) {
        if (generation != discoveryGeneration || isResolving.get()) return
        val next = resolveQueue.poll() ?: return

        isResolving.set(true)

        val resolveListener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                if (generation == discoveryGeneration) {
                    Log.w(TAG, "Resolve failed for ${serviceInfo.serviceName}: $errorCode")
                }
                isResolving.set(false)
                mainHandler.postDelayed({ processNextResolve(generation) }, 100)
            }

            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                try {
                    if (generation == discoveryGeneration) {
                        handleResolvedService(serviceInfo)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error processing resolved service: ${e.message}", e)
                } finally {
                    isResolving.set(false)
                    mainHandler.postDelayed({ processNextResolve(generation) }, 50)
                }
            }
        }

        try {
            nsdManager?.resolveService(next, resolveListener)
        } catch (e: Exception) {
            Log.w(TAG, "Exception calling resolveService: ${e.message}")
            isResolving.set(false)
            mainHandler.postDelayed({ processNextResolve(generation) }, 100)
        }
    }

    private fun handleResolvedService(serviceInfo: NsdServiceInfo) {
        val resolvedHost = serviceInfo.host ?: return
        val hostAddress = resolvedHost.hostAddress ?: return
        val port = serviceInfo.port
        val cleanHost = LanDiscoveryHelper.cleanHostAddress(hostAddress)

        val attributesMap = Arguments.createMap()
        var peerDevId = ""
        var peerDevName = ""

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            val attributes = serviceInfo.attributes
            for ((key, valueBytes) in attributes) {
                val valueStr = if (valueBytes != null) String(valueBytes, StandardCharsets.UTF_8) else ""
                attributesMap.putString(key, valueStr)
                if (key.equals("deviceId", ignoreCase = true)) {
                    peerDevId = valueStr
                } else if (key.equals("deviceName", ignoreCase = true)) {
                    peerDevName = valueStr
                }
            }
        }

        peerDevId = LanDiscoveryHelper.extractDeviceId(serviceInfo.serviceName, peerDevId)
        if (peerDevName.isEmpty()) peerDevName = "G1 Device"

        if (LanDiscoveryHelper.isSelfDiscovery(myDeviceId, peerDevId)) {
            Log.d(TAG, "Ignoring self discovery for deviceId: $peerDevId")
            return
        }

        // Keep the original InetAddress for route classification. Re-parsing a
        // scoped link-local string is unnecessary and varies across Android
        // releases, while the NSD result already carries the exact scope.
        val routeInterface = findBestRouteInterface(resolvedHost)
        if (LanDiscoveryHelper.isP2pInterfaceName(routeInterface)) {
            Log.d(
                TAG,
                "Ignoring NSD result on P2P interface: peer=$peerDevName ($peerDevId) host=$cleanHost interface=$routeInterface"
            )
            val previousId = discoveredServices.remove(serviceInfo.serviceName)
            if (!previousId.isNullOrBlank()) {
                emitPeerLost(serviceInfo.serviceName, previousId)
            }
            return
        }

        discoveredServices[serviceInfo.serviceName] = peerDevId

        val params = Arguments.createMap().apply {
            putString("serviceName", serviceInfo.serviceName)
            putString("deviceId", peerDevId)
            putString("deviceName", peerDevName)
            putString("host", cleanHost)
            putInt("port", port)
            putMap("attributes", attributesMap)
            if (!routeInterface.isNullOrBlank()) putString("interfaceName", routeInterface)
        }

        Log.d(
            TAG,
            "Emitting LAN_PEER_FOUND: $peerDevName ($peerDevId) at $cleanHost:$port interface=${routeInterface ?: "unknown"}"
        )
        sendEvent(EVENT_PEER_FOUND, params)
    }

    private fun findBestRouteInterface(target: InetAddress): String? {
        val cm = connectivityManager ?: return null
        var bestInterface: String? = null
        var bestPrefix = -1

        try {
            for (network in cm.allNetworks) {
                val lp = cm.getLinkProperties(network) ?: continue
                for (route in lp.routes) {
                    val destination = route.destination ?: continue
                    if (destination.contains(target) && destination.prefixLength > bestPrefix) {
                        bestPrefix = destination.prefixLength
                        bestInterface = lp.interfaceName
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Unable to determine route interface for ${target.hostAddress}: ${e.message}")
        }
        return bestInterface
    }

    private fun emitPeerLost(serviceName: String, deviceId: String) {
        val params = Arguments.createMap().apply {
            putString("serviceName", serviceName)
            putString("deviceId", deviceId)
        }
        sendEvent(EVENT_PEER_LOST, params)
    }

    private fun stopDiscoveryInternal() {
        discoveryGeneration++
        val listener = discoveryListener
        discoveryListener = null
        if (listener != null) {
            try {
                nsdManager?.stopServiceDiscovery(listener)
            } catch (e: Exception) {
                Log.w(TAG, "Error stopping discovery: ${e.message}")
            }
        }
        isDiscovering.set(false)
        isResolving.set(false)
        releaseMulticastLock()
        resolveQueue.clear()
    }

    private fun restartDiscoveryInternal() {
        if (!discoveryRequested.get()) return
        stopDiscoveryInternal()
        discoveredServices.clear()
        mainHandler.postDelayed({
            if (discoveryRequested.get()) {
                startDiscoveryInternal(null)
            }
        }, NETWORK_REFRESH_DELAY_MS)
    }

    private fun scheduleDiscoveryRefresh(reason: String) {
        pendingRefreshReason = reason
        mainHandler.removeCallbacks(discoveryRefreshRunnable)
        mainHandler.postDelayed(discoveryRefreshRunnable, NETWORK_REFRESH_DELAY_MS)
    }

    private fun ensureNetworkCallback() {
        if (networkCallbackRegistered) return
        val cm = connectivityManager ?: return
        try {
            val request = NetworkRequest.Builder()
                .clearCapabilities()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .build()
            cm.registerNetworkCallback(request, networkCallback)
            networkCallbackRegistered = true
            for (network in cm.allNetworks) inspectNetworkForP2p(network)
        } catch (e: Exception) {
            Log.w(TAG, "Unable to register network callback: ${e.message}")
        }
    }

    private fun inspectNetworkForP2p(network: Network) {
        val iface = try { connectivityManager?.getLinkProperties(network)?.interfaceName } catch (_: Exception) { null }
        if (LanDiscoveryHelper.isP2pInterfaceName(iface)) {
            p2pNetworks.add(network)
        }
    }

    private fun unregisterNetworkCallback() {
        mainHandler.removeCallbacks(discoveryRefreshRunnable)
        if (!networkCallbackRegistered) return
        try {
            connectivityManager?.unregisterNetworkCallback(networkCallback)
        } catch (_: Exception) {}
        networkCallbackRegistered = false
        p2pNetworks.clear()
    }

    @ReactMethod
    fun stopDiscovery(promise: Promise) {
        discoveryRequested.set(false)
        stopDiscoveryInternal()
        unregisterNetworkCallback()
        emitStatus()
        promise.resolve(true)
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        val params = Arguments.createMap().apply {
            putBoolean("isAdvertising", isAdvertising.get())
            putBoolean("isDiscovering", isDiscovering.get())
            putString("myDeviceId", myDeviceId)
        }
        promise.resolve(params)
    }

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        discoveryRequested.set(false)
        unregisterNetworkCallback()
        stopAdvertisingInternal()
        stopDiscoveryInternal()
    }
}
