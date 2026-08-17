package com.m200.bluetooth

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class BluetoothPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext) =
        listOf(BluetoothConnectionModule(reactContext))
    override fun createViewManagers(reactContext: ReactApplicationContext) = emptyList<ViewManager<*, *>>()
}
