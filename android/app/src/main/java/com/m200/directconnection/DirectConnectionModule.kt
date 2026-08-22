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
        addAction(WIFI_P2P_DISCOVERY_CHANGED_ACTION)
    }
    private var receiver: BroadcastReceiver? = null
    private var isReceiverRegistered = false
    private val mainHandler = Handler(Looper.getMainLooper())

    private val SERVICE_NAME = "_musabchat"
    private val SERVICE_TYPE = "_presence._tcp"

    // Cross-OEM availability is kept active rather than relying on extended
    // LISTEN. AOSP's startListening() stops active find, while CTS and mature
    // implementations keep responder-side P2P discovery active/periodic.
    private val ACTIVE_PRESENCE_REFRESH_MS = 45_000L
    private val CONNECTION_ATTEMPT_WATCHDOG_MS = 35_000L
    private val CHANNEL_RECOVERY_BASE_DELAY_MS = 700L
    private val MAX_CHANNEL_RECOVERY_ATTEMPTS = 2

    private var serviceInfo: WifiP2pDnsSdServiceInfo? = null
    private var serviceRequest: WifiP2pDnsSdServiceRequest? = null
    private var advertising = false
    private var advertisingGeneration = 0
    private var serviceDiscoveryGeneration = 0
    private var connectionGeneration = 0L
    private var presenceGeneration = 0
    private var presenceScheduleToken = 0L
    private var channelGeneration = 0L
    private var recoveryGeneration = 0L
    private var discoveryActive = false
    private var cleanupInProgress = false
    private var connectionInProgress = false
    private var groupActive = false
    private var desiredDeviceLabel: String? = null
    private var desiredDeviceId: String? = null

    init {
        wifiP2pManager = reactContext.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager?
        initializeChannel()
    }

    override fun getName() = "DirectConnectionModule"

    private fun initializeChannel(): Boolean {
        val manager = wifiP2pManager ?: return false
        val generation = ++channelGeneration
        channel = manager.initialize(
            reactApplicationContext,
            Looper.getMainLooper(),
            ChannelListener {
                if (generation != channelGeneration) return@ChannelListener
                channel = null
                resetChannelScopedServiceState()
                sendEvent("WIFI_P2P_CHANNEL_CHANGED", Arguments.createMap().apply {
                    putString("state", "disconnected")
                    putDouble("generation", generation.toDouble())
                })
                scheduleBoundedChannelRecovery(generation)
            }
        )
        return channel != null
    }

    private fun scheduleBoundedChannelRecovery(disconnectedGeneration: Long) {
        val recovery = ++recoveryGeneration
        fun attempt(attempt: Int) {
            if (recovery != recoveryGeneration || channel != null) return
            mainHandler.postDelayed({
                if (recovery != recoveryGeneration || channel != null) return@postDelayed
                if (initializeChannel()) {
                    sendEvent("WIFI_P2P_CHANNEL_CHANGED", Arguments.createMap().apply {
                        putString("state", "recovered")
                        putDouble("fromGeneration", disconnectedGeneration.toDouble())
                        putInt("attempt", attempt + 1)
                    })
                    restoreDesiredAdvertising(advertisingGeneration, 0)
                } else if (attempt + 1 < MAX_CHANNEL_RECOVERY_ATTEMPTS) {
                    attempt(attempt + 1)
                } else {
                    sendEvent("WIFI_P2P_CHANNEL_CHANGED", Arguments.createMap().apply {
                        putString("state", "recovery_failed")
                        putInt("attempts", MAX_CHANNEL_RECOVERY_ATTEMPTS)
                    })
                }
            }, CHANNEL_RECOVERY_BASE_DELAY_MS * (attempt + 1))
        }
        attempt(0)
    }

    private fun ensureChannel(): Boolean {
        if (wifiP2pManager == null) {
            wifiP2pManager = reactApplicationContext.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager?
        }
        if (channel == null) initializeChannel()
        return channel != null
    }

    private fun resetChannelScopedServiceState() {
        serviceInfo = null
        serviceRequest = null
        advertising = false
        discoveryActive = false
        presenceGeneration++
        presenceScheduleToken++
    }

    private fun recreateChannel(): Boolean {
        val previousChannel = channel
        recoveryGeneration++
        channel = null
        resetChannelScopedServiceState()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            try { previousChannel?.close() } catch (_: Exception) {}
        }
        val created = initializeChannel()
        if (created) {
            mainHandler.postDelayed({ restoreDesiredAdvertising(advertisingGeneration, 0) }, 250L)
        }
        return created
    }

    private fun reasonName(reason: Int) = when (reason) {
        ERROR -> "ERROR"
        P2P_UNSUPPORTED -> "P2P_UNSUPPORTED"
        BUSY -> "BUSY"
        else -> "UNKNOWN"
    }

    private fun serviceInfoFor(deviceLabel: String, deviceId: String) =
        WifiP2pDnsSdServiceInfo.newInstance(
            SERVICE_NAME,
            SERVICE_TYPE,
            mapOf(
                "app" to "musabchat",
                "name" to deviceLabel,
                "id" to deviceId,
                "ver" to "1"
            )
        )

    @ReactMethod
    fun startAdvertising(deviceLabel: String, deviceId: String, promise: Promise) {
        desiredDeviceLabel = deviceLabel
        desiredDeviceId = deviceId
        try {
            if (!ensureChannel()) {
                promise.reject("ERROR", "تعذّرت تهيئة واي فاي مباشر")
                return
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
        if (advertising && serviceInfo != null) {
            promise.resolve(true)
            return
        }
        val manager = wifiP2pManager ?: run { promise.reject("ERROR", "غير متاح"); return }
        val currentChannel = channel ?: run { promise.reject("ERROR", "تعذّرت تهيئة واي فاي مباشر"); return }
        val info = serviceInfoFor(deviceLabel, deviceId)

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
                    val presence = ++presenceGeneration
                    scheduleActivePresenceRefresh(presence)
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

    private fun restoreDesiredAdvertising(generation: Int, attempt: Int) {
        if (generation != advertisingGeneration || advertising || serviceInfo != null) return
        val label = desiredDeviceLabel ?: return
        val deviceId = desiredDeviceId ?: return
        val manager = wifiP2pManager ?: return
        val currentChannel = channel ?: return
        val info = serviceInfoFor(label, deviceId)
        try {
            manager.addLocalService(currentChannel, info, object : ActionListener {
                override fun onSuccess() {
                    if (generation != advertisingGeneration || currentChannel !== channel) {
                        try { manager.removeLocalService(currentChannel, info, null) } catch (_: Exception) {}
                        return
                    }
                    serviceInfo = info
                    advertising = true
                    val presence = ++presenceGeneration
                    scheduleActivePresenceRefresh(presence)
                    mainHandler.postDelayed({ refreshActivePresence(presence, 0) }, 250L)
                }

                override fun onFailure(reason: Int) {
                    if (generation == advertisingGeneration && reason == BUSY && attempt < 3) {
                        mainHandler.postDelayed({
                            restoreDesiredAdvertising(generation, attempt + 1)
                        }, 600L * (attempt + 1))
                    }
                }
            })
        } catch (_: Exception) {
            if (generation == advertisingGeneration && attempt < 3) {
                mainHandler.postDelayed({ restoreDesiredAdvertising(generation, attempt + 1) }, 700L)
            }
        }
    }

    private fun canRefreshPresence(presence: Int): Boolean =
        presence == presenceGeneration &&
            advertising && serviceInfo != null &&
            serviceRequest == null &&
            !cleanupInProgress && !connectionInProgress && !groupActive

    private fun scheduleActivePresenceRefresh(
        presence: Int,
        delayMs: Long = ACTIVE_PRESENCE_REFRESH_MS
    ) {
        val token = ++presenceScheduleToken
        mainHandler.postDelayed({
            if (token != presenceScheduleToken || presence != presenceGeneration) return@postDelayed
            if (!canRefreshPresence(presence)) {
                if (presence == presenceGeneration && advertising && serviceInfo != null) {
                    scheduleActivePresenceRefresh(presence)
                }
                return@postDelayed
            }
            refreshActivePresence(presence, 0)
        }, delayMs)
    }

    private fun refreshActivePresence(presence: Int, attempt: Int) {
        if (!canRefreshPresence(presence)) return
        val manager = wifiP2pManager ?: return
        val currentChannel = channel ?: return
        try {
            manager.discoverPeers(currentChannel, object : ActionListener {
                override fun onSuccess() {
                    if (presence != presenceGeneration || currentChannel !== channel) return
                    discoveryActive = true
                    scheduleActivePresenceRefresh(presence)
                }

                override fun onFailure(reason: Int) {
                    if (presence != presenceGeneration || currentChannel !== channel) return
                    if (reason == BUSY && attempt < 3) {
                        mainHandler.postDelayed({ refreshActivePresence(presence, attempt + 1) }, 600L * (attempt + 1))
                    } else if (reason == BUSY && recreateChannel()) {
                        // recreateChannel restores desired advertising and starts
                        // a new generation-scoped active presence lease.
                    } else {
                        scheduleActivePresenceRefresh(presence)
                    }
                }
            })
        } catch (_: Exception) {
            if (attempt < 2) {
                mainHandler.postDelayed({ refreshActivePresence(presence, attempt + 1) }, 700L)
            } else {
                recreateChannel()
            }
        }
    }

    @ReactMethod
    fun stopAdvertising(promise: Promise) {
        desiredDeviceLabel = null
        desiredDeviceId = null
        presenceGeneration++
        presenceScheduleToken++
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
        } catch (_: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun discoverMusabPeers(promise: Promise) {
        try {
            if (!ensureChannel()) {
                promise.reject("ERROR", "تعذّرت تهيئة واي فاي مباشر")
                return
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
        val manager = wifiP2pManager ?: run { promise.reject("ERROR", "غير متاح"); return }
        val currentChannel = channel ?: run { promise.reject("ERROR", "تعذّرت تهيئة واي فاي مباشر"); return }

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
            manager.setDnsSdResponseListeners(
                currentChannel,
                { instanceName, _, device ->
                    if (generation == serviceDiscoveryGeneration && instanceName.contains("musabchat", ignoreCase = true)) {
                        sendEvent("MUSAB_PEER_FOUND", Arguments.createMap().apply {
                            putString("deviceName", device.deviceName)
                            putString("deviceAddress", device.deviceAddress)
                            putString("instanceName", instanceName)
                            putInt("status", device.status)
                        })
                    }
                },
                { _, record, device ->
                    if (generation == serviceDiscoveryGeneration && record["app"] == "musabchat") {
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
                        override fun onSuccess() { promise.resolve(generation == serviceDiscoveryGeneration) }
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
                                    mainHandler.postDelayed({ discoverMusabPeersWithRetry(promise, generation, 0, true) }, 900L)
                                },
                                onRemoveFailure = {
                                    promise.reject("ERROR", "Service discovery failed: $reason (${reasonName(reason)})")
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
                mainHandler.postDelayed({ discoverMusabPeersWithRetry(promise, generation, 0, true) }, 900L)
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
                    if (originalReason == BUSY && !channelReset && recreateChannel()) onChannelReset()
                    else onRemoveFailure()
                }
            })
        } catch (_: Exception) {
            if (originalReason == BUSY && !channelReset && recreateChannel()) onChannelReset()
            else onRemoveFailure()
        }
    }

    @ReactMethod
    fun stopServiceDiscovery(promise: Promise) {
        try {
            serviceDiscoveryGeneration++
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
        } catch (_: Exception) {
            promise.resolve(false)
        }
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
        } catch (_: Exception) { false }
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
                mainHandler.postDelayed({ bindWithRetry(promise, attempt + 1) }, 500L)
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
        startDiscoveryWithRetry(promise, 0, false)
    }

    @ReactMethod
    fun startPassiveListening(promise: Promise) {
        // API name retained for JS compatibility; behavior intentionally uses
        // active discovery so a cold/lazy OEM P2P interface is actually primed.
        startDiscoveryWithRetry(promise, 0, false)
    }

    private fun startDiscoveryWithRetry(promise: Promise, attempt: Int, channelReset: Boolean) {
        if (!ensureChannel()) {
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }
        val manager = wifiP2pManager ?: run { promise.reject("ERROR", "Wi-Fi Direct not initialized"); return }
        val currentChannel = channel ?: run { promise.reject("ERROR", "Wi-Fi Direct not initialized"); return }
        try {
            manager.discoverPeers(currentChannel, object : ActionListener {
                override fun onSuccess() {
                    if (currentChannel !== channel) {
                        promise.resolve(false)
                        return
                    }
                    discoveryActive = true
                    promise.resolve("Discovery started")
                }
                override fun onFailure(reason: Int) {
                    if (reason == BUSY && attempt < 4) {
                        mainHandler.postDelayed({ startDiscoveryWithRetry(promise, attempt + 1, channelReset) }, 700L * (attempt + 1))
                    } else if (reason == BUSY && !channelReset && recreateChannel()) {
                        mainHandler.postDelayed({ startDiscoveryWithRetry(promise, 0, true) }, 900L)
                    } else {
                        promise.reject("ERROR", "Discovery failed: $reason (${reasonName(reason)})")
                    }
                }
            })
        } catch (e: Exception) {
            if (!channelReset && recreateChannel()) {
                mainHandler.postDelayed({ startDiscoveryWithRetry(promise, 0, true) }, 900L)
            } else {
                promise.reject("ERROR", e.message)
            }
        }
    }

    @ReactMethod
    fun stopDiscovery(promise: Promise) {
        val manager = wifiP2pManager
        val currentChannel = channel
        if (manager == null || currentChannel == null) {
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }
        try {
            manager.stopPeerDiscovery(currentChannel, object : ActionListener {
                override fun onSuccess() {
                    discoveryActive = false
                    promise.resolve("Discovery stopped")
                }
                override fun onFailure(reason: Int) { promise.reject("ERROR", "Stop discovery failed: $reason (${reasonName(reason)})") }
            })
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
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

    private fun armConnectionAttemptWatchdog(epoch: Long) {
        mainHandler.postDelayed({
            if (connectionGeneration != epoch || !connectionInProgress || groupActive) return@postDelayed
            connectionInProgress = false
            sendEvent("WIFI_P2P_CONNECTION_ATTEMPT_TIMEOUT", Arguments.createMap().apply {
                putDouble("connectionEpoch", epoch.toDouble())
            })
            if (canRefreshPresence(presenceGeneration)) {
                scheduleActivePresenceRefresh(presenceGeneration, 600L)
            }
        }, CONNECTION_ATTEMPT_WATCHDOG_MS)
    }

    private fun invalidateConnectionAttempt(epoch: Long) {
        if (epoch != connectionGeneration) return
        connectionInProgress = false
        // The watchdog and any callback/broadcast already queued for this
        // attempt must fail their generation guard after a synchronous error.
        connectionGeneration++
    }

    @ReactMethod
    fun createGroup(promise: Promise) {
        var attemptEpoch: Long? = null
        try {
            if (!ensureChannel()) {
                promise.reject("ERROR", "Wi-Fi Direct not initialized")
                return
            }
            val manager = wifiP2pManager ?: run {
                promise.reject("ERROR", "Wi-Fi Direct not initialized")
                return
            }
            val currentChannel = channel ?: run {
                promise.reject("ERROR", "Wi-Fi Direct not initialized")
                return
            }

            connectionGeneration++
            val epoch = connectionGeneration
            attemptEpoch = epoch
            connectionInProgress = true
            armConnectionAttemptWatchdog(epoch)
            manager.createGroup(currentChannel, object : ActionListener {
                override fun onSuccess() {
                    val started = epoch == connectionGeneration && currentChannel === channel
                    if (!started) invalidateConnectionAttempt(epoch)
                    promise.resolve(Arguments.createMap().apply {
                        putBoolean("started", started)
                        putDouble("connectionEpoch", epoch.toDouble())
                    })
                }
                override fun onFailure(reason: Int) {
                    invalidateConnectionAttempt(epoch)
                    promise.reject("ERROR", "Create group failed: $reason (${reasonName(reason)})")
                }
            })
        } catch (e: Exception) {
            attemptEpoch?.let { invalidateConnectionAttempt(it) }
            promise.reject("ERROR", e.message ?: "Failed to create Wi-Fi Direct group", e)
        }
    }

    @ReactMethod
    fun connectToPeer(deviceAddress: String, promise: Promise) {
        var attemptEpoch: Long? = null
        try {
            if (!ensureChannel()) {
                promise.reject("ERROR", "Wi-Fi Direct not initialized")
                return
            }
            val manager = wifiP2pManager ?: run {
                promise.reject("ERROR", "Wi-Fi Direct not initialized")
                return
            }
            val currentChannel = channel ?: run {
                promise.reject("ERROR", "Wi-Fi Direct not initialized")
                return
            }

            val config = WifiP2pConfig().apply { this.deviceAddress = deviceAddress }
            connectionGeneration++
            val epoch = connectionGeneration
            attemptEpoch = epoch
            connectionInProgress = true
            armConnectionAttemptWatchdog(epoch)
            manager.connect(currentChannel, config, object : ActionListener {
                override fun onSuccess() {
                    val started = epoch == connectionGeneration && currentChannel === channel
                    if (!started) invalidateConnectionAttempt(epoch)
                    promise.resolve(Arguments.createMap().apply {
                        putBoolean("started", started)
                        putDouble("connectionEpoch", epoch.toDouble())
                    })
                }
                override fun onFailure(reason: Int) {
                    invalidateConnectionAttempt(epoch)
                    promise.reject("ERROR", "Connection failed: $reason (${reasonName(reason)})")
                }
            })
        } catch (e: Exception) {
            attemptEpoch?.let { invalidateConnectionAttempt(it) }
            promise.reject("ERROR", e.message ?: "Failed to connect Wi-Fi Direct peer", e)
        }
    }

    @ReactMethod
    fun cancelConnect(promise: Promise) {
        connectionGeneration++
        connectionInProgress = false
        try {
            wifiP2pManager?.cancelConnect(channel, object : ActionListener {
                override fun onSuccess() { promise.resolve(true) }
                override fun onFailure(reason: Int) { promise.resolve(false) }
            }) ?: promise.resolve(false)
        } catch (_: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun disconnect(promise: Promise) {
        connectionGeneration++
        connectionInProgress = false
        wifiP2pManager?.removeGroup(channel, object : ActionListener {
            override fun onSuccess() {
                groupActive = false
                promise.resolve("Disconnected")
            }
            override fun onFailure(reason: Int) { promise.reject("ERROR", "Disconnect failed: $reason (${reasonName(reason)})") }
        }) ?: promise.reject("ERROR", "Wi-Fi Direct not initialized")
    }

    @ReactMethod
    fun cleanupConnection(timeoutMs: Double, promise: Promise) {
        connectionGeneration++
        connectionInProgress = false
        cleanupInProgress = true
        if (!ensureChannel()) {
            cleanupInProgress = false
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }
        val manager = wifiP2pManager ?: run {
            cleanupInProgress = false
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }
        val operationChannel = channel ?: run {
            cleanupInProgress = false
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

        fun withinDeadline(): Boolean = SystemClock.elapsedRealtime() - startedAt < timeout

        fun finish(clean: Boolean, timedOut: Boolean, reinitialized: Boolean) {
            if (settled) return
            settled = true
            cleanupInProgress = false
            if (clean) groupActive = false
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
                                // Empty/clean is success, not a reason to throw
                                // the framework back into a cold P2P state.
                                finish(clean = true, timedOut = false, reinitialized = false)
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
                } catch (_: Exception) {
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
                                mainHandler.postDelayed({ clearRequestsThenCancel(attempt + 1) }, 350L * (attempt + 1))
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
                            discoveryActive = false
                            mainHandler.postDelayed({ clearRequestsThenCancel(0) }, 350L)
                        }
                        override fun onFailure(reason: Int) {
                            lastFailure = reason
                            if (reason == BUSY && attempt < 4 && withinDeadline()) {
                                mainHandler.postDelayed({ stopDiscoveryThenClear(attempt + 1) }, 350L * (attempt + 1))
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
        val currentChannel = channel
        if (manager == null || currentChannel == null) {
            promise.reject("ERROR", "Wi-Fi Direct not initialized")
            return
        }
        manager.requestConnectionInfo(currentChannel) { info: WifiP2pInfo ->
            groupActive = info.groupFormed
            if (info.groupFormed) connectionInProgress = false
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
        val manager = wifiP2pManager ?: return
        val currentChannel = channel ?: return
        try {
            manager.requestPeers(currentChannel) { peers ->
                if (currentChannel !== channel) return@requestPeers
                sendEvent("PEERS_UPDATED", Arguments.createMap().apply {
                    putArray("peers", peersArray(peers?.deviceList ?: emptyList()))
                })
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
                        val enabled = state == WIFI_P2P_STATE_ENABLED
                        sendEvent("WIFI_P2P_STATE_CHANGED", Arguments.createMap().apply { putBoolean("enabled", enabled) })
                        if (!enabled) {
                            resetChannelScopedServiceState()
                        } else if (desiredDeviceLabel != null && desiredDeviceId != null) {
                            if (ensureChannel()) restoreDesiredAdvertising(advertisingGeneration, 0)
                        }
                    }

                    WIFI_P2P_DISCOVERY_CHANGED_ACTION -> {
                        val state = intent.getIntExtra(EXTRA_DISCOVERY_STATE, WIFI_P2P_DISCOVERY_STOPPED)
                        discoveryActive = state == WIFI_P2P_DISCOVERY_STARTED
                        sendEvent("WIFI_P2P_DISCOVERY_CHANGED", Arguments.createMap().apply {
                            putBoolean("active", discoveryActive)
                            putInt("state", state)
                        })
                        if (!discoveryActive && canRefreshPresence(presenceGeneration)) {
                            scheduleActivePresenceRefresh(presenceGeneration, 1_200L)
                        }
                    }

                    WIFI_P2P_PEERS_CHANGED_ACTION -> emitCurrentPeers()

                    WIFI_P2P_CONNECTION_CHANGED_ACTION -> {
                        val eventEpoch = connectionGeneration
                        val connectionWasInProgress = connectionInProgress
                        val hadActiveGroup = groupActive
                        val manager = wifiP2pManager ?: return
                        val currentChannel = channel ?: return
                        manager.requestConnectionInfo(currentChannel) { info ->
                            if (currentChannel !== channel || !isCurrentConnectionEpoch(eventEpoch, connectionGeneration)) {
                                return@requestConnectionInfo
                            }
                            groupActive = info.groupFormed
                            if (info.groupFormed) {
                                connectionInProgress = false
                                val ip = info.groupOwnerAddress?.hostAddress
                                if (info.isGroupOwner || ip != null) emitPeerConnected(info, ip, eventEpoch)
                            } else if (connectionWasInProgress) {
                                // A stale groupFormed=false broadcast from the previous cleanup can
                                // arrive after a new connect() has started. Keep the attempt protected;
                                // the JS timeout/native watchdog remains the bounded failure authority.
                                emitCurrentPeers()
                            } else if (hadActiveGroup) {
                                connectionInProgress = false
                                connectionGeneration++
                                emitCurrentPeers()
                                sendEvent("PEER_DISCONNECTED", Arguments.createMap().apply {
                                    putDouble("connectionEpoch", eventEpoch.toDouble())
                                })
                                if (canRefreshPresence(presenceGeneration)) {
                                    scheduleActivePresenceRefresh(presenceGeneration, 600L)
                                }
                            } else {
                                // Ignore idle false -> false broadcasts. Some OEMs
                                // deliver these after cleanup has already resolved.
                                emitCurrentPeers()
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
                if (currentChannel !== channel || epoch != connectionGeneration) return@requestGroupInfo
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
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(name, params)
    }

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        presenceGeneration++
        presenceScheduleToken++
        recoveryGeneration++
        receiver?.let { try { reactApplicationContext.unregisterReceiver(it) } catch (_: Exception) {} }
        receiver = null
        isReceiverRegistered = false
    }
}
