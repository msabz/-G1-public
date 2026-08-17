package com.m200

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.m200.directconnection.DirectConnectionPackage
import com.m200.bluetooth.BluetoothPackage
import com.m200.media.MediaPackage
import com.m200.filesharing.FilePackage
import com.m200.service.ServicePackage
import com.m200.rtcprobe.RtcProbePackage
import com.m200.audio.AudioPackage
import com.m200.lan.LanDiscoveryPackage

class MainApplication : Application(), ReactApplication {
    override val reactNativeHost: ReactNativeHost =
        object : DefaultReactNativeHost(this) {
            override fun getPackages(): List<ReactPackage> =
                PackageList(this).packages.apply {
                    add(DirectConnectionPackage())
                    add(BluetoothPackage())
                    add(MediaPackage())
                    add(FilePackage())
                    add(ServicePackage())
                    add(RtcProbePackage())
                    add(AudioPackage())
                    add(LanDiscoveryPackage())
                }
            override fun getJSMainModuleName(): String = "index"
            override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG
        }
    override val reactHost: ReactHost
        get() = getDefaultReactHost(this.applicationContext, reactNativeHost)
}
