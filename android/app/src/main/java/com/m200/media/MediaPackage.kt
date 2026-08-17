package com.m200.media

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class MediaPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext) =
        // AudioStreamModule انحذف: WebRTC صارت المصدر الوحيد للصوت،
        // وتوجيه الصوت انتقل لـ AudioSessionManager
        listOf(CameraStreamModule(reactContext), AudioClipModule(reactContext), RingtoneModule(reactContext))
    override fun createViewManagers(reactContext: ReactApplicationContext) = emptyList<ViewManager<*, *>>()
}
