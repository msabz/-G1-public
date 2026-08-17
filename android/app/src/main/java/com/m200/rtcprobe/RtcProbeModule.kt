package com.m200.rtcprobe

import com.facebook.react.bridge.*
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/**
 * فحص تشخيصي: هل تستطيع WebRTC الأصلية رؤية واجهة واي فاي مباشر
 * إذا هيّأناها نحن بإعدادات مخصّصة؟
 *
 * الفرضية:
 * مراقب الشبكة بأندرويد (NetworkMonitor) بيعتمد على ConnectivityManager،
 * وهاد ما بيعتبر واي فاي مباشر "شبكة" أصلاً — فWebRTC ما بتسمع فيها.
 * تعطيل المراقب (disableNetworkMonitor) بيخلي WebRTC تعدّ الواجهات
 * بنفسها من نظام التشغيل مباشرةً، وساعتها لازم تشوف p2p-wlan0-0.
 *
 * هالوحدة ما بتلمس مسار الصوت الشغّال إطلاقاً — بتفتح اتصالاً تجريبياً
 * معزولاً، بتجمع المرشّحات، بترجّع عناوينها، وبتسكّر.
 */
class RtcProbeModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "RtcProbeModule"

    // أقنعة أنواع الواجهات بـ WebRTC الأصلية
    private val ADAPTER_TYPE_CELLULAR = 4
    private val ADAPTER_TYPE_VPN = 8
    private val ADAPTER_TYPE_LOOPBACK = 16

    /**
     * disableMonitor: هل نعطّل مراقب الشبكة (هاي الفرضية الأساسية)
     * ignoreCellular: هل نتجاهل واجهة بيانات الهاتف
     */
    @ReactMethod
    fun probeCandidates(disableMonitor: Boolean, ignoreCellular: Boolean, promise: Promise) {
        val collected = Arguments.createArray()
        var factory: PeerConnectionFactory? = null
        var pc: PeerConnection? = null
        var settled = false

        fun finish(note: String) {
            if (settled) return
            settled = true
            try { pc?.close() } catch (e: Exception) {}
            try { factory?.dispose() } catch (e: Exception) {}
            promise.resolve(Arguments.createMap().apply {
                putArray("candidates", collected)
                putString("note", note)
                putBoolean("disableMonitor", disableMonitor)
                putBoolean("ignoreCellular", ignoreCellular)
            })
        }

        try {
            // التهيئة العامة — آمنة حتى لو كانت المكتبة هيّأت نفسها سابقاً
            try {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions
                        .builder(reactApplicationContext)
                        .createInitializationOptions()
                )
            } catch (e: Exception) {}

            // ===== هون بيت القصيد: إعدادات المصنع المخصّصة =====
            val options = PeerConnectionFactory.Options()
            if (disableMonitor) {
                options.disableNetworkMonitor = true
            }
            var mask = 0
            if (ignoreCellular) mask = mask or ADAPTER_TYPE_CELLULAR or ADAPTER_TYPE_VPN
            mask = mask or ADAPTER_TYPE_LOOPBACK
            options.networkIgnoreMask = mask

            factory = PeerConnectionFactory.builder()
                .setOptions(options)
                .createPeerConnectionFactory()

            if (factory == null) { finish("تعذّر إنشاء المصنع"); return }

            // اتصال تجريبي بدون خوادم ICE — منريد مرشّحات host فقط
            val rtcConfig = PeerConnection.RTCConfiguration(emptyList())
            rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            rtcConfig.continualGatheringPolicy =
                PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY

            val observer = object : PeerConnection.Observer {
                override fun onIceCandidate(candidate: IceCandidate?) {
                    val sdp = candidate?.sdp ?: return
                    val parts = sdp.split(" ")
                    val addr = if (parts.size > 4) parts[4] else "?"
                    val typ = if (parts.contains("typ")) parts[parts.indexOf("typ") + 1] else "?"
                    collected.pushString("$typ $addr")
                }
                override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
                override fun onAddStream(stream: MediaStream?) {}
                override fun onRemoveStream(stream: MediaStream?) {}
                override fun onDataChannel(dc: DataChannel?) {}
                override fun onRenegotiationNeeded() {}
                override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}
                override fun onTrack(transceiver: org.webrtc.RtpTransceiver?) {}
            }

            pc = factory.createPeerConnection(rtcConfig, observer)
            if (pc == null) { finish("تعذّر إنشاء الاتصال"); return }

            // قناة بيانات كافية لتوليد قسم وسائط يستدعي جمع المرشّحات
            pc.createDataChannel("probe", DataChannel.Init())

            pc.createOffer(object : SdpObserver {
                override fun onCreateSuccess(sdp: SessionDescription?) {
                    if (sdp == null) { finish("فشل إنشاء العرض"); return }
                    pc?.setLocalDescription(object : SdpObserver {
                        override fun onCreateSuccess(p0: SessionDescription?) {}
                        override fun onSetSuccess() {}
                        override fun onCreateFailure(p0: String?) {}
                        override fun onSetFailure(p0: String?) {}
                    }, sdp)
                }
                override fun onSetSuccess() {}
                override fun onCreateFailure(error: String?) { finish("فشل العرض: $error") }
                override fun onSetFailure(error: String?) {}
            }, MediaConstraints())

            // ننتظر ٦ ثواني لتجميع المرشّحات ثم نرجّع النتيجة
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                finish("انتهى الجمع")
            }, 6000)

        } catch (e: Exception) {
            try { pc?.close() } catch (ex: Exception) {}
            try { factory?.dispose() } catch (ex: Exception) {}
            if (!settled) {
                settled = true
                promise.reject("ERROR", e.message ?: "فشل الفحص")
            }
        }
    }

    /** قائمة واجهات الشبكة كما يراها نظام التشغيل — للمقارنة */
    @ReactMethod
    fun listInterfaces(promise: Promise) {
        try {
            val arr = Arguments.createArray()
            val ifaces = java.net.NetworkInterface.getNetworkInterfaces()
            while (ifaces.hasMoreElements()) {
                val iface = ifaces.nextElement()
                if (!iface.isUp) continue
                val addrs = iface.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr.isLoopbackAddress) continue
                    if (addr is java.net.Inet4Address) {
                        arr.pushString("${iface.name} ${addr.hostAddress}")
                    }
                }
            }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }
}
