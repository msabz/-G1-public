package com.m200.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.IOException
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min

private val G1_BLUETOOTH_UUID: UUID = UUID.fromString("8ce255c0-200a-11e0-ac64-0800200c9a66")
private const val G1_BLUETOOTH_SERVICE = "G1 Secure Chat"
private const val DEFAULT_DISCOVERY_TIMEOUT_MS = 12_000L
private const val MAX_DISCOVERY_TIMEOUT_MS = 30_000L
private const val MIN_CONNECT_TIMEOUT_MS = 1_000L
private const val MAX_CONNECT_TIMEOUT_MS = 30_000L
private const val HANDSHAKE_TIMEOUT_MS = 6_000L

/**
 * Authenticated Bluetooth Classic/RFCOMM transport for G1.
 *
 * Public compatibility methods (`startDiscovery`, `startListening`,
 * `connectToDevice`, `sendMessage`, `disconnect`) are retained for App.js.
 * The richer methods/events are consumed by BluetoothTransportAdapter and are
 * intentionally independent of the LAN/Wi-Fi Direct control plane.
 */
@SuppressLint("MissingPermission")
class BluetoothConnectionModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    private data class ConnectOptions(
        val maxAttempts: Int = 3,
        val connectTimeoutMs: Long = 8_000L,
        val retryDelayMs: Long = 600L,
        val autoReconnect: Boolean = true,
        val maxReconnectAttempts: Int = 3,
        val reconnectBaseDelayMs: Long = 700L,
    )

    private data class ActiveConnection(
        val socket: BluetoothSocket,
        val input: DataInputStream,
        val output: DataOutputStream,
        val peerAddress: String,
        val peerName: String,
        val peerNodeId: String,
        val connectionId: String,
        val initiatorNodeId: String,
        val sessionId: String,
        val locallyInitiated: Boolean,
        val activatedAtMs: Long,
        val options: ConnectOptions,
        val reconnected: Boolean,
    ) {
        val outputLock = Any()
        val receivedSequence = AtomicLong(0)

        fun rank() = BluetoothConnectionArbitrator.ConnectionRank(
            peerNodeId = peerNodeId,
            connectionId = connectionId,
            initiatorNodeId = initiatorNodeId,
            activatedAtMs = activatedAtMs,
        )
    }

    private val adapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private val stateLock = Any()
    private val ioExecutor = Executors.newCachedThreadPool { task ->
        Thread(task, "G1-Bluetooth-IO").apply { isDaemon = true }
    }
    private val scheduler = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "G1-Bluetooth-Timer").apply { isDaemon = true }
    }
    private val operationGeneration = AtomicLong(0)
    private val connectingSockets = linkedSetOf<BluetoothSocket>()
    private val discoveredAddresses = linkedSetOf<String>()

    @Volatile private var activeConnection: ActiveConnection? = null
    @Volatile private var serverSocket: BluetoothServerSocket? = null
    @Volatile private var listenerRequested = false
    @Volatile private var receiver: BroadcastReceiver? = null
    @Volatile private var receiverRegistered = false
    @Volatile private var deliberateDisconnect = false
    @Volatile private var reconnecting = false
    @Volatile private var pendingConnectToken: Long? = null
    @Volatile private var pendingConnectAddress: String? = null
    @Volatile private var discoveryStopFuture: ScheduledFuture<*>? = null

    private val localNodeId: String by lazy {
        val preferences = reactContext.getSharedPreferences("g1_bluetooth", Context.MODE_PRIVATE)
        val existing = preferences.getString("node_id", null)
        try {
            if (existing != null) UUID.fromString(existing).toString() else throw IllegalArgumentException()
        } catch (_: IllegalArgumentException) {
            UUID.randomUUID().toString().also { generated ->
                preferences.edit().putString("node_id", generated).apply()
            }
        }
    }

    override fun getName() = "BluetoothConnectionModule"

    override fun getConstants(): Map<String, Any> = mapOf(
        "protocolVersion" to BluetoothProtocol.VERSION,
        "maxMessageBytes" to BluetoothProtocol.MAX_MESSAGE_BYTES,
        "security" to "AUTHENTICATED_RFCOMM",
    )

    @ReactMethod fun addListener(eventName: String) = Unit
    @ReactMethod fun removeListeners(count: Double) = Unit

    @ReactMethod
    fun isSupported(promise: Promise) = promise.resolve(adapter != null)

    @ReactMethod
    fun isEnabled(promise: Promise) = promise.resolve(adapter?.isEnabled == true)

    @ReactMethod
    fun requestEnable(promise: Promise) {
        try {
            val intent = Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("BT_ENABLE_FAILED", e.message, e)
        }
    }

    /** Makes first-time pairing possible; the caller remains in control of the system dialog. */
    @ReactMethod
    fun requestDiscoverable(durationSeconds: Double, promise: Promise) {
        try {
            val duration = durationSeconds.toInt().coerceIn(30, 300)
            val intent = Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE).apply {
                putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, duration)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("BT_DISCOVERABLE_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun startDiscovery(promise: Promise) {
        startDiscoveryInternal(DEFAULT_DISCOVERY_TIMEOUT_MS, promise)
    }

    @ReactMethod
    fun startDiscoveryWithTimeout(timeoutMs: Double, promise: Promise) {
        startDiscoveryInternal(timeoutMs.toLong().coerceIn(1_000L, MAX_DISCOVERY_TIMEOUT_MS), promise)
    }

    private fun startDiscoveryInternal(timeoutMs: Long, promise: Promise) {
        try {
            val bluetooth = requireAdapter()
            if (!bluetooth.isEnabled) throw IOException("Bluetooth is disabled")
            registerDiscoveryReceiver()
            bluetooth.cancelDiscovery()
            synchronized(discoveredAddresses) { discoveredAddresses.clear() }

            bluetooth.bondedDevices.forEach { emitDiscoveredDevice(it, null, "BONDED") }

            val started = bluetooth.startDiscovery()
            if (!started) throw IOException("Android refused to start Bluetooth discovery")
            emitState("DISCOVERING") { putDouble("timeoutMs", timeoutMs.toDouble()) }
            discoveryStopFuture?.cancel(false)
            discoveryStopFuture = scheduler.schedule({
                try { bluetooth.cancelDiscovery() } catch (_: Exception) {}
            }, timeoutMs, TimeUnit.MILLISECONDS)
            promise.resolve(true)
        } catch (e: Exception) {
            emitError("DISCOVERY_FAILED", e.message ?: "Bluetooth discovery failed", true)
            promise.reject("BT_DISCOVERY_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun stopDiscovery(promise: Promise) {
        discoveryStopFuture?.cancel(false)
        discoveryStopFuture = null
        try { adapter?.cancelDiscovery() } catch (_: Exception) {}
        promise.resolve(true)
    }

    @ReactMethod
    fun getBondedDevices(promise: Promise) {
        try {
            val devices = Arguments.createArray()
            requireAdapter().bondedDevices.forEach { device -> devices.pushMap(deviceMap(device, null, "BONDED")) }
            promise.resolve(devices)
        } catch (e: Exception) {
            promise.reject("BT_BONDED_DEVICES_FAILED", e.message, e)
        }
    }

    /** Starts a persistent secure accept loop; it remains available across chat sessions. */
    @ReactMethod
    fun startListening(promise: Promise) {
        try {
            val bluetooth = requireAdapter()
            if (!bluetooth.isEnabled) throw IOException("Bluetooth is disabled")
            synchronized(stateLock) {
                if (listenerRequested && serverSocket != null) {
                    promise.resolve(true)
                    return
                }
                listenerRequested = true
                serverSocket = bluetooth.listenUsingRfcommWithServiceRecord(
                    G1_BLUETOOTH_SERVICE,
                    G1_BLUETOOTH_UUID,
                )
            }
            ioExecutor.execute(::acceptLoop)
            emit("BT_LISTENING", Arguments.createMap().apply { putBoolean("active", true) })
            if (activeConnection == null) emitState("LISTENING")
            promise.resolve(true)
        } catch (e: Exception) {
            listenerRequested = false
            emitError("LISTEN_FAILED", e.message ?: "Bluetooth listener failed", true)
            promise.reject("BT_LISTEN_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun stopListening(promise: Promise) {
        listenerRequested = false
        val socket = synchronized(stateLock) {
            serverSocket.also { serverSocket = null }
        }
        closeQuietly(socket)
        emit("BT_LISTENING", Arguments.createMap().apply { putBoolean("active", false) })
        if (activeConnection == null) emitState("IDLE")
        promise.resolve(true)
    }

    private fun acceptLoop() {
        while (listenerRequested) {
            val listeningSocket = serverSocket ?: break
            try {
                val socket = listeningSocket.accept()
                ioExecutor.execute { handleAcceptedSocket(socket) }
            } catch (e: IOException) {
                if (listenerRequested) {
                    emitError("LISTEN_INTERRUPTED", e.message ?: "Bluetooth listener interrupted", true)
                }
                break
            } catch (e: SecurityException) {
                if (listenerRequested) emitError("CONNECT_PERMISSION_REQUIRED", e.message ?: "Bluetooth permission required", false)
                break
            }
        }
        val stoppedUnexpectedly = synchronized(stateLock) {
            val interrupted = listenerRequested
            closeQuietly(serverSocket)
            serverSocket = null
            if (interrupted) listenerRequested = false
            interrupted
        }
        if (stoppedUnexpectedly) {
            emit("BT_LISTENING", Arguments.createMap().apply { putBoolean("active", false) })
            if (activeConnection == null) emitState("IDLE")
        }
    }

    private fun handleAcceptedSocket(socket: BluetoothSocket) {
        synchronized(stateLock) { connectingSockets.add(socket) }
        val deadline = scheduleSocketDeadline(socket, HANDSHAKE_TIMEOUT_MS)
        try {
            requireBonded(socket.remoteDevice)
            val candidate = negotiate(socket, locallyInitiated = false, ConnectOptions(), reconnected = reconnecting)
            deadline.cancel(false)
            activateCandidate(candidate)
        } catch (e: Exception) {
            closeQuietly(socket)
            if (e !is CancellationException) {
                emitError("INCOMING_CONNECTION_REJECTED", e.message ?: "Incoming Bluetooth connection rejected", true)
            }
        } finally {
            deadline.cancel(false)
            synchronized(stateLock) { connectingSockets.remove(socket) }
        }
    }

    @ReactMethod
    fun connectToDevice(address: String, promise: Promise) {
        connectInternal(address, ConnectOptions(), promise)
    }

    @ReactMethod
    fun connect(address: String, options: ReadableMap, promise: Promise) {
        connectInternal(address, parseConnectOptions(options), promise)
    }

    private fun connectInternal(address: String, options: ConnectOptions, promise: Promise) {
        val bluetooth = try {
            requireAdapter().also {
                if (!it.isEnabled) throw IOException("Bluetooth is disabled")
                if (!BluetoothAdapter.checkBluetoothAddress(address)) throw IOException("Invalid Bluetooth address")
            }
        } catch (e: Exception) {
            promise.reject("BT_CONNECT_INVALID", e.message, e)
            return
        }

        val normalizedAddress = address.uppercase()
        synchronized(stateLock) {
            val active = activeConnection
            if (active != null) {
                if (active.peerAddress.equals(normalizedAddress, ignoreCase = true)) {
                    promise.resolve(connectionMap(active).apply { putBoolean("reused", true) })
                } else {
                    promise.reject("BT_BUSY", "A Bluetooth peer is already connected")
                }
                return
            }
            if (pendingConnectToken != null) {
                promise.reject("BT_CONNECT_IN_PROGRESS", "Another Bluetooth connection attempt is active")
                return
            }
        }

        try { bluetooth.cancelDiscovery() } catch (_: Exception) {}
        deliberateDisconnect = false
        reconnecting = false
        val token = operationGeneration.incrementAndGet()
        pendingConnectToken = token
        pendingConnectAddress = normalizedAddress
        emitState("CONNECTING") {
            putString("address", normalizedAddress)
            putInt("maxAttempts", options.maxAttempts)
        }

        ioExecutor.execute {
            var lastError: Exception = IOException("Bluetooth connection failed")
            for (attempt in 1..options.maxAttempts) {
                if (!isOperationCurrent(token)) {
                    rejectPromise(promise, "BT_CONNECT_CANCELLED", "Bluetooth connection was cancelled", CancellationException())
                    clearPendingToken(token)
                    return@execute
                }
                emit("BT_CONNECTING", Arguments.createMap().apply {
                    putString("address", normalizedAddress)
                    putInt("attempt", attempt)
                    putInt("maxAttempts", options.maxAttempts)
                })
                try {
                    val connection = dialOnce(normalizedAddress, options, token, reconnected = false)
                    clearPendingToken(token)
                    resolvePromise(promise, connectionMap(connection))
                    return@execute
                } catch (e: Exception) {
                    lastError = e
                    val acceptedIncoming = activeConnection
                    if (acceptedIncoming?.peerAddress?.equals(normalizedAddress, ignoreCase = true) == true) {
                        clearPendingToken(token)
                        resolvePromise(promise, connectionMap(acceptedIncoming).apply { putBoolean("reused", true) })
                        return@execute
                    }
                    if (!isOperationCurrent(token)) {
                        rejectPromise(promise, "BT_CONNECT_CANCELLED", "Bluetooth connection was cancelled", e)
                        clearPendingToken(token)
                        return@execute
                    }
                    if (attempt < options.maxAttempts) {
                        sleepWhileCurrent(options.retryDelayMs * attempt, token)
                    }
                }
            }

            clearPendingToken(token)
            if (activeConnection == null) emitState(if (listenerRequested) "LISTENING" else "IDLE")
            emitError("CONNECT_FAILED", lastError.message ?: "Bluetooth connection failed", true)
            rejectPromise(promise, "BT_CONNECT_FAILED", lastError.message ?: "Bluetooth connection failed", lastError)
        }
    }

    @Throws(Exception::class)
    private fun dialOnce(
        address: String,
        options: ConnectOptions,
        token: Long,
        reconnected: Boolean,
    ): ActiveConnection {
        if (!isOperationCurrent(token)) throw CancellationException("Bluetooth operation cancelled")
        val bluetooth = requireAdapter()
        try { bluetooth.cancelDiscovery() } catch (_: Exception) {}
        val device = bluetooth.getRemoteDevice(address)
        val socket = device.createRfcommSocketToServiceRecord(G1_BLUETOOTH_UUID)
        synchronized(stateLock) { connectingSockets.add(socket) }
        val connectDeadline = scheduleSocketDeadline(socket, options.connectTimeoutMs)
        var handshakeDeadline: ScheduledFuture<*>? = null
        try {
            socket.connect()
            connectDeadline.cancel(false)
            if (!isOperationCurrent(token)) throw CancellationException("Bluetooth operation cancelled")
            requireBonded(device)
            handshakeDeadline = scheduleSocketDeadline(socket, HANDSHAKE_TIMEOUT_MS)
            val candidate = negotiate(socket, locallyInitiated = true, options, reconnected)
            handshakeDeadline.cancel(false)
            return activateCandidate(candidate)
        } catch (e: Exception) {
            closeQuietly(socket)
            throw e
        } finally {
            connectDeadline.cancel(false)
            handshakeDeadline?.cancel(false)
            synchronized(stateLock) { connectingSockets.remove(socket) }
        }
    }

    @Throws(IOException::class)
    private fun negotiate(
        socket: BluetoothSocket,
        locallyInitiated: Boolean,
        options: ConnectOptions,
        reconnected: Boolean,
    ): ActiveConnection {
        val input = DataInputStream(BufferedInputStream(socket.inputStream))
        val output = DataOutputStream(BufferedOutputStream(socket.outputStream))
        val connectionId: String
        val remoteHello: BluetoothProtocol.Hello

        if (locallyInitiated) {
            connectionId = UUID.randomUUID().toString()
            BluetoothProtocol.writeHello(output, BluetoothProtocol.ROLE_DIALER, localNodeId, connectionId)
            remoteHello = BluetoothProtocol.readHello(input)
            if (remoteHello.role != BluetoothProtocol.ROLE_ACCEPTOR || remoteHello.connectionId != connectionId) {
                throw IOException("Invalid Bluetooth handshake response")
            }
        } else {
            remoteHello = BluetoothProtocol.readHello(input)
            if (remoteHello.role != BluetoothProtocol.ROLE_DIALER) {
                throw IOException("Invalid incoming Bluetooth handshake")
            }
            connectionId = remoteHello.connectionId
            BluetoothProtocol.writeHello(output, BluetoothProtocol.ROLE_ACCEPTOR, localNodeId, connectionId)
        }

        if (remoteHello.nodeId == localNodeId) throw IOException("Refusing Bluetooth self-connection")
        val peerAddress = socket.remoteDevice.address.uppercase()
        val peerName = safeDeviceName(socket.remoteDevice)
        val initiatorNodeId = if (locallyInitiated) localNodeId else remoteHello.nodeId
        return ActiveConnection(
            socket = socket,
            input = input,
            output = output,
            peerAddress = peerAddress,
            peerName = peerName,
            peerNodeId = remoteHello.nodeId,
            connectionId = connectionId,
            initiatorNodeId = initiatorNodeId,
            sessionId = UUID.randomUUID().toString(),
            locallyInitiated = locallyInitiated,
            activatedAtMs = System.currentTimeMillis(),
            options = options,
            reconnected = reconnected,
        )
    }

    private fun activateCandidate(candidate: ActiveConnection): ActiveConnection {
        var replaced: ActiveConnection? = null
        val selected: ActiveConnection
        val installed: Boolean
        synchronized(stateLock) {
            val current = activeConnection
            val pendingAddress = pendingConnectAddress
            if (
                current == null &&
                pendingConnectToken != null &&
                pendingAddress != null &&
                !candidate.peerAddress.equals(pendingAddress, ignoreCase = true)
            ) {
                closeQuietly(candidate.socket)
                throw IOException("Another Bluetooth peer is already connecting")
            }
            val decision = BluetoothConnectionArbitrator.decide(
                active = current?.rank(),
                candidate = candidate.rank(),
                nowMs = System.currentTimeMillis(),
            )
            when (decision) {
                BluetoothConnectionArbitrator.Decision.ACCEPT -> {
                    activeConnection = candidate
                    selected = candidate
                    installed = true
                }
                BluetoothConnectionArbitrator.Decision.REPLACE_ACTIVE -> {
                    replaced = current
                    activeConnection = candidate
                    selected = candidate
                    installed = true
                }
                BluetoothConnectionArbitrator.Decision.REJECT_DUPLICATE -> {
                    selected = current ?: candidate
                    installed = false
                }
                BluetoothConnectionArbitrator.Decision.REJECT_BUSY -> {
                    closeQuietly(candidate.socket)
                    throw IOException("Another Bluetooth peer is already connected")
                }
            }
            if (installed) {
                deliberateDisconnect = false
                reconnecting = false
                pendingConnectToken = null
                pendingConnectAddress = null
            }
        }

        if (!installed) {
            closeQuietly(candidate.socket)
            return selected
        }

        closeQuietly(replaced?.socket)
        emitConnected(candidate, replaced != null)
        ioExecutor.execute { readLoop(candidate) }
        return candidate
    }

    private fun readLoop(connection: ActiveConnection) {
        var terminalReason = "Bluetooth peer closed the connection"
        try {
            while (activeConnection === connection) {
                val text = BluetoothProtocol.readMessage(connection.input)
                emit("BT_MESSAGE", Arguments.createMap().apply {
                    putString("text", text)
                    putString("sessionId", connection.sessionId)
                    putString("address", connection.peerAddress)
                    putDouble("sequence", connection.receivedSequence.incrementAndGet().toDouble())
                })
            }
        } catch (_: EOFException) {
            terminalReason = "Bluetooth peer closed the connection"
        } catch (e: IOException) {
            terminalReason = e.message ?: "Bluetooth connection was lost"
        } finally {
            handleConnectionTerminated(connection, terminalReason)
        }
    }

    @ReactMethod
    fun sendMessage(text: String, promise: Promise) {
        val connection = activeConnection
        if (connection == null) {
            promise.reject("BT_NOT_CONNECTED", "No active Bluetooth connection")
            return
        }
        ioExecutor.execute {
            try {
                synchronized(connection.outputLock) {
                    if (activeConnection !== connection) throw IOException("Bluetooth session changed before send")
                    BluetoothProtocol.writeMessage(connection.output, text)
                }
                resolvePromise(promise, true)
            } catch (e: Exception) {
                handleConnectionTerminated(connection, e.message ?: "Bluetooth send failed")
                rejectPromise(promise, "BT_SEND_FAILED", e.message ?: "Bluetooth send failed", e)
            }
        }
    }

    private fun handleConnectionTerminated(connection: ActiveConnection, reason: String) {
        val token: Long
        synchronized(stateLock) {
            if (activeConnection !== connection) return
            activeConnection = null
            closeQuietly(connection.socket)
            if (deliberateDisconnect || !connection.options.autoReconnect || connection.options.maxReconnectAttempts == 0) {
                emitFinalDisconnected(connection, reason, unexpected = !deliberateDisconnect, attempts = 0)
                return
            }
            reconnecting = true
            token = operationGeneration.incrementAndGet()
            pendingConnectToken = token
            pendingConnectAddress = connection.peerAddress
        }
        ioExecutor.execute { runReconnect(connection, reason, token) }
    }

    private fun runReconnect(previous: ActiveConnection, disconnectReason: String, token: Long) {
        var lastReason = disconnectReason
        val options = previous.options
        for (attempt in 1..options.maxReconnectAttempts) {
            val delayMs = min(options.reconnectBaseDelayMs * (1L shl (attempt - 1)), 4_000L)
            emit("BT_RECONNECTING", Arguments.createMap().apply {
                putString("address", previous.peerAddress)
                putString("deviceName", previous.peerName)
                putInt("attempt", attempt)
                putInt("maxAttempts", options.maxReconnectAttempts)
                putDouble("delayMs", delayMs.toDouble())
                putString("reason", disconnectReason)
            })
            emitState("RECONNECTING") {
                putString("address", previous.peerAddress)
                putInt("attempt", attempt)
                putInt("maxAttempts", options.maxReconnectAttempts)
            }
            if (!sleepWhileCurrent(delayMs, token)) return
            if (activeConnection != null) {
                clearPendingToken(token)
                reconnecting = false
                return
            }
            try {
                dialOnce(previous.peerAddress, options, token, reconnected = true)
                clearPendingToken(token)
                reconnecting = false
                return
            } catch (e: Exception) {
                lastReason = e.message ?: lastReason
                if (!isOperationCurrent(token)) return
            }
        }

        if (isOperationCurrent(token) && activeConnection == null) {
            clearPendingToken(token)
            reconnecting = false
            emitFinalDisconnected(
                previous,
                lastReason,
                unexpected = true,
                attempts = options.maxReconnectAttempts,
            )
        }
    }

    @ReactMethod
    fun cancelConnect(promise: Promise) {
        operationGeneration.incrementAndGet()
        reconnecting = false
        pendingConnectToken = null
        pendingConnectAddress = null
        val sockets = synchronized(stateLock) { connectingSockets.toList() }
        sockets.forEach(::closeQuietly)
        if (activeConnection == null) emitState(if (listenerRequested) "LISTENING" else "IDLE")
        emit("BT_CONNECT_CANCELLED", Arguments.createMap())
        promise.resolve(true)
    }

    @ReactMethod
    fun disconnect(promise: Promise) {
        deliberateDisconnect = true
        operationGeneration.incrementAndGet()
        reconnecting = false
        pendingConnectToken = null
        pendingConnectAddress = null
        val (connection, candidates) = synchronized(stateLock) {
            val current = activeConnection
            activeConnection = null
            current to connectingSockets.toList()
        }
        candidates.forEach(::closeQuietly)
        closeQuietly(connection?.socket)
        emitState(if (listenerRequested) "LISTENING" else "IDLE") {
            putBoolean("intentional", true)
            connection?.let { putString("previousSessionId", it.sessionId) }
        }
        promise.resolve(true)
    }

    @ReactMethod
    fun getConnectionState(promise: Promise) {
        val connection = activeConnection
        promise.resolve(Arguments.createMap().apply {
            putString("state", when {
                connection != null -> "CONNECTED"
                reconnecting -> "RECONNECTING"
                pendingConnectToken != null -> "CONNECTING"
                listenerRequested -> "LISTENING"
                else -> "IDLE"
            })
            putBoolean("connected", connection != null)
            putBoolean("listening", listenerRequested && serverSocket != null)
            putBoolean("discovering", adapter?.isDiscovering == true)
            putString("localNodeId", localNodeId)
            connection?.let {
                putString("address", it.peerAddress)
                putString("deviceName", it.peerName)
                putString("remoteNodeId", it.peerNodeId)
                putString("sessionId", it.sessionId)
                putString("security", "AUTHENTICATED_RFCOMM")
            }
        })
    }

    private fun emitConnected(connection: ActiveConnection, replacedDuplicate: Boolean) {
        val payload = connectionMap(connection).apply {
            putBoolean("replacedDuplicate", replacedDuplicate)
        }
        emitState("CONNECTED") {
            putString("address", connection.peerAddress)
            putString("deviceName", connection.peerName)
            putString("sessionId", connection.sessionId)
            putBoolean("reconnected", connection.reconnected)
        }
        emit("BT_CONNECTED", payload)
    }

    private fun emitFinalDisconnected(
        connection: ActiveConnection,
        reason: String,
        unexpected: Boolean,
        attempts: Int,
    ) {
        emitState(if (listenerRequested) "LISTENING" else "IDLE") {
            putBoolean("unexpected", unexpected)
            putString("reason", reason)
        }
        emit("BT_DISCONNECTED", Arguments.createMap().apply {
            putString("deviceName", connection.peerName)
            putString("address", connection.peerAddress)
            putString("remoteNodeId", connection.peerNodeId)
            putString("sessionId", connection.sessionId)
            putString("reason", reason)
            putBoolean("unexpected", unexpected)
            putBoolean("willReconnect", false)
            putInt("reconnectAttempts", attempts)
        })
    }

    private fun connectionMap(connection: ActiveConnection): WritableMap = Arguments.createMap().apply {
        putString("transport", "BLUETOOTH")
        putString("deviceName", connection.peerName)
        putString("address", connection.peerAddress)
        putString("remoteNodeId", connection.peerNodeId)
        putString("connectionId", connection.connectionId)
        putString("sessionId", connection.sessionId)
        putString("security", "AUTHENTICATED_RFCOMM")
        putInt("protocolVersion", BluetoothProtocol.VERSION)
        putBoolean("bonded", true)
        putBoolean("incoming", !connection.locallyInitiated)
        putBoolean("reconnected", connection.reconnected)
    }

    private fun registerDiscoveryReceiver() {
        if (receiverRegistered) return
        val filter = IntentFilter().apply {
            addAction(BluetoothAdapter.ACTION_DISCOVERY_STARTED)
            addAction(BluetoothDevice.ACTION_FOUND)
            addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
        }
        val discoveryReceiver = object : BroadcastReceiver() {
            @Suppress("DEPRECATION")
            override fun onReceive(context: Context, intent: Intent) {
                when (intent.action) {
                    BluetoothAdapter.ACTION_DISCOVERY_STARTED -> emit("BT_DISCOVERY_STARTED", Arguments.createMap())
                    BluetoothDevice.ACTION_FOUND -> {
                        val device = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
                        val rssi = if (intent.hasExtra(BluetoothDevice.EXTRA_RSSI)) {
                            intent.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE).toInt()
                        } else null
                        if (device != null && device.type != BluetoothDevice.DEVICE_TYPE_LE) {
                            emitDiscoveredDevice(device, rssi, "SCAN")
                        }
                    }
                    BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> {
                        discoveryStopFuture?.cancel(false)
                        discoveryStopFuture = null
                        emit("BT_DISCOVERY_FINISHED", Arguments.createMap().apply {
                            synchronized(discoveredAddresses) { putInt("deviceCount", discoveredAddresses.size) }
                        })
                        if (activeConnection == null) emitState(if (listenerRequested) "LISTENING" else "IDLE")
                    }
                }
            }
        }
        ContextCompat.registerReceiver(
            reactContext,
            discoveryReceiver,
            filter,
            ContextCompat.RECEIVER_EXPORTED,
        )
        receiver = discoveryReceiver
        receiverRegistered = true
    }

    private fun emitDiscoveredDevice(device: BluetoothDevice, rssi: Int?, source: String) {
        val address = try { device.address?.uppercase() } catch (_: SecurityException) { null } ?: return
        val isNew = synchronized(discoveredAddresses) { discoveredAddresses.add(address) }
        if (!isNew && source != "SCAN") return
        emit("BT_DEVICE_FOUND", deviceMap(device, rssi, source))
    }

    private fun deviceMap(device: BluetoothDevice, rssi: Int?, source: String): WritableMap = Arguments.createMap().apply {
        putString("name", safeDeviceName(device))
        putString("address", try { device.address.uppercase() } catch (_: Exception) { "" })
        putString("source", source)
        putBoolean("bonded", try { device.bondState == BluetoothDevice.BOND_BONDED } catch (_: Exception) { false })
        putInt("deviceType", try { device.type } catch (_: Exception) { BluetoothDevice.DEVICE_TYPE_UNKNOWN })
        if (rssi != null) putInt("rssi", rssi)
    }

    private fun safeDeviceName(device: BluetoothDevice): String = try {
        device.name?.takeIf { it.isNotBlank() } ?: "Bluetooth Device"
    } catch (_: SecurityException) {
        "Bluetooth Device"
    }

    @Throws(IOException::class)
    private fun requireAdapter(): BluetoothAdapter = adapter ?: throw IOException("Bluetooth is not supported")

    @Throws(IOException::class)
    private fun requireBonded(device: BluetoothDevice) {
        if (device.bondState != BluetoothDevice.BOND_BONDED) {
            throw IOException("Secure Bluetooth connection requires Android pairing")
        }
    }

    private fun parseConnectOptions(options: ReadableMap): ConnectOptions = ConnectOptions(
        maxAttempts = readInt(options, "maxAttempts", 2).coerceIn(1, 5),
        connectTimeoutMs = readLong(options, "connectTimeoutMs", 3_000L).coerceIn(MIN_CONNECT_TIMEOUT_MS, MAX_CONNECT_TIMEOUT_MS),
        retryDelayMs = readLong(options, "retryDelayMs", 400L).coerceIn(0L, 5_000L),
        autoReconnect = readBoolean(options, "autoReconnect", true),
        maxReconnectAttempts = readInt(options, "maxReconnectAttempts", 3).coerceIn(0, 5),
        reconnectBaseDelayMs = readLong(options, "reconnectBaseDelayMs", 700L).coerceIn(100L, 5_000L),
    )

    private fun readInt(map: ReadableMap, key: String, fallback: Int): Int = try {
        if (map.hasKey(key) && !map.isNull(key)) map.getDouble(key).toInt() else fallback
    } catch (_: Exception) { fallback }

    private fun readLong(map: ReadableMap, key: String, fallback: Long): Long = try {
        if (map.hasKey(key) && !map.isNull(key)) map.getDouble(key).toLong() else fallback
    } catch (_: Exception) { fallback }

    private fun readBoolean(map: ReadableMap, key: String, fallback: Boolean): Boolean = try {
        if (map.hasKey(key) && !map.isNull(key)) map.getBoolean(key) else fallback
    } catch (_: Exception) { fallback }

    private fun scheduleSocketDeadline(socket: BluetoothSocket, timeoutMs: Long): ScheduledFuture<*> =
        scheduler.schedule({ closeQuietly(socket) }, timeoutMs, TimeUnit.MILLISECONDS)

    private fun isOperationCurrent(token: Long): Boolean =
        operationGeneration.get() == token && !deliberateDisconnect

    private fun clearPendingToken(token: Long) {
        synchronized(stateLock) {
            if (pendingConnectToken == token) pendingConnectToken = null
            if (pendingConnectToken == null) pendingConnectAddress = null
        }
    }

    private fun sleepWhileCurrent(delayMs: Long, token: Long): Boolean {
        var remaining = delayMs
        while (remaining > 0 && isOperationCurrent(token)) {
            val slice = min(remaining, 100L)
            try { Thread.sleep(slice) } catch (_: InterruptedException) { return false }
            remaining -= slice
        }
        return isOperationCurrent(token)
    }

    private fun emitState(state: String, details: WritableMap.() -> Unit = {}) {
        emit("BT_STATE_CHANGED", Arguments.createMap().apply {
            putString("state", state)
            putBoolean("connected", activeConnection != null)
            putBoolean("listening", listenerRequested && serverSocket != null)
            details()
        })
    }

    private fun emitError(code: String, message: String, recoverable: Boolean) {
        emit("BT_ERROR", Arguments.createMap().apply {
            putString("code", code)
            putString("message", message)
            putBoolean("recoverable", recoverable)
        })
    }

    private fun emit(name: String, params: WritableMap) {
        try {
            if (!reactContext.hasActiveCatalystInstance()) return
            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, params)
        } catch (_: Exception) {}
    }

    private fun resolvePromise(promise: Promise, value: Any?) {
        reactContext.runOnUiQueueThread {
            try { promise.resolve(value) } catch (_: Exception) {}
        }
    }

    private fun rejectPromise(promise: Promise, code: String, message: String, error: Throwable) {
        reactContext.runOnUiQueueThread {
            try { promise.reject(code, message, error) } catch (_: Exception) {}
        }
    }

    private fun closeQuietly(socket: BluetoothSocket?) {
        try { socket?.close() } catch (_: Exception) {}
    }

    private fun closeQuietly(socket: BluetoothServerSocket?) {
        try { socket?.close() } catch (_: Exception) {}
    }

    override fun onCatalystInstanceDestroy() {
        deliberateDisconnect = true
        listenerRequested = false
        operationGeneration.incrementAndGet()
        discoveryStopFuture?.cancel(false)
        try { adapter?.cancelDiscovery() } catch (_: Exception) {}
        receiver?.let { registered ->
            if (receiverRegistered) {
                try { reactContext.unregisterReceiver(registered) } catch (_: Exception) {}
            }
        }
        receiverRegistered = false
        receiver = null
        val (connection, candidates, listener) = synchronized(stateLock) {
            val current = activeConnection
            activeConnection = null
            Triple(current, connectingSockets.toList(), serverSocket.also { serverSocket = null })
        }
        closeQuietly(connection?.socket)
        candidates.forEach(::closeQuietly)
        closeQuietly(listener)
        ioExecutor.shutdownNow()
        scheduler.shutdownNow()
        super.onCatalystInstanceDestroy()
    }
}
