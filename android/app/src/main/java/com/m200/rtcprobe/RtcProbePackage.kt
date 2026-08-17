package com.m200.rtcprobe

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class RtcProbePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext) =
        listOf(RtcProbeModule(reactContext))
    override fun createViewManagers(reactContext: ReactApplicationContext) = emptyList<ViewManager<*, *>>()
}
