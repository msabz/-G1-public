package com.m200.filesharing

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class FilePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext) =
        listOf(FilePickerModule(reactContext), FileTransferModule(reactContext), AppInstallerModule(reactContext))
    override fun createViewManagers(reactContext: ReactApplicationContext) = emptyList<ViewManager<*, *>>()
}
