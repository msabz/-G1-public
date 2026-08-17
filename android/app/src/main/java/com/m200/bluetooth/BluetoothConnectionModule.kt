package com.m200.bluetooth

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.IOException
import java.util.UUID
import kotlin.concurrent.thread

// UUID ثابت خاص بتطبيق M200 - يجب أن يتطابق بين الطرفين
private val M200_UUID: UUID = UUID.fromString("8ce255c0-200a-11e0-ac64-0800200c9a66")

class BluetoothConnectionModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val adapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private var serverSocket: BluetoothServerSocket? = null
    private var activeSocket: BluetoothSocket? = null
    private var readThread: Thread? = null
    private var acceptThread: Thread? = null
    private var receiver: BroadcastReceiver? = null
    private var isReceiverRegistered = false

    override fun getName() = "BluetoothConnectionModule"

    @ReactMethod
    fun isSupported(promise: Promise) {
        promise.resolve(adapter != null)
    }

    @ReactMethod
    fun isEnabled(promise: Promise) {
        promise.resolve(adapter?.isEnabled == true)
    }

    @ReactMethod
    fun requestEnable(promise: Promise) {
        try {
            val intent = Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)
            intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
            reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun startDiscovery(promise: Promise) {
        registerReceiver()
        val started = adapter?.startDiscovery() ?: false
        promise.resolve(started)
    }

    @ReactMethod
    fun stopDiscovery(promise: Promise) {
        adapter?.cancelDiscovery()
        promise.resolve(true)
    }

    @ReactMethod
    fun getBondedDevices(promise: Promise) {
        val arr = Arguments.createArray()
        adapter?.bondedDevices?.forEach { d ->
            arr.pushMap(Arguments.createMap().apply {
                putString("name", d.name ?: "جهاز غير معروف")
                putString("address", d.address)
            })
        }
        promise.resolve(arr)
    }

    @ReactMethod
    fun startListening(promise: Promise) {
        try {
            adapter?.cancelDiscovery()
            serverSocket = adapter?.listenUsingInsecureRfcommWithServiceRecord("M200Chat", M200_UUID)
            acceptThread = thread(start = true) {
                try {
                    val socket = serverSocket?.accept()
                    if (socket != null) {
                        activeSocket = socket
                        try { serverSocket?.close() } catch (_: Exception) {}
                        startReading(socket)
                        sendEvent("BT_CONNECTED", Arguments.createMap().apply {
                            putString("deviceName", socket.remoteDevice?.name ?: "الطرف الآخر")
                        })
                    }
                } catch (e: IOException) {
                    sendEvent("BT_ERROR", Arguments.createMap().apply { putString("message", e.message) })
                }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun connectToDevice(address: String, promise: Promise) {
        thread(start = true) {
            try {
                adapter?.cancelDiscovery()
                val device: BluetoothDevice = adapter?.getRemoteDevice(address)
                    ?: run { promise.reject("ERROR", "جهاز غير موجود"); return@thread }
                val socket = device.createInsecureRfcommSocketToServiceRecord(M200_UUID)
                socket.connect()
                activeSocket = socket
                startReading(socket)
                reactApplicationContext.runOnUiQueueThread {
                    promise.resolve(true)
                }
                sendEvent("BT_CONNECTED", Arguments.createMap().apply {
                    putString("deviceName", device.name ?: "الطرف الآخر")
                })
            } catch (e: IOException) {
                reactApplicationContext.runOnUiQueueThread {
                    promise.reject("ERROR", "فشل الاتصال: ${e.message}")
                }
            }
        }
    }

    private fun startReading(socket: BluetoothSocket) {
        readThread = thread(start = true) {
            val buffer = ByteArray(4096)
            val input = socket.inputStream
            val sb = StringBuilder()
            try {
                while (true) {
                    val bytes = input.read(buffer)
                    if (bytes == -1) break
                    sb.append(String(buffer, 0, bytes, Charsets.UTF_8))
                    var idx: Int
                    while (sb.indexOf("\n").also { idx = it } >= 0) {
                        val line = sb.substring(0, idx)
                        sb.delete(0, idx + 1)
                        if (line.isNotBlank()) {
                            sendEvent("BT_MESSAGE", Arguments.createMap().apply { putString("text", line) })
                        }
                    }
                }
                sendEvent("BT_DISCONNECTED", Arguments.createMap())
            } catch (e: IOException) {
                sendEvent("BT_DISCONNECTED", Arguments.createMap())
            }
        }
    }

    @ReactMethod
    fun sendMessage(text: String, promise: Promise) {
        try {
            activeSocket?.outputStream?.write((text + "\n").toByteArray(Charsets.UTF_8))
            activeSocket?.outputStream?.flush()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun disconnect(promise: Promise) {
        try {
            activeSocket?.close()
            serverSocket?.close()
        } catch (_: Exception) {}
        activeSocket = null
        serverSocket = null
        promise.resolve(true)
    }

    private fun registerReceiver() {
        if (isReceiverRegistered) return
        val filter = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_FOUND)
            addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
        }
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                when (intent.action) {
                    BluetoothDevice.ACTION_FOUND -> {
                        val device: BluetoothDevice? = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                        if (device != null) {
                            sendEvent("BT_DEVICE_FOUND", Arguments.createMap().apply {
                                putString("name", device.name ?: "جهاز غير معروف")
                                putString("address", device.address)
                            })
                        }
                    }
                    BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> {
                        sendEvent("BT_DISCOVERY_FINISHED", Arguments.createMap())
                    }
                }
            }
        }
        reactApplicationContext.registerReceiver(receiver, filter)
        isReceiverRegistered = true
    }

    private fun sendEvent(name: String, params: WritableMap) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(name, params)
    }

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        receiver?.let { try { reactApplicationContext.unregisterReceiver(it) } catch (_: Exception) {} }
        isReceiverRegistered = false
        try { activeSocket?.close() } catch (_: Exception) {}
        try { serverSocket?.close() } catch (_: Exception) {}
    }
}
