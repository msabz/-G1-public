package com.m200.service

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class ServicePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext) =
        listOf(
            ServiceModule(reactContext),
            StorageModule(reactContext),
            CallNotificationModule(reactContext),
        )

    override fun createViewManagers(reactContext: ReactApplicationContext) = emptyList<ViewManager<*, *>>()
}
