package com.m200.directconnection

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.LocationManager
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pInfo
import android.net.wifi.p2p.WifiP2pManager
import android.net.wifi.p2p.WifiP2pManager.*
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceInfo
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

class DirectConnectionModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private var wifiP2pManager: WifiP2pManager? = null
    private var channel: Channel? = null
    private val intentFilter = IntentFilter().apply {
        addAction(WIFI_P2P_STATE_CHANGED_ACTION)
        addAction(WIFI_P2P_PEERS_CHANGED_ACTION)
        addAction(WIFI_P2P_CONNECTION_CHANGED_ACTION)
        addAction(WIFI_P2P_THIS_DEVICE_CHANGED_ACTION)
    }
    private var receiver: BroadcastReceiver? = null
    private var isReceiverRegistered = false
    private val mainHandler = Handler(Looper.getMainLooper())

    init {
        wifiP2pManager = reactContext.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager?
        channel = wifiP2pManager?.initialize(reactContext, Looper.getMainLooper(), null)
    }

    override fun getName() = "DirectConnectionModule"

    private val SERVICE_NAME = "_musabchat"
    private val SERVICE_TYPE = "_presence._tcp"
    private var serviceInfo: WifiP2pDnsSdServiceInfo? = null
    private var serviceRequest: WifiP2pDnsSdServiceRequest? = null
    private var advertising = false
    private var advertisingGeneration = 0
    private var serviceDiscoveryGeneration = 0
    private var connectionGeneration = 0L
    private var restorePassiveAfterNextPeerScan = false

    @ReactMethod
    fun startAdvertising(deviceLabel: String, deviceId: String, promise: Promise) {
        try {
            if (channel == null && !ensureChannel()) {
                promise.reject("ERROR", "تعذّرت تهيئة واي فاي مباشر"); return
            }
            if (advertising && serviceInfo != null) {
                promise.resolve(true)
                return
            }
            val generation = ++advertisingGeneration
            startAdvertisingWithRetry(deviceLabel, deviceId, promise, generation, 0, false)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    private fun startAdvertisingWithRetry(
        deviceLabel: String,
        deviceId: String,
        promise: Promise,
        generation: Int,
        attempt: Int,
        channelReset: Boolean
    ) {
        if (generation != advertisingGeneration) {
            promise.resolve(false)
            return
        }
        val manager = wifiP2pManager ?: run { promise.reject("ERROR", "غير متاح"); return }
        val currentChannel = channel ?: run { promise.reject("ERROR", "تعذّرت تهيئة واي فاي مباشر"); return }
        val record = mapOf(
            "app" to "musabchat",
            "name" to deviceLabel,
            "id" to deviceId,
            "ver" to "1"
        )
        val info = WifiP2pDnsSdServiceInfo.newInstance(SERVICE_NAME, SERVICE_TYPE, record)

        try {
            manager.addLocalService(currentChannel, info, object : ActionListener {
                override fun onSuccess() {
                    if (generation != advertisingGeneration || currentChannel !== channel) {
                        try { manager.removeLocalService(currentChannel, info, null) } catch (_: Exception) {}
                        promise.resolve(false)
                        return
                    }
                    serviceInfo = info
                    advertising = true
                    promise.resolve(true)
                }

                override fun onFailure(reason: Int) {
                    if (generation != advertisingGeneration) {
                        promise.resolve(false)
                    } else if (reason == BUSY && attempt < 4) {
                        mainHandler.postDelayed({
                            startAdvertisingWithRetry(
                                deviceLabel, deviceId, promise, generation, attempt + 1, channelReset
                            )
                        }, 700L * (attempt + 1))
                    } else if (reason == BUSY && !channelReset && recreateChannel()) {
                        mainHandler.postDelayed({
                            startAdvertisingWithRetry(
                                deviceLabel, deviceId, promise, generation, 0, true
                            )
                        }, 900L)
                    } else {
                        advertising = false
                        promise.resolve(false)
                    }
                }
            })
        } catch (e: Exception) {
            if (generation != advertisingGeneration) {
                promise.resolve(false)
            } else if (!channelReset && recreateChannel()) {
                mainHandler.postDelayed({
                    startAdvertisingWithRetry(deviceLabel, deviceId, promise, generation, 0, true)
                }, 900L)
            } else {
                promise.reject("ERROR", e.message)
            }
        }
    }

    @ReactMethod
    fun stopAdvertising(promise: Promise) {
        try {
            val generation = ++advertisingGeneration
            val info = serviceInfo
            if (info == null) {
                advertising = false
                promise.resolve(true)
                return
            }
            val manager = wifiP2pManager
            val currentChannel = channel
            if (manager == null || currentChannel == null) {
                serviceInfo = null
                advertising = false
                promise.resolve(true)
                return
            }
            manager.removeLocalService(currentChannel, info, object : ActionListener {
                override fun onSuccess() {
                    if (generation == advertisingGeneration && serviceInfo === info) {
                        serviceInfo = null
                        advertising = false
                    }
                    promise.resolve(true)
                }

                override fun onFailure(reason: Int) { promise.resolve(false) }
            })
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun discoverMusabPeers(promise: Promise) {
        try {
            if (channel == null && !ensureChannel()) {
                promise.reject("ERROR", "تعذّرت تهيئة واي فاي مباشر"); return
            }
            if (serviceRequest != null) {
                promise.reject("ERROR", "Service discovery request already active")
                return
            }
            val generation = ++serviceDiscoveryGeneration
            discoverMusabPeersWithRetry(promise, generation, 0, false)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    private fun discoverMusabPeersWithRetry(
        promise: Promise,
        generation: Int,
        attempt: Int,
        channelReset: Boolean
    ) {
        if (generation != serviceDiscoveryGeneration) {
            promise.resolve(false)
            return
        }

        val manager = wifiP2pManager ?: run {
            promise.reject("ERROR", "غير متاح")
            return
        }
        val currentChannel = channel ?: run {
            promise.reject("ERROR", "تعذّرت تهيئة واي فاي مباشر")
            return
        }

        fun failOrRetry(stage: String, reason: Int) {
            if (generation != serviceDiscoveryGeneration) {
                promise.resolve(false)
                return
            }
            if (reason == BUSY && attempt < 4) {
                mainHandler.postDelayed({
                    discoverMusabPeersWithRetry(promise, generation, attempt + 1, channelReset)
                }, 700L * (attempt + 1))
            } else if (reason == BUSY && !channelReset && recreateChannel()) {
                mainHandler.postDelayed({
                    discoverMusabPeersWithRetry(promise, generation, 0, true)
                }, 900L)
            } else {
                promise.reject("ERROR", "$stage failed: $reason (${reasonName(reason)})")
            }
        }

        try {
            manager.setDnsSdResponseListeners(currentChannel,
                { instanceName, registrationType, device ->
                    if (generation == serviceDiscoveryGeneration &&
                        instanceName.contains("musabchat", ignoreCase = true)) {
                        sendEvent("MUSAB_PEER_FOUND", Arguments.createMap().apply {
                            putString("deviceName", device.deviceName)
                            putString("deviceAddress", device.deviceAddress)
                            putString("instanceName", instanceName)
                            putInt("status", device.status)
                        })
                    }
                },
                { fullDomain, record, device ->
                    val app = record["app"]
                    if (generation == serviceDiscoveryGeneration && app == "musabchat") {
                        sendEvent("MUSAB_PEER_FOUND", Arguments.createMap().apply {
                            putString("deviceName", record["name"] ?: device.deviceName)
                            putString("deviceAddress", device.deviceAddress)
                            putString("label", record["name"])
                            putString("peerId", record["id"])
                            putInt("status", device.status)
                        })
                    }
                }
            )

            val request = WifiP2pDnsSdServiceRequest.newInstance(SERVICE_NAME, SERVICE_TYPE)
            manager.addServiceRequest(currentChannel, request, object : ActionListener {
                override fun onSuccess() {
                    if (generation != serviceDiscoveryGeneration || currentChannel !== channel) {
                        try { manager.removeServiceRequest(currentChannel, request, null) } catch (_: Exception) {}
                        promise.resolve(false)
                        return
                    }
                    serviceRequest = request
                    manager.discoverServices(currentChannel, object : ActionListener {
                        override fun onSuccess() {
                            promise.resolve(generation == serviceDiscoveryGeneration)
                        }

                        override fun onFailure(reason: Int) {
                            removeOwnedServiceRequestBeforeRetry(
                                manager,
                                currentChannel,
                                request,
                                generation,
                                channelReset,
                                reason,
                                onRemoved = { failOrRetry("Service discovery", reason) },
                                onChannelReset = {
                                    mainHandler.postDelayed({
                                        discoverMusabPeersWithRetry(promise, generation, 0, true)
                                    }, 900L)
                                },
                                onRemoveFailure = {
                                    promise.reject(
                                        "ERROR",
                                        "Service discovery failed: $reason (${reasonName(reason)})"
                                    )
                                }
                            )
                        }
                    })
                }

                override fun onFailure(reason: Int) {
                    if (serviceRequest === request) serviceRequest = null
                    failOrRetry("Service request", reason)
                }
            })
        } catch (e: Exception) {
            if (generation != serviceDiscoveryGeneration) {
                promise.resolve(false)
            } else if (!channelReset && recreateChannel()) {
                mainHandler.postDelayed({
                    discoverMusabPeersWithRetry(promise, generation, 0, true)
                }, 900L)
            } else {
                promise.reject("ERROR", e.message)
            }
        }
    }

    private fun removeOwnedServiceRequestBeforeRetry(
        manager: WifiP2pManager,
        operationChannel: Channel,
        request: WifiP2pDnsSdServiceRequest,
        generation: Int,
        channelReset: Boolean,
        originalReason: Int,
        onRemoved: () -> Unit,
        onChannelReset: () -> Unit,
        onRemoveFailure: () -> Unit
    ) {
        if (generation != serviceDiscoveryGeneration || serviceRequest !== request) {
            onRemoved()
            return
        }
        try {
            manager.removeServiceRequest(operationChannel, request, object : ActionListener {
                override fun onSuccess() {
                    if (serviceRequest === request) serviceRequest = null
                    onRemoved()
                }

                override fun onFailure(reason: Int) {
                    if (originalReason == BUSY && !channelReset && recreateChannel()) {
                        onChannelReset()
                    } else {
                        onRemoveFailure()
                    }
                }
            })
        } catch (_: Exception) {
            if (originalReason == BUSY && !channelReset && recreateChannel()) {
                onChannelReset()
            } else {
                onRemoveFailure()
            }
        }
    }

    @ReactMethod
    fun stopServiceDiscovery(promise: Promise) {
        try {
            serviceDiscoveryGeneration++
            restorePassiveAfterNextPeerScan = true
            val request = serviceRequest
            if (request == null) {
                promise.resolve(true)
                return
            }
            val manager = wifiP2pManager
            val currentChannel = channel
            if (manager == null || currentChannel == null) {
                serviceRequest = null
                promise.resolve(true)
                return
            }
            manager.removeServiceRequest(currentChannel, request, object : ActionListener {
                override fun onSuccess() {
                    if (serviceRequest === request) serviceRequest = null
                    promise.resolve(true)
                }
                override fun onFailure(reason: Int) { promise.resolve(false) }
            })
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    private fun ensureChannel(): Boolean {
        if (wifiP2pManager == null) {
            wifiP2pManager = reactApplicationContext.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager?
        }
        if (channel == null) {
            channel = wifiP2pManager?.initialize(reactApplicationContext, Looper.getMainLooper(), null)
        }
        return channel != null
    }

    private fun resetChannelScopedServiceState() {
        serviceInfo = null
        serviceRequest = null
        advertising = false
        restorePassiveAfterNextPeerScan = false
    }

    private fun recreateChannel(): Boolean {
        val manager = wifiP2pManager ?: return false
        val previousChannel = channel
        channel = null
        resetChannelScopedServiceState()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            try { previousChannel?.close() } catch (_: Exception) {}
        }
        channel = manager.initialize(reactApplicationContext, Looper.getMainLooper(), null)
        return channel != null
    }

    private fun reasonName(reason: Int) = when (reason) {
        ERROR -> "ERROR"
        P2P_UNSUPPORTED -> "P2P_UNSUPPORTED"
        BUSY -> "BUSY"
        else -> "UNKNOWN"
    }

    @ReactMethod
    fun isSupported(promise: Promise) {
        val pm = reactApplicationContext.packageManager
        promise.resolve(pm.hasSystemFeature("android.hardware.wifi.direct") && wifiP2pManager != null)
    }

    @ReactMethod
    fun isLocationEnabled(promise: Promise) {
        val lm = reactApplicationContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val enabled = try {
            lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        } catch (e: Exception) { false }
        promise.resolve(enabled)
    }

    @ReactMethod
    fun openLocationSettings(promise: Promise) {
        val intent = Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
        reactApplicationContext.startActivity(intent)
        promise.resolve(true)
    }

    @ReactMethod
    fun bindToWifiDirectNetwork(promise: Promise) {
        bindWithRetry(promise, 0)
    }

    private fun bindWithRetry(promise: Promise, attempt: Int) {
        try {
            val cm = reactApplicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            for (network in cm.allNetworks) {
                val ifaceName = cm.getLinkProperties(network)?.interfaceName
                if (ifaceName != null && ifaceName.contains("p2p")) {
                    promise.resolve(cm.bindProcessToNetwork(network))
                    return
                }
            }
            for (network in cm.allNetworks) {
                val caps = cm.getNetworkCapabilities(network)
                if (caps != null && caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) {
                    val lp = cm.getLinkProperties(network)
                    val hasP2pAddr = lp?.linkAddresses?.any { it.address.hostAddress?.startsWith("192.168.49.") == true } ?: false
                    if (hasP2pAddr) {
                        promise.resolve(cm.bindProcessToNetwork(network))
                        return
                    }
                }
            }
            if (attempt < 10) {
                mainHandler.postDelayed({ bindWithRetry(promise, attempt + 1) }, 500)
                return
            }
            promise.resolve(false)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun unbindNetwork(promise: Promise) {
        try {
            val cm = reactApplicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            cm.bindProcessToNetwork(null)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun getLocalIpAddress(promise: Promise) {
        try {
            val interfaces = java.net.NetworkInterface.getNetworkInterfaces()
            var fallback: String? = null
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                val addrs = intf.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (!addr.isLoopbackAddress && addr is java.net.Inet4Address) {
                        val ip = addr.hostAddress
                        if (intf.name.contains("p2p") || ip.startsWith("192.168.49.")) {
                            promise.resolve(ip)
                            return
                        }
                        if (fallback == null) fallback = ip
                    }
                }
            }
            promise.resolve(fallback)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun initialize(promise: Promise) {
        if (!ensureChannel()) {
            promise.reject("ERROR", "Wi-Fi Direct not available")
            return
        }
        registerReceiver()
        promise.resolve(true)
    }

    @ReactMethod
    fun discoverPeers(promise: Promise) {
        val restorePassive = restorePassiveAfterNextPeerScan
        restorePassiveAfterNextPeerScan = false
        startDiscoveryWithRetry(promise, 0, restorePassive, connectionGeneration)
    }

    @ReactMethod
    fun startPassiveListening(promise: Promise) {
        if (!ensureChannel()) {
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }
        startPassiveListeningWithRetry(promise, 0, false)
    }

    private fun startPassiveListeningWithRetry(promise: Promise, attempt: Int, channelReset: Boolean) {
        val manager = wifiP2pManager ?: run {
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }
        val currentChannel = channel ?: run {
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }

        try {
            val listener = object : ActionListener {
                override fun onSuccess() {
                    emitCurrentPeers()
                    promise.resolve(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) "listen" else "discovery")
                }

                override fun onFailure(reason: Int) {
                    if (reason == BUSY && attempt < 4) {
                        mainHandler.postDelayed({
                            startPassiveListeningWithRetry(promise, attempt + 1, channelReset)
                        }, 700L * (attempt + 1))
                    } else if (reason == BUSY && !channelReset && recreateChannel()) {
                        mainHandler.postDelayed({
                            startPassiveListeningWithRetry(promise, 0, true)
                        }, 900L)
                    } else {
                        promise.reject("ERROR", "Passive listening failed: $reason (${reasonName(reason)})")
                    }
                }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                manager.startListening(currentChannel, listener)
            } else {
                manager.discoverPeers(currentChannel, listener)
            }
        } catch (e: Exception) {
            if (!channelReset && recreateChannel()) {
                mainHandler.postDelayed({ startPassiveListeningWithRetry(promise, 0, true) }, 900L)
            } else {
                promise.reject("ERROR", e.message)
            }
        }
    }

    private fun startDiscoveryWithRetry(
        promise: Promise,
        attempt: Int,
        restorePassive: Boolean,
        connectionEpoch: Long
    ) {
        val manager = wifiP2pManager
        val currentChannel = channel
        if (manager == null || currentChannel == null) {
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }
        manager.discoverPeers(currentChannel, object : ActionListener {
            override fun onSuccess() {
                if (restorePassive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    mainHandler.postDelayed({
                        restorePassiveListeningAfterScan(currentChannel, connectionEpoch, 0)
                    }, 3200L)
                }
                promise.resolve("Discovery started")
            }
            override fun onFailure(reason: Int) {
                if (reason == BUSY && attempt < 4) {
                    mainHandler.postDelayed({
                        startDiscoveryWithRetry(promise, attempt + 1, restorePassive, connectionEpoch)
                    }, 700L * (attempt + 1))
                } else {
                    promise.reject("ERROR", "Discovery failed: $reason (${reasonName(reason)})")
                }
            }
        })
    }

    private fun restorePassiveListeningAfterScan(
        expectedChannel: Channel,
        connectionEpoch: Long,
        attempt: Int
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (channel !== expectedChannel || connectionGeneration != connectionEpoch) return
        val manager = wifiP2pManager ?: return
        try {
            manager.startListening(expectedChannel, object : ActionListener {
                override fun onSuccess() { emitCurrentPeers() }
                override fun onFailure(reason: Int) {
                    if (reason == BUSY && attempt < 4 &&
                        channel === expectedChannel && connectionGeneration == connectionEpoch) {
                        mainHandler.postDelayed({
                            restorePassiveListeningAfterScan(expectedChannel, connectionEpoch, attempt + 1)
                        }, 700L * (attempt + 1))
                    }
                }
            })
        } catch (_: Exception) {}
    }

    @ReactMethod
    fun stopDiscovery(promise: Promise) {
        wifiP2pManager?.stopPeerDiscovery(channel, object : ActionListener {
            override fun onSuccess() { promise.resolve("Discovery stopped") }
            override fun onFailure(reason: Int) { promise.reject("ERROR", "Stop discovery failed: $reason (${reasonName(reason)})") }
        }) ?: promise.reject("ERROR", "Wi-Fi Direct not initialized")
    }

    @ReactMethod
    fun requestPeers(promise: Promise) {
        val manager = wifiP2pManager
        val currentChannel = channel
        if (manager == null || currentChannel == null) {
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }
        try {
            manager.requestPeers(currentChannel) { peers -> promise.resolve(peersArray(peers?.deviceList ?: emptyList())) }
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun createGroup(promise: Promise) {
        restorePassiveAfterNextPeerScan = false
        connectionGeneration++
        wifiP2pManager?.createGroup(channel, object : ActionListener {
            override fun onSuccess() { promise.resolve("Group creation started") }
            override fun onFailure(reason: Int) { promise.reject("ERROR", "Create group failed: $reason (${reasonName(reason)})") }
        }) ?: promise.reject("ERROR", "Wi-Fi Direct not initialized")
    }

    @ReactMethod
    fun connectToPeer(deviceAddress: String, promise: Promise) {
        restorePassiveAfterNextPeerScan = false
        connectionGeneration++
        val config = WifiP2pConfig().apply { this.deviceAddress = deviceAddress }
        wifiP2pManager?.connect(channel, config, object : ActionListener {
            override fun onSuccess() { promise.resolve("Connecting to peer") }
            override fun onFailure(reason: Int) { promise.reject("ERROR", "Connection failed: $reason (${reasonName(reason)})") }
        }) ?: promise.reject("ERROR", "Wi-Fi Direct not initialized")
    }

    @ReactMethod
    fun cancelConnect(promise: Promise) {
        restorePassiveAfterNextPeerScan = false
        connectionGeneration++
        try {
            wifiP2pManager?.cancelConnect(channel, object : ActionListener {
                override fun onSuccess() { promise.resolve(true) }
                override fun onFailure(reason: Int) { promise.resolve(false) }
            }) ?: promise.resolve(false)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun disconnect(promise: Promise) {
        restorePassiveAfterNextPeerScan = false
        connectionGeneration++
        wifiP2pManager?.removeGroup(channel, object : ActionListener {
            override fun onSuccess() { promise.resolve("Disconnected") }
            override fun onFailure(reason: Int) { promise.reject("ERROR", "Disconnect failed: $reason (${reasonName(reason)})") }
        }) ?: promise.reject("ERROR", "Wi-Fi Direct not initialized")
    }

    @ReactMethod
    fun cleanupConnection(timeoutMs: Double, promise: Promise) {
        restorePassiveAfterNextPeerScan = false
        connectionGeneration++
        if (!ensureChannel()) {
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }
        val manager = wifiP2pManager ?: run {
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }
        val operationChannel = channel ?: run {
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }
        val timeout = timeoutMs.toLong().coerceIn(2_000L, 15_000L)
        val startedAt = SystemClock.elapsedRealtime()
        var settled = false
        var lastRemoveAt = 0L
        var consecutiveEmptyChecks = 0
        var lastFailure: Int? = null

        serviceDiscoveryGeneration++
        serviceRequest = null

        fun withinDeadline(): Boolean =
            SystemClock.elapsedRealtime() - startedAt < timeout

        fun finish(clean: Boolean, timedOut: Boolean, reinitialized: Boolean) {
            if (settled) return
            settled = true
            promise.resolve(Arguments.createMap().apply {
                putBoolean("clean", clean)
                putBoolean("timedOut", timedOut)
                putBoolean("channelReinitialized", reinitialized)
                putDouble("elapsedMs", (SystemClock.elapsedRealtime() - startedAt).toDouble())
                if (lastFailure == null) {
                    putNull("lastFailureCode")
                    putNull("lastFailureName")
                } else {
                    putInt("lastFailureCode", lastFailure!!)
                    putString("lastFailureName", reasonName(lastFailure!!))
                }
            })
        }

        lateinit var pollGroup: () -> Unit
        pollGroup = {
            if (!settled) {
                try {
                    manager.requestGroupInfo(operationChannel) { group ->
                        if (settled) return@requestGroupInfo
                        val now = SystemClock.elapsedRealtime()
                        if (group == null) {
                            consecutiveEmptyChecks++
                            if (consecutiveEmptyChecks >= 2) {
                                val reinitialized = recreateChannel()
                                finish(clean = true, timedOut = false, reinitialized = reinitialized)
                            } else {
                                mainHandler.postDelayed({ pollGroup() }, 350L)
                            }
                        } else if (now - startedAt >= timeout) {
                            consecutiveEmptyChecks = 0
                            val reinitialized = recreateChannel()
                            finish(clean = false, timedOut = true, reinitialized = reinitialized)
                        } else if (now - lastRemoveAt >= 2_000L) {
                            consecutiveEmptyChecks = 0
                            lastRemoveAt = now
                            manager.removeGroup(operationChannel, object : ActionListener {
                                override fun onSuccess() { mainHandler.postDelayed({ pollGroup() }, 250L) }
                                override fun onFailure(reason: Int) {
                                    lastFailure = reason
                                    mainHandler.postDelayed({ pollGroup() }, 400L)
                                }
                            })
                        } else {
                            consecutiveEmptyChecks = 0
                            mainHandler.postDelayed({ pollGroup() }, 250L)
                        }
                    }
                } catch (e: Exception) {
                    val reinitialized = recreateChannel()
                    finish(clean = false, timedOut = false, reinitialized = reinitialized)
                }
            }
        }

        fun cancelThenPoll() {
            if (settled) return
            try {
                manager.cancelConnect(operationChannel, object : ActionListener {
                    override fun onSuccess() { mainHandler.postDelayed({ pollGroup() }, 300L) }
                    override fun onFailure(reason: Int) { mainHandler.postDelayed({ pollGroup() }, 300L) }
                })
            } catch (_: Exception) {
                pollGroup()
            }
        }

        lateinit var clearRequestsThenCancel: (Int) -> Unit
        clearRequestsThenCancel = { attempt ->
            if (!settled) {
                try {
                    manager.clearServiceRequests(operationChannel, object : ActionListener {
                        override fun onSuccess() { mainHandler.postDelayed({ cancelThenPoll() }, 250L) }
                        override fun onFailure(reason: Int) {
                            lastFailure = reason
                            if (reason == BUSY && attempt < 4 && withinDeadline()) {
                                mainHandler.postDelayed({
                                    clearRequestsThenCancel(attempt + 1)
                                }, 350L * (attempt + 1))
                            } else {
                                mainHandler.postDelayed({ cancelThenPoll() }, 250L)
                            }
                        }
                    })
                } catch (_: Exception) {
                    cancelThenPoll()
                }
            }
        }

        lateinit var stopDiscoveryThenClear: (Int) -> Unit
        stopDiscoveryThenClear = { attempt ->
            if (!settled) {
                try {
                    manager.stopPeerDiscovery(operationChannel, object : ActionListener {
                        override fun onSuccess() {
                            mainHandler.postDelayed({ clearRequestsThenCancel(0) }, 350L)
                        }
                        override fun onFailure(reason: Int) {
                            lastFailure = reason
                            if (reason == BUSY && attempt < 4 && withinDeadline()) {
                                mainHandler.postDelayed({
                                    stopDiscoveryThenClear(attempt + 1)
                                }, 350L * (attempt + 1))
                            } else {
                                mainHandler.postDelayed({ clearRequestsThenCancel(0) }, 350L)
                            }
                        }
                    })
                } catch (_: Exception) {
                    clearRequestsThenCancel(0)
                }
            }
        }

        stopDiscoveryThenClear(0)
    }

    @ReactMethod
    fun getConnectionInfo(promise: Promise) {
        val manager = wifiP2pManager
        if (manager == null) { promise.reject("ERROR", "Wi-Fi Direct not initialized"); return }
        manager.requestConnectionInfo(channel) { info: WifiP2pInfo ->
            promise.resolve(Arguments.createMap().apply {
                putBoolean("groupFormed", info.groupFormed)
                putBoolean("isGroupOwner", info.isGroupOwner)
                putString("groupOwnerAddress", info.groupOwnerAddress?.hostAddress)
            })
        }
    }

    private fun peersArray(devices: Collection<WifiP2pDevice>): WritableArray {
        val arr = Arguments.createArray()
        devices.forEach { dev ->
            arr.pushMap(Arguments.createMap().apply {
                putString("deviceName", dev.deviceName)
                putString("deviceAddress", dev.deviceAddress)
                putInt("status", dev.status)
            })
        }
        return arr
    }

    private fun emitCurrentPeers() {
        try {
            wifiP2pManager?.requestPeers(channel) { peers ->
                val arr = peersArray(peers?.deviceList ?: emptyList())
                sendEvent("PEERS_UPDATED", Arguments.createMap().apply { putArray("peers", arr) })
            }
        } catch (_: Exception) {}
    }

    private fun registerReceiver() {
        if (isReceiverRegistered) return
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                when (intent.action) {
                    WIFI_P2P_STATE_CHANGED_ACTION -> {
                        val state = intent.getIntExtra(EXTRA_WIFI_STATE, -1)
                        sendEvent("WIFI_P2P_STATE_CHANGED", Arguments.createMap().apply {
                            putBoolean("enabled", state == WIFI_P2P_STATE_ENABLED)
                        })
                    }
                    WIFI_P2P_PEERS_CHANGED_ACTION -> emitCurrentPeers()
                    WIFI_P2P_CONNECTION_CHANGED_ACTION -> {
                        val eventEpoch = connectionGeneration
                        wifiP2pManager?.requestConnectionInfo(channel) { info ->
                            if (!isCurrentConnectionEpoch(eventEpoch, connectionGeneration)) {
                                return@requestConnectionInfo
                            }
                            if (info.groupFormed) {
                                val ip = info.groupOwnerAddress?.hostAddress
                                if (info.isGroupOwner || ip != null) {
                                    emitPeerConnected(info, ip, eventEpoch)
                                }
                            } else {
                                connectionGeneration++
                                emitCurrentPeers()
                                sendEvent("PEER_DISCONNECTED", Arguments.createMap())
                            }
                        }
                    }
                    WIFI_P2P_THIS_DEVICE_CHANGED_ACTION -> emitCurrentPeers()
                }
            }
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) ContextCompat.RECEIVER_EXPORTED else 0
        ContextCompat.registerReceiver(reactApplicationContext, receiver, intentFilter, flags)
        isReceiverRegistered = true
    }

    private fun emitPeerConnected(info: WifiP2pInfo, groupOwnerAddress: String?, epoch: Long) {
        if (!isCurrentConnectionEpoch(epoch, connectionGeneration)) return
        sendEvent("PEER_CONNECTED", Arguments.createMap().apply {
            putBoolean("groupFormed", true)
            putBoolean("isGroupOwner", info.isGroupOwner)
            putString("groupOwnerAddress", groupOwnerAddress)
            putDouble("connectionEpoch", epoch.toDouble())
        })

        val manager = wifiP2pManager
        val currentChannel = channel
        if (manager == null || currentChannel == null) return

        try {
            manager.requestGroupInfo(currentChannel) { group ->
                if (epoch != connectionGeneration) return@requestGroupInfo
                val peerDeviceAddress = group?.let {
                    connectedPeerAddress(
                        info.isGroupOwner,
                        it.owner?.deviceAddress,
                        it.clientList.map { client -> client.deviceAddress }
                    )
                }
                if (peerDeviceAddress != null) {
                    sendEvent("PEER_ADDRESS_RESOLVED", Arguments.createMap().apply {
                        putDouble("connectionEpoch", epoch.toDouble())
                        putString("peerDeviceAddress", peerDeviceAddress)
                    })
                }
            }
        } catch (_: Exception) {}
    }

    private fun sendEvent(name: String, params: WritableMap) {
        reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, params)
    }

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        receiver?.let { try { reactApplicationContext.unregisterReceiver(it) } catch (_: Exception) {} }
        receiver = null
        isReceiverRegistered = false
    }
}
