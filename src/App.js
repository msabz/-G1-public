import { ThemeProvider } from './theme/themeContext';
import React, { useEffect, useState, useRef } from 'react';
import { View, Alert, AppState, Modal, NativeModules, NativeEventEmitter, PermissionsAndroid, Platform } from 'react-native';
import IdleScreen from './components/IdleScreen';
import ChatScreen from './components/ChatScreen';
import CallScreen from './components/CallScreen';
import BluetoothChatScreen from './components/BluetoothChatScreen';
import RtcProbeScreen from './components/RtcProbeScreen';
import IncomingCallScreen from './components/IncomingCallScreen';
import ContactsScreen from './components/ContactsScreen';
import { States, Tiers } from './utils/stateMachine';
import {
  createSignalingServer, connectToSignalingServer, closeSignaling,
  setOnMessage, setOnDisconnect, sendSignalingMessage, waitForClientConnection,
  startPersistentListener,
} from './webrtc/signaling';
import { lanDiscovery } from './network/LanDiscovery';
import { peerRegistry } from './network/PeerRegistry';
import { connectionCoordinator } from './network/ConnectionCoordinator';
import { secureHandshake } from './network/SecureHandshake';
import { startCameraCapture, stopCameraCapture, switchCamera, onCameraFrame } from './media/CameraStream';
import {
  startAudioSession, stopAudioSession, reportLiveAudio,
  setSpeaker as setSpeakerphone, setCallVolume, onForceStop,
} from './media/AudioSession';
import * as RTCAudio from './media/WebRTCAudio';
import {
  pickFile, captureImage, listInstalledApps, packageAppForSending, openReceivedFile,
  startTransferServer, stopTransferServer, sendFileNative,
  onTransferProgress, onIncomingStart, onIncomingDone, onSentDone, onTransferError,
} from './media/FileShare';
import { startVoiceRecording, stopVoiceRecording, startRingtone, startRingback, stopRingtone } from './media/AudioClip';
import { installApp, onInstallResult } from './media/AppInstaller';
import {
  saveMessage, loadMessages, savePeer, savePeerAddress, deletePeer,
  listPeers, getDeviceIdentity,
} from './services/Persistence';
import {
  WIFI_P2P_STATUS,
  findTrustedIncomingInvitation,
  isPeerAvailable,
  sameWifiPeer,
} from './utils/wifiDirect';
import {
  createConnectionAddressTracker,
  saveResolvedPeerAddress,
} from './utils/connectionPeerAddress';
import {
  startConnectionService, updateConnectionStatus, stopConnectionService,
  showMessageNotification, clearMessageNotifications,
} from './services/Background';
import { BT, onBtConnected, onBtDisconnected, onBtMessage, onBtDeviceFound, onBtDiscoveryFinished } from './bluetooth/BluetoothManager';

const DirectConnection = NativeModules.DirectConnectionModule;
const emitter = new NativeEventEmitter(DirectConnection);
const PORT = 8089;
const DISC_TIMEOUT = 10000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// DNS-SD is only a confidence signal. General Wi-Fi Direct discovery remains
// the source of truth so a device is never hidden when service discovery is
// unsupported or unreliable on a particular Android build.
const sortDiscoveredPeers = peers => [...peers].sort((a, b) => {
  if (!!a.available !== !!b.available) {
    return a.available ? -1 : 1;
  }
  if (!!a.isMusab !== !!b.isMusab) {
    return a.isMusab ? -1 : 1;
  }
  const aName = a.name || a.deviceName || a.deviceAddress || '';
  const bName = b.name || b.deviceName || b.deviceAddress || '';
  return aName.localeCompare(bName);
});

export default function App() {
  const [state, setState] = useState(States.IDLE);
  const [activeTier, setActiveTier] = useState(Tiers.NONE);
  const [inCall, setInCall] = useState(false);
  const [localFrame, setLocalFrame] = useState(null);
  const [remoteFrame, setRemoteFrame] = useState(null);
  const [messages, setMessages] = useState([]);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [wifiEnabled, setWifiEnabled] = useState(null);
  const [statusText, setStatusText] = useState('');
  const [btDevices, setBtDevices] = useState([]);
  const [btScanning, setBtScanning] = useState(false);
  const [btPeerName, setBtPeerName] = useState('');
  const [btMessages, setBtMessages] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [localIp, setLocalIp] = useState("127.0.0.1");

  useEffect(() => {
    // Start persistent LAN listener on 0.0.0.0:8089 (Always-On Listener)
    startPersistentListener(PORT).catch(err => {
      console.log('[App] Persistent listener startup:', err?.message || err);
    });

    getDeviceIdentity()
      .then(identity => {
        if (!identity) return;
        identityRef.current = identity;
        connectionCoordinator.setIdentity(identity);
        secureHandshake.setIdentity(identity);

        if (lanDiscovery.isSupported()) {
          lanDiscovery.startAdvertising({
            deviceId: identity.deviceId,
            deviceName: identity.deviceName,
            port: PORT,
          }).catch(() => {});

          lanDiscovery.startDiscovery({
            onPeerFound: peer => {
              peerRegistry.upsertLanPeer(peer);
            },
            onPeerLost: peer => {
              peerRegistry.upsertLanPeer({ ...peer, isOnline: false });
            },
          }).catch(() => {});
        }
      })
      .catch(() => {});

    if (DirectConnection && DirectConnection.getLocalIpAddress) {
      DirectConnection.getLocalIpAddress()
        .then(ip => { if (ip) setLocalIp(ip); })
        .catch(() => {});
    }
  }, []);

  const handleConnectLan = async (ip, port = 8089) => {
    try {
      setStatusText(`جاري الاتصال بـ ${ip}:${port} عبر شبكة الواي فاي...`);
      setState(States.WIFI_CONNECTING);
      await connectToSignalingServer(ip, port, 5, 800);
      const peer = {
        peerId: `lan_${ip}`,
        deviceAddress: ip,
        deviceName: `LAN (${ip})`,
        customName: `LAN (${ip})`,
        transport: "lan",
        connected: true,
      };
      setActivePeer(peer);
      setPeerDisplayName(`LAN (${ip})`);
      setState(States.CONNECTED);
      setActiveTier(Tiers.WIFI);
      setChatOpen(true);
      setStatusText(`متصل عبر شبكة الواي فاي (${ip})`);
      const identity = identityRef.current || await getDeviceIdentity().catch(() => null);
      if (!identity?.deviceId) throw new Error('تعذّر تحميل هوية G1 الثابتة');
      identityRef.current = identity;
      sendSignalingMessage({
        type: "identity",
        deviceId: identity.deviceId,
        deviceName: identity.deviceName || "DirectChat Device",
      });
    } catch (e) {
      console.warn("LAN connection error:", e);
      Alert.alert("فشل الاتصال عبر الشبكة المحلية", `تعذر الاتصال بـ ${ip}:${port}.\nتأكد أن التطبيق مفتوح على الجهاز الآخر وأنهما على نفس شبكة الواي فاي.`);
      setState(States.IDLE);
      setStatusText("فشل الاتصال بالـ IP");
      throw e;
    }
  };
  const [peerDisplayName, setPeerDisplayName] = useState(null);
  const [audioEngine, setAudioEngine] = useState(null);
  // حالات المكالمة: null | 'incoming' (يرن عندنا) | 'outgoing' (يرن عندهم)
  const [ringState, setRingState] = useState(null);
  const ringStateRef = useRef(ringState);
  ringStateRef.current = ringState;
  // حالة الاتصال منفصلة عن الشاشة المعروضة: ممكن نظل متصلين بينما المستخدم
  // رجع لقائمة المحادثات.
  const [chatVisible, setChatVisible] = useState(false);
  const [activePeer, setActivePeer] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);

  const stateRef = useRef(state);
  stateRef.current = state;
  const timeoutRef = useRef(null);
  const mountedRef = useRef(true);
  const foundDevicesRef = useRef({});
  const cameraOnRef = useRef(false);
  const audioStartedRef = useRef(false);
  const rtcActiveRef = useRef(false);
  const rtcDiagRef = useRef(null);
  const [rtcLog, setRtcLog] = useState([]);
  const [showProbe, setShowProbe] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [scanning, setScanning] = useState(false);
  const discoveredRef = useRef({});
  const contactsRef = useRef([]);
  const targetPeerRef = useRef(null);
  const connectionAddressTrackerRef = useRef(createConnectionAddressTracker());
  const rtcNegotiatingRef = useRef(false);
  const inCallRef = useRef(false);
  const callVideoRef = useRef(true);
  const peerIpRef = useRef(null);
  const activeTransfersRef = useRef(0);
  const peerIdRef = useRef(null);
  const identityRef = useRef(null);
  const appActiveRef = useRef(true);
  const reconnectAttemptRef = useRef(0);
  const lastConnectionRef = useRef(null);
  const micGuardRef = useRef(null);
  const ringTimeoutRef = useRef(null);
  const pendingCallRef = useRef(null);
  const callStartRef = useRef(null);
  const disconnectGraceRef = useRef(null);
  const chatVisibleRef = useRef(false);
  const activePeerRef = useRef(null);
  const scanningRef = useRef(false);
  const scanPromiseRef = useRef(null);
  const scanGenerationRef = useRef(0);
  const connectionAttemptRef = useRef(0);
  const connectionSetupRef = useRef(false);
  const incomingInvitationRef = useRef(null);
  const disconnectingRef = useRef(false);
  const disconnectAckRef = useRef(null);
  const disconnectAckTimerRef = useRef(null);
  const connectionPhaseRef = useRef('خامل');

  const setChatOpen = open => {
    chatVisibleRef.current = open;
    setChatVisible(open);
    if (open) {
      setUnreadCount(0);
      clearMessageNotifications();
    }
  };

  const setActivePeerInfo = patch => {
    const next = { ...(activePeerRef.current || {}), ...patch, connected: true };
    activePeerRef.current = next;
    setActivePeer(next);
  };

  const resetActiveSessionUi = ({ clearMessages = true } = {}) => {
    chatVisibleRef.current = false;
    activePeerRef.current = null;
    targetPeerRef.current = null;
    connectionAddressTrackerRef.current.clear();
    peerIdRef.current = null;
    lastConnectionRef.current = null;
    setChatVisible(false);
    setActivePeer(null);
    setUnreadCount(0);
    setPeerDisplayName(null);
    if (clearMessages) setMessages([]);
  };

  const markUnreadIfChatHidden = () => {
    if (!chatVisibleRef.current) setUnreadCount(prev => prev + 1);
  };

  useEffect(() => {
    mountedRef.current = true;
    requestPerms().then(async granted => {
      if (granted) {
        try {
          await DirectConnection.initialize();
          // يزيل بقايا جلسة من v31 فور فتح النسخة الجديدة على الهاتفين،
          // قبل الإعلان أو البحث. هذا مهم لأول تشغيل بعد الترقية تحديداً.
          const startupCleanup = await DirectConnection.cleanupConnection(8000);
          await DirectConnection.unbindNetwork().catch(() => false);
          await delay(350);
          if (startupCleanup?.clean !== true) {
            if (mountedRef.current) {
              const nativeReason = startupCleanup?.lastFailureCode != null
                ? ` الرمز ${startupCleanup.lastFailureCode} (${startupCleanup.lastFailureName || 'UNKNOWN'}).`
                : '';
              stateRef.current = States.ERROR;
              setState(States.ERROR);
              setStatusText(`وجد Android مجموعة Wi-Fi Direct قديمة ولم ينهِ تنظيفها بعد.${nativeReason} اضغط تحديث للمحاولة مجدداً.`);
            }
            return;
          }

          // نعلن عن أنفسنا طول ما التطبيق مفتوح — عشان يلاقونا الآخرون فوراً
          const id = await getDeviceIdentity();
          identityRef.current = id;
          await DirectConnection.startAdvertising(
            id?.deviceName || 'Musabchat',
            id?.deviceId || ''
          );
          // بعد التنظيف يكون إطار Samsung خارج وضع الاستماع. الإعلان وحده
          // لا يكفي لاستقبال دعوة اتصال ثانية، لذلك نعيد LISTEN صراحةً.
          await DirectConnection.startPassiveListening().catch(() => false);
        } catch (e) {
          if (mountedRef.current) {
            setStatusText(`تعذّر تهيئة Wi-Fi Direct: ${e?.message || 'خطأ غير معروف'}`);
          }
        }
      }
    });

    setOnMessage(async (msg) => {
      if (msg.type === 'frame') {
        if (mountedRef.current) setRemoteFrame(msg.data);
      } else if (msg.type === 'call-request') {
        // ===== مكالمة واردة: نرن فقط، وما نفتح الميكروفون =====
        // نقطة أمان أساسية: قبل هيك كان الميكروفون بينفتح فوراً بدون إذن
        // صاحب الجهاز — يعني تنصّت. هلق منرن ومننتظر قراره.
        if (!inCallRef.current && !ringStateRef.current) {
          pendingCallRef.current = { video: !!msg.video, ip: msg.ip || null };
          if (msg.ip) peerIpRef.current = msg.ip;

          if (mountedRef.current) setRingState('incoming');
          startRingtone().catch(() => {});
          sendSignalingMessage({ type: 'call-ringing' });

          // ما رد خلال ٤٥ ثانية → مكالمة فائتة
          if (ringTimeoutRef.current) clearTimeout(ringTimeoutRef.current);
          ringTimeoutRef.current = setTimeout(() => {
            stopRingtone().catch(() => {});
            sendSignalingMessage({ type: 'call-missed' });
            if (mountedRef.current) setRingState(null);
            pendingCallRef.current = null;
            addMessage({
              sender: 'remote', type: 'call',
              callKind: msg.video ? 'video' : 'voice',
              callResult: 'missed',
            }, true);
          }, 45000);
        } else {
          // مشغول بمكالمة تانية
          sendSignalingMessage({ type: 'call-busy' });
        }

      } else if (msg.type === 'call-ringing') {
        // الطرف الآخر عم يرن — منشغّل نغمة انتظار عنا
        startRingback().catch(() => {});

      } else if (msg.type === 'call-reject' || msg.type === 'call-busy') {
        stopRingtone().catch(() => {});
        if (ringTimeoutRef.current) { clearTimeout(ringTimeoutRef.current); ringTimeoutRef.current = null; }
        if (mountedRef.current) setRingState(null);
        inCallRef.current = false;
        pendingCallRef.current = null;
        addMessage({
          sender: 'me', type: 'call',
          callKind: callVideoRef.current ? 'video' : 'voice',
          callResult: msg.type === 'call-busy' ? 'busy' : 'rejected',
        });

      } else if (msg.type === 'call-missed') {
        stopRingtone().catch(() => {});
        if (mountedRef.current) setRingState(null);
        inCallRef.current = false;
        addMessage({
          sender: 'me', type: 'call',
          callKind: callVideoRef.current ? 'video' : 'voice',
          callResult: 'noanswer',
        });

      } else if (msg.type === 'call-accept') {
        // الطرف الآخر ردّ — هون بس منفتح الميكروفون
        stopRingtone().catch(() => {});
        if (ringTimeoutRef.current) { clearTimeout(ringTimeoutRef.current); ringTimeoutRef.current = null; }
        if (mountedRef.current) { setRingState(null); setInCall(true); }
        callStartRef.current = Date.now();
        if (msg.ip) peerIpRef.current = msg.ip;
        if (msg.ip && !audioStartedRef.current && inCallRef.current) {
          audioStartedRef.current = true;
          beginAudio({ asCaller: true });
        }
        if (callVideoRef.current) {
          cameraOnRef.current = true;
          startCameraCapture().catch(() => {});
        }

      // ===== إشارات WebRTC (بتمرق على نفس قناة التحكم) =====
      //
      // مهم للخصوصية: كل إشارة لازم تتأكد إن في مكالمة قائمة فعلاً.
      // بدون هالفحص، أي عرض متأخر أو إعادة تشغيل بتوصل بعد إنهاء المكالمة
      // كانت تفتح الميكروفون من جديد بدون أي شاشة مكالمة — فيصير الطرف
      // الآخر يسمعك وأنت مش عارف.
      } else if (msg.type === 'rtc-offer') {
        if (!inCallRef.current) {
          // ما في مكالمة — منرفض ومنعلم الطرف الآخر إنها منتهية
          sendSignalingMessage({ type: 'call-end' });
        } else if (msg.restart && RTCAudio.hasActivePeer()) {
          RTCAudio.handleRestartOffer(msg.sdp).catch(() => {});
        } else {
          beginAudio({ asCaller: false, offerSdp: msg.sdp });
        }
      } else if (msg.type === 'rtc-answer') {
        if (inCallRef.current) RTCAudio.acceptAnswer(msg.sdp).catch(() => {});
      } else if (msg.type === 'rtc-ice') {
        if (inCallRef.current) RTCAudio.addRemoteCandidate(msg.candidate).catch(() => {});
      } else if (msg.type === 'call-cancel') {
        // المتصل ألغى قبل ما نرد
        stopRingtone().catch(() => {});
        if (ringTimeoutRef.current) { clearTimeout(ringTimeoutRef.current); ringTimeoutRef.current = null; }
        if (mountedRef.current) setRingState(null);
        const wasVideo = pendingCallRef.current?.video;
        pendingCallRef.current = null;
        addMessage({
          sender: 'remote', type: 'call',
          callKind: wasVideo ? 'video' : 'voice',
          callResult: 'missed',
        }, true);

      } else if (msg.type === 'call-end') {
        endCallLocal();
      } else if (msg.type === 'ping') {
        // نبضة إبقاء القناة حيّة — ما بتحتاج أي إجراء
      } else if (msg.type === 'identity') {
        // تبادل الهوية: منعرف مين الطرف الآخر ومنحمّل محادثته المحفوظة
        if (msg.deviceId) {
          peerIdRef.current = msg.deviceId;
          if (mountedRef.current) setPeerDisplayName(msg.deviceName || 'الجهاز الآخر');
          const selected = targetPeerRef.current || {};
          connectionAddressTrackerRef.current.setIdentity({
            peerId: msg.deviceId,
            deviceName: msg.deviceName || selected.name || selected.deviceName || '',
            targetPeer: selected,
          });
          setActivePeerInfo({
            ...selected,
            peerId: msg.deviceId,
            name: msg.deviceName || selected.name || selected.deviceName || 'الجهاز الآخر',
          });
          await savePeer(msg.deviceId, msg.deviceName || '', '');
          await saveResolvedPeerAddress(connectionAddressTrackerRef.current, savePeerAddress);
          const history = await loadMessages(msg.deviceId, 300);
          if (mountedRef.current) {
            setMessages((history || []).map(h => ({ ...h, time: Number(h.time) })));
          }
          refreshContacts();
        }
      } else if (msg.type === 'my-ip') {
        if (msg.ip) peerIpRef.current = msg.ip;
      } else if (msg.type === 'chat') {
        if (mountedRef.current) addMessage({ sender: 'remote', type: 'text', text: msg.text }, true);
      } else if (msg.type === 'disconnect-ack') {
        const resolveAck = disconnectAckRef.current;
        disconnectAckRef.current = null;
        if (disconnectAckTimerRef.current) {
          clearTimeout(disconnectAckTimerRef.current);
          disconnectAckTimerRef.current = null;
        }
        if (resolveAck) resolveAck(true);
      } else if (msg.type === 'disconnect-request' || msg.type === 'hangup') {
        // v32 يؤكد استلام طلب الفصل قبل إغلاق المقبس. نبقي hangup للتوافق
        // مع طرف أقدم، لكن الطرفين في v32 ينظفان مجموعة Wi-Fi Direct.
        stateRef.current = States.DISCONNECTING;
        if (mountedRef.current) {
          setState(States.DISCONNECTING);
          setStatusText('طلب الجهاز الآخر إنهاء الاتصال — جاري تنظيف المجموعة…');
        }
        if (msg.type === 'disconnect-request') {
          sendSignalingMessage({ type: 'disconnect-ack' });
        }
        setTimeout(() => finishWifiDisconnect({ remote: true }), 180);
      }
    });

    // القناة (socket) ممكن تنقطع فعلياً بدون ما يتفكك Wi-Fi Direct group نفسه،
    // وسابقاً ما في شي كان يحدّث الواجهة بهالحالة فتظل "متصل" وهي مش متصلة —
    // هاي كانت مشكلة "الاتصال يقطع فعلياً بس الواجهة ما بتعرف".
    // هوية ثابتة لهذا الجهاز — منبعتها للطرف الآخر عشان يعرف مين نحنا
    getDeviceIdentity().then(id => { identityRef.current = id; }).catch(() => {});

    // تحميل جهات الاتصال المحفوظة عند فتح التطبيق
    refreshContacts();

    // نتتبّع إذا التطبيق بالمقدّمة عشان نعرف إيمتى نُظهر إشعاراً
    const appStateSub = AppState.addEventListener('change', st => {
      appActiveRef.current = st === 'active';
      if (st === 'active') clearMessageNotifications();
    });

    setOnDisconnect(() => {
      if (!mountedRef.current) return;
      if (disconnectingRef.current || stateRef.current === States.DISCONNECTING) return;
      if (stateRef.current !== States.CONNECTED) return;

      // انقطاع قناة التحكم أثناء نقل ملف كبير غالباً مؤقّت (ضغط على الشبكة).
      // كنا منهدم الاتصال فوراً فبترجع الواجهة للشاشة الأولى رغم إن النقل
      // ناجح — منعطي مهلة سماح، وإذا في نقل شغال منتجاهل الانقطاع أصلاً.
      if (activeTransfersRef.current > 0) return;

      if (disconnectGraceRef.current) clearTimeout(disconnectGraceRef.current);
      disconnectGraceRef.current = setTimeout(async () => {
        if (!mountedRef.current) return;
        if (activeTransfersRef.current > 0) return;

        // منحاول نرجع الاتصال بهدوء قبل ما نرجّع المستخدم للشاشة الأولى
        const recovered = await attemptReconnect();
        if (recovered || !mountedRef.current) return;

        await finishWifiDisconnect({ unexpected: true });
      }, 4000);
    });

    onCameraFrame(base64 => {
      if (!cameraOnRef.current) return;
      if (mountedRef.current) setLocalFrame(base64);
      sendSignalingMessage({ type: 'frame', data: base64 });
    });

    const subs = [
      // الحارس الأصلي اكتشف تسريباً — منقفل مسارات WebRTC فوراً
      onForceStop(() => {
        try { RTCAudio.stop(); } catch (e) {}
      }),
      onInstallResult(({ success, message }) => {
        Alert.alert(success ? 'تم التثبيت' : 'تعذّر التثبيت', message || '');
      }),
      // ===== أحداث نقل الملفات الأصلية (بث خام، بدون مرور عبر الجسر) =====
      onTransferProgress(({ id, direction, progress }) => {
        if (!mountedRef.current) return;
        setMessages(prev => prev.map(m => m.transferId === id ? { ...m, progress } : m));
      }),
      onIncomingStart(({ id, fileName, mimeType, kind, size }) => {
        if (!mountedRef.current) return;
        markUnreadIfChatHidden();
        if (kind === 'voice') {
          setMessages(prev => [...prev, { sender: 'remote', type: 'voice', transferId: id, progress: 0, size, time: Date.now() }]);
        } else {
          setMessages(prev => [...prev, {
            sender: 'remote', type: kind === 'image' ? 'image' : 'file',
            fileName, mimeType, transferId: id, progress: 0, size, time: Date.now(),
          }]);
        }
      }),
      onIncomingDone(({ id, path, size, fileName, kind }) => {
        if (!mountedRef.current) return;
        setMessages(prev => prev.map(m => {
          if (m.transferId !== id) return m;
          const done = {
            ...m, progress: 1, size, path,
            localUri: path ? (path.startsWith('content://') ? path : 'file://' + path) : null,
          };
          // نحفظ الرسالة بعد اكتمال الاستلام (صار عندنا المسار النهائي)
          if (peerIdRef.current) saveMessage(peerIdRef.current, done);
          return done;
        }));
        if (!appActiveRef.current) {
          showMessageNotification(
            peerNameLabel,
            kind === 'voice' ? 'رسالة صوتية' : kind === 'image' ? 'صورة' : `ملف: ${fileName || ''}`
          );
        }
      }),
      onSentDone(({ id, size }) => {
        if (!mountedRef.current) return;
        setMessages(prev => prev.map(m => {
          if (m.transferId !== id) return m;
          const done = { ...m, progress: 1, size, status: 'delivered' };
          if (peerIdRef.current) saveMessage(peerIdRef.current, done);
          return done;
        }));
      }),
      onTransferError(({ id, message }) => {
        if (!mountedRef.current) return;
        setMessages(prev => prev.map(m => m.transferId === id ? { ...m, progress: 1, failed: true } : m));
        Alert.alert('تعذّر نقل الملف', message || '');
      }),
      emitter.addListener('WIFI_P2P_STATE_CHANGED', d => mountedRef.current && setWifiEnabled(d.enabled)),
      emitter.addListener('PEERS_UPDATED', handlePeers),
      // DNS-SD بيعلّم الجهاز كمؤكّد، لكنه مش شرط لظهوره بالقائمة.
      emitter.addListener('MUSAB_PEER_FOUND', (d) => {
        const addr = (d.deviceAddress || '').toLowerCase();
        if (!addr) return;
        const existing = discoveredRef.current[addr] || {};
        const status = Number(d.status);
        discoveredRef.current[addr] = {
          ...existing,
          peerId: d.peerId || existing.peerId || addr,
          deviceAddress: d.deviceAddress,
          name: d.label || d.deviceName || existing.name || existing.deviceName,
          deviceName: d.deviceName || existing.deviceName,
          isMusab: true,
          status,
          available: status === WIFI_P2P_STATUS.AVAILABLE,
          seenGeneration: scanGenerationRef.current,
        };
        if (mountedRef.current) {
          setDiscovered(sortDiscoveredPeers(Object.values(discoveredRef.current)));
          if (d.peerId) refreshContacts();
        }
      }),
      emitter.addListener('PEER_CONNECTED', handlePeerConnected),
      emitter.addListener('PEER_ADDRESS_RESOLVED', async d => {
        const accepted = connectionAddressTrackerRef.current.setConnectedPeerAddress(
          d.connectionEpoch,
          d.peerDeviceAddress
        );
        if (accepted) {
          await saveResolvedPeerAddress(connectionAddressTrackerRef.current, savePeerAddress);
        }
      }),
      emitter.addListener('PEER_DISCONNECTED', handlePeerDisconnected),
      onBtDeviceFound(d => {
        if (!foundDevicesRef.current[d.address]) {
          foundDevicesRef.current[d.address] = d;
          setBtDevices(Object.values(foundDevicesRef.current));
        }
      }),
      onBtDiscoveryFinished(() => mountedRef.current && setBtScanning(false)),
      onBtConnected(d => {
        if (!mountedRef.current) return;
        setBtPeerName(d.deviceName);
        setActiveTier(Tiers.BLUETOOTH);
        setState(States.BT_CONNECTED);
      }),
      onBtDisconnected(() => {
        if (!mountedRef.current) return;
        Alert.alert('انقطع اتصال البلوتوث');
        setState(States.IDLE);
        setActiveTier(Tiers.NONE);
        setBtMessages([]);
      }),
      onBtMessage(m => mountedRef.current && setBtMessages(prev => [...prev, { sender: 'remote', text: m.text }])),
    ];
    return () => {
      mountedRef.current = false;
      appStateSub?.remove();
      subs.forEach(s => s.remove());
      // Root/Activity teardown is not an explicit disconnect. Keep signaling,
      // file server and the foreground availability service alive so removing
      // G1 from Recents does not make the peer go offline. Explicit disconnect
      // flows still call cleanupAll()/finishWifiDisconnect().
    };
  // الاشتراكات الأصلية تُثبت مرة واحدة وتعتمد على refs للحالة الحية؛
  // إعادة إنشائها مع كل render تضاعف مستمعي المقابس وWi-Fi Direct.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function requestPerms() {
    const perms = [
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ...(Platform.Version >= 33
        ? [PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES, PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]),
    ];
    const res = await PermissionsAndroid.requestMultiple(perms);
    const essentialsGranted = !Object.values(res).some(v => v !== 'granted');

    // إذن الإشعارات موجود فقط من أندرويد ١٣ وطالع، ورفضه ما بيمنع الاتصال —
    // فمنطلبه لحاله وما منعتبره شرطاً أساسياً
    if (Platform.Version >= 33) {
      try {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      } catch (e) {}
    }

    return essentialsGranted;
  };

  const start = async () => {
    if (!(await requestPerms())) { Alert.alert('الأذونات مطلوبة للاتصال'); return; }
    const locOn = await DirectConnection.isLocationEnabled().catch(() => true);
    if (!locOn) {
      Alert.alert('يجب تفعيل خدمة الموقع', 'اكتشاف Wi-Fi Direct يحتاج خدمة الموقع مفعّلة بالنظام.', [
        { text: 'فتح الإعدادات', onPress: () => DirectConnection.openLocationSettings() },
        { text: 'إلغاء', style: 'cancel' },
      ]);
      return;
    }
    try {
      await DirectConnection.initialize();
      const info = await DirectConnection.getConnectionInfo();
      if (info && info.groupFormed) { handlePeerConnected(info); return; }

      setState(States.DISCOVERING);
      setShowCreateGroup(false);

      await DirectConnection.stopDiscovery().catch(() => {});
      await new Promise(r => setTimeout(r, 400));
      await DirectConnection.discoverPeers();

      timeoutRef.current = setTimeout(() => {
        if (stateRef.current === States.DISCOVERING) setShowCreateGroup(true);
      }, DISC_TIMEOUT);
    } catch (e) {
      setStatusText('تعذّر الاتصال عبر واي فاي مباشر. جرّب البلوتوث كبديل بالأسفل.');
      setState(States.IDLE);
    }
  };

  const createGroup = async () => {
    connectionAddressTrackerRef.current.beginAttempt();
    clearTimeout(timeoutRef.current);
    setShowCreateGroup(false);
    setState(States.WIFI_CONNECTING);
    try {
      await DirectConnection.createGroup();
    } catch (e) {
      setStatusText('فشل إنشاء المجموعة. جرّب البلوتوث كبديل.');
      setState(States.IDLE);
    }
  };

  /**
   * تحديث قائمة الأجهزة المرئية فقط — بدون اتصال تلقائي.
   *
   * البحث العام بيرجّع كل جهاز Wi-Fi Direct قريب، لذلك منعرض النتائج
   * كلها ونترك الاختيار للمستخدم. DNS-SD، إذا اشتغل، يضيف علامة تأكيد
   * ويرفع جهاز Musabchat لأعلى القائمة فقط.
   */
  function handlePeers(data) {
    const peers = data?.peers || [];
    const previous = discoveredRef.current;
    const next = {};
    peers.forEach(p => {
      const addr = (p.deviceAddress || '').toLowerCase();
      if (!addr) return;
      const known = previous[addr] || {};
      const status = Number(p.status);
      next[addr] = {
        ...known,
        peerId: known.peerId || addr,
        deviceAddress: p.deviceAddress,
        name: known.name || p.deviceName || 'جهاز Wi-Fi Direct',
        deviceName: p.deviceName || known.deviceName,
        isMusab: known.isMusab === true,
        status,
        available: status === WIFI_P2P_STATUS.AVAILABLE,
        seenGeneration: scanGenerationRef.current,
      };
    });
    // هذه لقطة من requestPeers وليست قائمة تراكمية. حذف الأجهزة الغائبة
    // يمنع بقاء اسم قديم قابلاً للضغط بعد انتهاء الجلسة السابقة.
    discoveredRef.current = next;
    if (mountedRef.current) {
      setDiscovered(sortDiscoveredPeers(Object.values(next)));
    }
    // على بعض أجهزة Samsung لا تظهر نافذة قبول ثانية بعد فك المجموعة.
    // حالة INVITED هي الإشارة الوحيدة داخل التطبيق إلى أن الطرف الآخر طلبنا.
    maybeAnswerIncomingInvitation(Object.values(next));
  };

  const handlePeerConnected = async initialInfo => {
    if (!initialInfo?.groupFormed || disconnectingRef.current) return;
    if (stateRef.current === States.CONNECTED || connectionSetupRef.current) return;
    if (
      !connectionAddressTrackerRef.current.activateConnection(
        initialInfo.connectionEpoch,
      )
    ) {
      return;
    }

    incomingInvitationRef.current = null;
    connectionSetupRef.current = true;
    connectionAttemptRef.current += 1;
    const shouldOpenChat = stateRef.current !== States.CONNECTED;

    // تكوين المجموعة يعني أن تفاوض Wi-Fi Direct نجح؛ نلغي مهلة الطلب
    // فوراً حتى لا تنظف مجموعة سليمة أثناء تجهيز عنوان المضيف.
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    let info = initialInfo;
    try {
      connectionPhaseRef.current = 'قراءة معلومات المجموعة';
      for (let retry = 0; !info.isGroupOwner && !info.groupOwnerAddress && retry < 6; retry++) {
        await delay(500);
        info = await DirectConnection.getConnectionInfo();
      }

      const isOwner = !!info.isGroupOwner;
      const ownerIP = info.groupOwnerAddress;
      if (!isOwner && !ownerIP) {
        throw new Error('لم يرسل Android عنوان مالك المجموعة');
      }

      stateRef.current = States.WIFI_CONNECTING;
      setState(States.WIFI_CONNECTING);
      setActiveTier(Tiers.WIFI_DIRECT);
      setStatusText('تم تكوين المجموعة — جاري ربط قناة الاتصال…');

      // الربط يؤثر في المقابس التي تُنشأ بعده فقط، لذلك يسبق إنشاء TCP
      // في الاتصال الأول وفي كل محاولة إعادة اتصال.
      connectionPhaseRef.current = 'ربط شبكة Wi-Fi Direct';
      const bound = await DirectConnection.bindToWifiDirectNetwork().catch(() => false);
      if (!bound) console.warn('[Wi-Fi Direct] لم يؤكد Android ربط العملية بالشبكة');

      connectionPhaseRef.current = 'فتح قناة TCP';
      if (isOwner) {
        await createSignalingServer(PORT);
        await waitForClientConnection(30000);
      } else {
        await connectToSignalingServer(ownerIP, PORT);
      }

      if (!mountedRef.current || disconnectingRef.current) return;

      // خادم استقبال الملفات لازم يشتغل عند الطرفين طول مدة الاتصال
      startTransferServer().catch(() => {});

      // فحص أمان دوري: لو الميكروفون ضل شغّال خارج المكالمة منقفله فوراً.
      if (micGuardRef.current) clearInterval(micGuardRef.current);
      micGuardRef.current = setInterval(() => {
        reportLiveAudio(RTCAudio.hasLiveAudio());
      }, 3000);

      if (!isOwner) {
        peerIpRef.current = ownerIP;
        const myIp = await DirectConnection.getLocalIpAddress().catch(() => null);
        sendSignalingMessage({ type: 'my-ip', ip: myIp });
      }

      // تبادل هوية ثابتة؛ DNS-SD يعلن الهوية نفسها كي نربط المحادثة
      // المحفوظة بعنوان P2P الحالي بدلاً من عنوان جلسة قديمة.
      const identity = identityRef.current || await getDeviceIdentity().catch(() => null);
      if (identity) {
        identityRef.current = identity;
        sendSignalingMessage({
          type: 'identity',
          deviceId: identity.deviceId,
          deviceName: identity.deviceName,
        });
      }

      startConnectionService('متصل عبر واي فاي مباشر');
      lastConnectionRef.current = { isOwner, ownerIP };
      reconnectAttemptRef.current = 0;

      const selected = targetPeerRef.current;
      if (selected) {
        setActivePeerInfo({
          ...selected,
          name: selected.customName || selected.name || selected.deviceName || 'الجهاز الآخر',
        });
      }

      connectionPhaseRef.current = 'متصل';
      setStatusText('');
      stateRef.current = States.CONNECTED;
      setState(States.CONNECTED);
      if (shouldOpenChat) setChatOpen(true);
    } catch (e) {
      if (!disconnectingRef.current && mountedRef.current) {
        await recoverFailedConnection(connectionPhaseRef.current, e);
      }
    } finally {
      connectionSetupRef.current = false;
    }
  };

  /**
   * إعادة اتصال تلقائية بعد انقطاع، بدل ما ترجع للشاشة الأولى.
   * منحاول عدة مرات بفواصل متزايدة قبل ما نستسلم.
   */
  const attemptReconnect = async () => {
    const last = lastConnectionRef.current;
    if (!last || !mountedRef.current || disconnectingRef.current) return false;

    const attempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = attempt;
    if (attempt > 5) return false;

    setStatusText(`انقطع الاتصال — محاولة إعادة الاتصال (${attempt}/5)…`);
    updateConnectionStatus(`إعادة الاتصال (${attempt}/5)…`);

    try {
      closeSignaling();
      connectionPhaseRef.current = 'إعادة ربط شبكة Wi-Fi Direct';
      await DirectConnection.bindToWifiDirectNetwork().catch(() => false);
      connectionPhaseRef.current = 'إعادة فتح قناة TCP';
      if (last.isOwner) {
        await createSignalingServer(PORT);
        await waitForClientConnection(15000);
      } else {
        await connectToSignalingServer(last.ownerIP, PORT, 8, 1200);
      }
      if (!mountedRef.current) return false;

      startTransferServer().catch(() => {});

      const identity = identityRef.current;
      if (identity) {
        sendSignalingMessage({
          type: 'identity',
          deviceId: identity.deviceId,
          deviceName: identity.deviceName,
        });
      }

      reconnectAttemptRef.current = 0;
      stateRef.current = States.CONNECTED;
      setState(States.CONNECTED);
      setStatusText('');
      updateConnectionStatus('متصل عبر واي فاي مباشر');
      return true;
    } catch (e) {
      // فاصل متزايد بين المحاولات
      await new Promise(r => setTimeout(r, 1500 * attempt));
      return attemptReconnect();
    }
  };

  function handlePeerDisconnected() {
    // أثناء الفصل المتعمّد، cleanupConnection هو مصدر الحقيقة وينتظر
    // requestGroupInfo؛ لا نسمح لبث متأخر بتغيير الحالة قبله.
    if (disconnectingRef.current || stateRef.current === States.DISCONNECTING) return;
    if (stateRef.current === States.CONNECTED) {
      finishWifiDisconnect({ unexpected: true });
    } else if (
      stateRef.current === States.WIFI_CONNECTING &&
      connectionSetupRef.current
    ) {
      // لا نعدّ groupFormed=false فشلاً قبل أن تتكوّن مجموعة في هذه
      // المحاولة فعلياً. Samsung يرسل أحياناً بثاً متأخراً من cleanup
      // بعد بدء connect() الجديد، وكانت v32 تلغي المحاولة الصحيحة بنفسها.
      recoverFailedConnection(
        connectionPhaseRef.current,
        new Error('ألغى Android مجموعة Wi-Fi Direct قبل اكتمال قناة الاتصال')
      );
    } else if (stateRef.current === States.WIFI_CONNECTING) {
      console.log('[Wi-Fi Direct] تجاهل بث انفصال سابق أثناء تفاوض جديد');
    }
  };

  const btScan = async () => {
    if (!(await requestPerms())) { Alert.alert('الأذونات مطلوبة'); return; }
    const supported = await BT.isSupported().catch(() => false);
    if (!supported) { Alert.alert('البلوتوث غير مدعوم على هذا الجهاز'); return; }
    const enabled = await BT.isEnabled().catch(() => false);
    if (!enabled) { await BT.requestEnable().catch(() => {}); return; }

    foundDevicesRef.current = {};
    setBtDevices([]);
    setBtScanning(true);
    await BT.startListening().catch(() => {});
    await BT.startDiscovery().catch(() => setBtScanning(false));
  };

  const btConnect = async (address) => {
    setState(States.BT_CONNECTING);
    try {
      await BT.stopDiscovery().catch(() => {});
      await BT.connectToDevice(address);
    } catch (e) {
      Alert.alert('فشل الاتصال عبر البلوتوث', e?.message || '');
      setState(States.IDLE);
    }
  };

  const sendBtMsg = (text) => {
    BT.sendMessage(text).then(() => {
      setBtMessages(prev => [...prev, { sender: 'me', text }]);
    }).catch(() => Alert.alert('تعذّر إرسال الرسالة'));
  };

  const endBtChat = () => {
    BT.disconnect().catch(() => {});
    setBtMessages([]);
    setActiveTier(Tiers.NONE);
    setState(States.IDLE);
  };

  const endCallLocal = () => {
    // تسجيل المكالمة بالدردشة مع مدتها
    if (callStartRef.current) {
      const seconds = Math.round((Date.now() - callStartRef.current) / 1000);
      callStartRef.current = null;
      addMessage({
        sender: 'me', type: 'call',
        callKind: callVideoRef.current ? 'video' : 'voice',
        callResult: 'ended',
        duration: seconds,
      });
    }
    stopRingtone().catch(() => {});
    if (ringTimeoutRef.current) { clearTimeout(ringTimeoutRef.current); ringTimeoutRef.current = null; }
    if (mountedRef.current) setRingState(null);
    pendingCallRef.current = null;
    inCallRef.current = false;
    cameraOnRef.current = false;
    audioStartedRef.current = false;
    stopCameraCapture().catch(() => {});
    // نوقف المحركين معاً — أياً كان الشغّال
    try { RTCAudio.stop(); } catch (e) {}
    stopAudioSession();
    rtcActiveRef.current = false;
    rtcNegotiatingRef.current = false;
    if (mountedRef.current) {
      setAudioEngine(null);
      setInCall(false);
      setLocalFrame(null);
      setRemoteFrame(null);
    }
  };

  function cleanupAll() {
    connectionAttemptRef.current += 1;
    incomingInvitationRef.current = null;
    connectionAddressTrackerRef.current.clear();
    endCallLocal();
    closeSignaling();
    stopTransferServer().catch(() => {});
    DirectConnection.unbindNetwork().catch(() => {});
    stopConnectionService();
    peerIpRef.current = null;
    activeTransfersRef.current = 0;
    if (micGuardRef.current) { clearInterval(micGuardRef.current); micGuardRef.current = null; }
    if (disconnectGraceRef.current) { clearTimeout(disconnectGraceRef.current); disconnectGraceRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  };

  /** قبول المكالمة الواردة — هون فقط بينفتح الميكروفون */
  const acceptIncomingCall = async () => {
    const pending = pendingCallRef.current;
    if (!pending) return;

    stopRingtone().catch(() => {});
    if (ringTimeoutRef.current) { clearTimeout(ringTimeoutRef.current); ringTimeoutRef.current = null; }

    inCallRef.current = true;
    callVideoRef.current = pending.video;
    rtcActiveRef.current = false;
    rtcNegotiatingRef.current = false;
    callStartRef.current = Date.now();

    if (mountedRef.current) {
      setRingState(null);
      setInCall(true);
      setAudioEngine(null);
      setRtcLog([]);
    }

    if (pending.video) {
      cameraOnRef.current = true;
      startCameraCapture().catch(() => {});
    }

    const myIp = await DirectConnection.getLocalIpAddress().catch(() => null);
    sendSignalingMessage({ type: 'call-accept', ip: myIp });

    pendingCallRef.current = null;
  };

  /** رفض المكالمة الواردة — ما بينفتح ميكروفون إطلاقاً */
  const rejectIncomingCall = () => {
    const pending = pendingCallRef.current;
    stopRingtone().catch(() => {});
    if (ringTimeoutRef.current) { clearTimeout(ringTimeoutRef.current); ringTimeoutRef.current = null; }
    sendSignalingMessage({ type: 'call-reject' });
    if (mountedRef.current) setRingState(null);
    pendingCallRef.current = null;
    addMessage({
      sender: 'remote', type: 'call',
      callKind: pending?.video ? 'video' : 'voice',
      callResult: 'declined',
    });
  };

  const advertiseIdentity = async () => {
    const id = identityRef.current || await getDeviceIdentity().catch(() => null);
    if (!id) return false;
    identityRef.current = id;
    return DirectConnection.startAdvertising(
      id.deviceName || 'Musabchat',
      id.deviceId || ''
    ).catch(() => false);
  };

  const cleanupWifiDirect = async (timeoutMs = 10000) => {
    connectionPhaseRef.current = 'تنظيف Wi-Fi Direct';
    const result = await DirectConnection.cleanupConnection(timeoutMs);
    await DirectConnection.unbindNetwork().catch(() => false);
    // stopPeerDiscovery/removeGroup يعيدان نجاح بدء الطلب فقط. مهلة قصيرة
    // تمنع طلب البحث الجديد من السباق مع آخر رسالة في العملية السابقة.
    await delay(350);
    return result;
  };

  const finishWifiDisconnect = async ({ remote = false, unexpected = false, failure = null } = {}) => {
    if (disconnectingRef.current) return false;
    disconnectingRef.current = true;
    connectionSetupRef.current = false;
    stateRef.current = States.DISCONNECTING;
    if (mountedRef.current) {
      setState(States.DISCONNECTING);
      setStatusText('جاري إنهاء اتصال Wi-Fi Direct وتنظيف المجموعة…');
    }

    cleanupAll();
    let result = null;
    try {
      result = await cleanupWifiDirect(10000);
    } catch (e) {
      result = { clean: false, error: e?.message || String(e) };
    }

    const clean = result?.clean === true;
    if (clean) {
      await advertiseIdentity();
      // cleanupConnection يوقف peer discovery (وبالتالي LISTEN أيضاً).
      // نعيد وضع الاستقبال كي يتمكن الهاتف الآخر من بدء اتصال جديد من التطبيق.
      await DirectConnection.startPassiveListening().catch(() => false);
    }

    if (mountedRef.current) {
      resetActiveSessionUi({ clearMessages: !unexpected && !failure });
      setActiveTier(Tiers.NONE);

      if (clean) {
        if (failure) {
          stateRef.current = States.IDLE;
          setState(States.IDLE);
          setStatusText(
            `فشل الاتصال في مرحلة «${failure.phase}»: ${failure.message}. تم تنظيف المحاولة؛ حاول مجدداً.`
          );
        } else if (unexpected) {
          stateRef.current = States.DISCONNECTED;
          setState(States.DISCONNECTED);
          setStatusText('انقطع الاتصال، وتم تنظيف مجموعة Wi-Fi Direct. يمكنك الاتصال مجدداً.');
        } else {
          stateRef.current = States.IDLE;
          setState(States.IDLE);
          setStatusText('');
        }
      } else {
        stateRef.current = States.ERROR;
        setState(States.ERROR);
        const nativeReason = result?.lastFailureCode != null
          ? ` آخر رمز من Android: ${result.lastFailureCode} (${result.lastFailureName || 'UNKNOWN'}).`
          : '';
        setStatusText(
          `لم يؤكد Android إزالة مجموعة Wi-Fi Direct خلال المهلة.${nativeReason} اضغط تحديث لإعادة محاولة التنظيف.`
        );
      }

      if (remote) Alert.alert('أنهى الطرف الآخر الاتصال');
    }

    disconnectingRef.current = false;
    return clean;
  };

  const recoverFailedConnection = async (phase, error) => {
    const message = error?.message || String(error || 'خطأ غير معروف');
    console.warn(`[Wi-Fi Direct] فشل في مرحلة ${phase}: ${message}`);
    return finishWifiDisconnect({ failure: { phase, message } });
  };

  const requestCurrentPeers = async () => {
    const peers = await DirectConnection.requestPeers();
    handlePeers({ peers: peers || [] });
    return peers || [];
  };

  /** دورة بحث واحدة متسلسلة وقابلة للمشاركة بين زر + وفتح محادثة محفوظة. */
  const runFreshDiscovery = async () => {
    if (scanPromiseRef.current) return scanPromiseRef.current;

    const task = (async () => {
      scanningRef.current = true;
      if (mountedRef.current) {
        setScanning(true);
        setStatusText('جاري تنظيف أي محاولة اتصال سابقة…');
      }

      scanGenerationRef.current += 1;
      connectionAddressTrackerRef.current.beginAttempt();
      discoveredRef.current = {};
      if (mountedRef.current) setDiscovered([]);

      await DirectConnection.initialize();
      const cleanup = await cleanupWifiDirect(8000);
      if (cleanup?.clean !== true) {
        const nativeReason = cleanup?.lastFailureCode != null
          ? `؛ رمز Android ${cleanup.lastFailureCode} (${cleanup.lastFailureName || 'UNKNOWN'})`
          : '';
        throw new Error(`بقيت مجموعة Wi-Fi Direct قديمة بعد مهلة التنظيف${nativeReason}`);
      }

      await advertiseIdentity();

      // DNS-SD مرحلة مستقلة. نمنحها وقتاً لإرجاع TXT الذي يحمل هوية
      // الجهاز، ثم ننهي طلب الخدمة قبل بدء البحث العام الاحتياطي.
      let serviceWarning = null;
      connectionPhaseRef.current = 'اكتشاف خدمة Musabchat';
      if (mountedRef.current) setStatusText('جاري التحقق من أجهزة Musabchat…');
      try {
        await DirectConnection.discoverMusabPeers();
        await delay(1800);
        await requestCurrentPeers();
      } catch (e) {
        serviceWarning = e?.message || String(e);
        console.warn(`[Wi-Fi Direct] DNS-SD اختياري: ${serviceWarning}`);
      } finally {
        await DirectConnection.stopServiceDiscovery().catch(() => false);
      }

      connectionPhaseRef.current = 'البحث العام عن الأقران';
      if (mountedRef.current) setStatusText('جاري جلب قائمة أجهزة Wi-Fi Direct الحالية…');
      await DirectConnection.discoverPeers();
      await delay(900);
      await requestCurrentPeers();
      await delay(1600);
      await requestCurrentPeers();

      await refreshContacts();
      const peers = Object.values(discoveredRef.current);
      if (mountedRef.current) {
        setStatusText(
          !peers.length && serviceWarning
            ? `لم يظهر جهاز متاح. فشل تأكيد Musabchat أيضاً: ${serviceWarning}`
            : ''
        );
      }
      return peers;
    })();

    scanPromiseRef.current = task;
    try {
      return await task;
    } finally {
      if (scanPromiseRef.current === task) scanPromiseRef.current = null;
      scanningRef.current = false;
      if (mountedRef.current) setScanning(false);
    }
  };

  const findFreshPeer = contact => {
    const address = (contact?.deviceAddress || '').toLowerCase();
    return Object.values(discoveredRef.current).find(peer => {
      const sameId = !!contact?.peerId && !!peer.peerId && contact.peerId === peer.peerId;
      const sameAddress = !!address && (peer.deviceAddress || '').toLowerCase() === address;
      return (sameId || sameAddress) &&
        peer.seenGeneration === scanGenerationRef.current &&
        isPeerAvailable(peer);
    }) || null;
  };

  // ===================== جهات الاتصال والاكتشاف =====================

  async function refreshContacts() {
    const saved = await listPeers();
    if (!mountedRef.current) return;
    // النقطة الخضراء تعني أن DNS-SD أكّد Musabchat فعلاً، وليس مجرد
    // ظهور الجهاز في البحث العام.
    const found = discoveredRef.current;
    const nextContacts = (saved || []).map(c => {
      const match = Object.values(found).find(
        d => (
          (!!c.peerId && !!d.peerId && c.peerId === d.peerId) ||
          (!!c.deviceAddress &&
            (d.deviceAddress || '').toLowerCase() === c.deviceAddress.toLowerCase())
        )
      );
      return {
        ...c,
        deviceAddress: match?.deviceAddress || c.deviceAddress,
        status: match?.status,
        available: match?.available === true,
        isMusab: match?.isMusab === true,
        seenGeneration: match?.seenGeneration,
        online: match?.isMusab === true && match?.available === true,
      };
    });
    contactsRef.current = nextContacts;
    setContacts(nextContacts);
  };

  const beginWifiNegotiation = async (selected, { incoming = false } = {}) => {
    connectionAddressTrackerRef.current.beginAttempt();
    targetPeerRef.current = selected;
    connectionSetupRef.current = false;
    const attemptId = ++connectionAttemptRef.current;

    // لا نعرض رسائل الجلسة السابقة أثناء انتظار وصول هوية الجهاز الجديد.
    setMessages([]);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    stateRef.current = States.WIFI_CONNECTING;
    setState(States.WIFI_CONNECTING);
    connectionPhaseRef.current = incoming
      ? 'الاستجابة لدعوة Wi-Fi Direct'
      : 'بدء تفاوض Wi-Fi Direct';
    setStatusText(
      incoming
        ? `وصل طلب اتصال من ${selected.customName || selected.name || 'الجهاز'} — جاري إكماله…`
        : `جاري الاتصال بـ ${selected.customName || selected.name || 'الجهاز'}…`
    );

    await DirectConnection.stopServiceDiscovery().catch(() => false);
    // لا نستدعي stopPeerDiscovery هنا: أندرويد يمسح معه قائمة الأقران
    // الداخلية. العنوان مأخوذ من requestPeers أو من دعوة INVITED الحالية.
    await DirectConnection.connectToPeer(selected.deviceAddress);

    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(async () => {
      if (!mountedRef.current || attemptId !== connectionAttemptRef.current) {
        return;
      }
      if (stateRef.current === States.WIFI_CONNECTING) {
        await recoverFailedConnection(
          'تفاوض Wi-Fi Direct',
          new Error('لم تتكوّن المجموعة خلال 30 ثانية ولم يستجب الجهاز')
        );
      }
    }, 30000);
  };

  const maybeAnswerIncomingInvitation = peers => {
    if (!mountedRef.current || disconnectingRef.current) {
      return;
    }
    if (stateRef.current !== States.IDLE && stateRef.current !== States.DISCONNECTED) {
      return;
    }
    // لا نتدخل في دورة بحث بدأها المستخدم؛ في الاتصال الصادر تصبح الحالة
    // WIFI_CONNECTING قبل أن تتبدل حالة النظير إلى INVITED.
    if (scanningRef.current || scanPromiseRef.current) {
      return;
    }

    const invited = findTrustedIncomingInvitation(peers, contactsRef.current);
    const address = (invited?.deviceAddress || '').toLowerCase();
    if (!invited || !address || incomingInvitationRef.current === address) {
      return;
    }

    const saved = contactsRef.current.find(contact => sameWifiPeer(contact, invited));
    const selected = {
      ...(saved || {}),
      ...invited,
      peerId: saved?.peerId || invited.peerId,
      deviceAddress: invited.deviceAddress,
      name: saved?.customName || saved?.name || invited.name || invited.deviceName,
    };

    incomingInvitationRef.current = address;
    beginWifiNegotiation(selected, { incoming: true }).catch(async error => {
      if (!disconnectingRef.current) {
        await recoverFailedConnection(connectionPhaseRef.current, error);
      }
    });
  };

  /** بحث يدوي عن أجهزة Wi-Fi Direct — بدل الفحص الدوري الموفّر للبطارية */
  const scanForDevices = async () => {
    if (stateRef.current === States.CONNECTED) {
      Alert.alert(
        'يوجد اتصال قائم',
        'اقطع الاتصال الحالي من قائمة ⋮ داخل الدردشة قبل البحث عن جهاز جديد.'
      );
      return;
    }
    if (stateRef.current === States.DISCONNECTING || disconnectingRef.current) {
      Alert.alert('جاري إنهاء الاتصال', 'انتظر حتى يكتمل تنظيف مجموعة Wi-Fi Direct.');
      return;
    }
    if (scanningRef.current) return scanPromiseRef.current;
    try {
      return await runFreshDiscovery();
    } catch (e) {
      if (mountedRef.current) {
        stateRef.current = States.ERROR;
        setState(States.ERROR);
        setStatusText(
          `فشل البحث في مرحلة «${connectionPhaseRef.current}»: ${e?.message || 'خطأ غير معروف'}`
        );
      }
      return [];
    }
  };

  /**
   * الاتصال بجهاز محدّد اختاره المستخدم.
   *
   * سابقاً كان الكود يتصل بأول جهاز يظهر بالقائمة — حتى لو كان جهاز
   * جار ما عليه التطبيق. المحاولة كانت تفشل ويعلق الإطار فتفشل اللي
   * بعدها كمان. هلق الاتصال بيصير بالجهاز يلي اخترته أنت فقط.
   */
  const connectToContact = async (contact) => {
    if (stateRef.current === States.CONNECTED) {
      const current = activePeerRef.current;
      const sameId = !!contact.peerId && !!current?.peerId && contact.peerId === current.peerId;
      const sameAddress = !!contact.deviceAddress && !!current?.deviceAddress &&
        contact.deviceAddress.toLowerCase() === current.deviceAddress.toLowerCase();

      if (sameId || sameAddress) {
        setChatOpen(true);
        return;
      }

      Alert.alert(
        'يوجد اتصال قائم',
        `أنت متصل الآن بـ ${current?.customName || current?.name || 'جهاز آخر'}. يجب قطع الاتصال الحالي قبل الاتصال بجهاز مختلف.`,
        [
          { text: 'إلغاء', style: 'cancel' },
          {
            text: 'قطع الاتصال',
            style: 'destructive',
            onPress: () => disconnectAll(),
          },
        ]
      );
      return;
    }

    if (stateRef.current === States.DISCONNECTING || disconnectingRef.current) {
      Alert.alert('جاري إنهاء الاتصال', 'انتظر حتى يكتمل تنظيف مجموعة Wi-Fi Direct.');
      return;
    }

    try {
      // Priority 1: Check if peer is reachable over LAN
      const lanInfo = contact.transports?.LAN || (contact.host ? { host: contact.host, port: contact.port || 8089 } : peerRegistry.getPeer(contact.deviceId || contact.peerId)?.transports?.LAN);
      if (lanInfo && lanInfo.host && lanInfo.isReachable !== false) {
        try {
          await handleConnectLan(lanInfo.host, lanInfo.port || 8089);
          return;
        } catch (lanErr) {
          console.log('[App] LAN attempt failed in connectToContact, falling back to P2P:', lanErr?.message || lanErr);
        }
      }

      // إذا كان زر + ما زال يبحث، ننتظر اكتمال دورته كي لا يبدأ connect()
      // بينما discoverServices/discoverPeers ما زالا يتبادلان التحكم بالإطار.
      if (scanPromiseRef.current) await scanPromiseRef.current;

      let freshPeer = findFreshPeer(contact);
      if (!freshPeer) {
        if (mountedRef.current) {
          setStatusText(`جاري البحث عن ${contact.customName || contact.name || 'الجهاز'} بعنوان حديث…`);
        }
        await runFreshDiscovery();
        freshPeer = findFreshPeer(contact);
      }

      if (!freshPeer) {
        const known = Object.values(discoveredRef.current).find(peer => (
          (!!contact.peerId && !!peer.peerId && contact.peerId === peer.peerId) ||
          (!!contact.deviceAddress &&
            (peer.deviceAddress || '').toLowerCase() === contact.deviceAddress.toLowerCase())
        ));
        const status = Number(known?.status);
        const reason = status === WIFI_P2P_STATUS.CONNECTED
          ? 'ما زال Android يعتبره ضمن جلسة سابقة.'
          : status === WIFI_P2P_STATUS.INVITED
            ? 'ما زالت هناك دعوة اتصال معلّقة.'
            : status === WIFI_P2P_STATUS.UNAVAILABLE
              ? 'الجهاز ظاهر لكنه غير متاح للاتصال الآن.'
              : 'لم يظهر في قائمة الأقران الحالية.';
        setStatusText(`${reason} افتح Musabchat على الجهاز الثاني ثم أعد البحث.`);
        return;
      }

      const selected = {
        ...contact,
        ...freshPeer,
        peerId: freshPeer.isMusab
          ? (freshPeer.peerId || contact.peerId)
          : (contact.peerId || freshPeer.peerId),
        deviceAddress: freshPeer.deviceAddress,
      };
      incomingInvitationRef.current = null;
      await beginWifiNegotiation(selected);
    } catch (e) {
      if (!disconnectingRef.current) {
        await recoverFailedConnection(connectionPhaseRef.current, e);
      }
    }
  };

  const handleDeleteContact = (contact) => {
    Alert.alert(
      'حذف المحادثة',
      `حذف "${contact.customName || contact.name}" وكل رسائلها؟`,
      [
        { text: 'إلغاء', style: 'cancel' },
        {
          text: 'حذف',
          style: 'destructive',
          onPress: async () => {
            await deletePeer(contact.peerId);
            await refreshContacts();
          },
        },
      ]
    );
  };

  const startCallWith = async (withVideo) => {
    if (inCallRef.current || ringStateRef.current) return;
    inCallRef.current = true;
    callVideoRef.current = withVideo;
    rtcActiveRef.current = false;
    rtcNegotiatingRef.current = false;
    setAudioEngine(null);
    setRtcLog([]);

    // ما منفتح كاميرا ولا ميكروفون هون — منستنى الطرف الآخر يرد.
    // بنعرض شاشة "جاري الاتصال" لحد ما يقبل أو يرفض أو تنتهي المهلة.
    if (mountedRef.current) setRingState('outgoing');

    const myIp = await DirectConnection.getLocalIpAddress().catch(() => null);
    sendSignalingMessage({ type: 'call-request', ip: myIp, video: withVideo });

    // ما رد خلال ٤٥ ثانية → إلغاء
    if (ringTimeoutRef.current) clearTimeout(ringTimeoutRef.current);
    ringTimeoutRef.current = setTimeout(() => {
      if (!ringStateRef.current && !inCallRef.current) return;
      stopRingtone().catch(() => {});
      sendSignalingMessage({ type: 'call-cancel' });
      inCallRef.current = false;
      if (mountedRef.current) setRingState(null);
      addMessage({
        sender: 'me', type: 'call',
        callKind: withVideo ? 'video' : 'voice',
        callResult: 'noanswer',
      });
    }, 45000);
  };

  /** إلغاء مكالمة صادرة قبل ما يرد الطرف الآخر */
  const cancelOutgoingCall = () => {
    stopRingtone().catch(() => {});
    if (ringTimeoutRef.current) { clearTimeout(ringTimeoutRef.current); ringTimeoutRef.current = null; }
    sendSignalingMessage({ type: 'call-cancel' });
    inCallRef.current = false;
    if (mountedRef.current) setRingState(null);
    addMessage({
      sender: 'me', type: 'call',
      callKind: callVideoRef.current ? 'video' : 'voice',
      callResult: 'cancelled',
    });
  };

  const startVideoCall = () => startCallWith(true);
  const startVoiceCall = () => startCallWith(false);

  const endCall = () => {
    sendSignalingMessage({ type: 'call-end' });
    endCallLocal();
  };

  const disconnectAll = async () => {
    if (disconnectingRef.current || stateRef.current === States.DISCONNECTING) return;

    stateRef.current = States.DISCONNECTING;
    if (mountedRef.current) {
      setState(States.DISCONNECTING);
      setStatusText('جاري إبلاغ الجهاز الآخر بإنهاء الاتصال…');
    }

    const ack = new Promise(resolve => {
      disconnectAckRef.current = resolve;
      disconnectAckTimerRef.current = setTimeout(() => {
        disconnectAckTimerRef.current = null;
        if (disconnectAckRef.current === resolve) disconnectAckRef.current = null;
        resolve(false);
      }, 1500);
    });
    const sent = sendSignalingMessage({ type: 'disconnect-request' });
    if (sent) {
      await ack;
    } else {
      if (disconnectAckTimerRef.current) clearTimeout(disconnectAckTimerRef.current);
      disconnectAckTimerRef.current = null;
      disconnectAckRef.current = null;
    }

    await finishWifiDisconnect();
  };

  const sendMsg = (text) => {
    const sent = sendSignalingMessage({ type: 'chat', text });
    addMessage({ sender: 'me', type: 'text', text, status: sent ? 'sent' : 'failed' });
  };

  /**
   * يبدأ صوت المكالمة: WebRTC أولاً (فيها إلغاء صدى حقيقي AEC3)،
   * وإذا فشلت أو تأخرت بيرجع تلقائياً للنظام القديم.
   */
  /**
   * بدء صوت المكالمة عبر WebRTC — المصدر الوحيد للصوت.
   * المحرك القديم انحذف نهائياً: كان يضاعف مسارات الإغلاق
   * وبيسبب تعارض ملكية الميكروفون.
   */
  const beginAudio = async ({ asCaller, offerSdp }) => {
    const useSpeaker = !!callVideoRef.current;

    if (!RTCAudio.isWebRTCAvailable()) {
      rtcDiagRef.current = 'WebRTC غير متاح';
      if (mountedRef.current) setAudioEngine('failed');
      return;
    }

    // تهيئة بيئة الصوت قبل ما تمسك WebRTC الميكروفون
    await startAudioSession(useSpeaker);

    rtcNegotiatingRef.current = true;

    try {
      const common = {
        signalSender: (m) => sendSignalingMessage(m),
        onFailure: (reason) => {
          rtcNegotiatingRef.current = false;
          rtcDiagRef.current = reason || 'سبب غير معروف';
          if (mountedRef.current) {
            setRtcLog(prev => [...prev.slice(-9), `✗ ${reason}`]);
            setAudioEngine('failed');
          }
        },
        onDiagnostic: (msg) => {
          rtcDiagRef.current = msg;
          if (mountedRef.current) {
            setRtcLog(prev => [...prev.slice(-9), `${new Date().toLocaleTimeString()} ${msg}`]);
          }
        },
        onState: (state) => {
          if (state === 'connected') {
            rtcActiveRef.current = true;
            rtcNegotiatingRef.current = false;
            if (mountedRef.current) setAudioEngine('webrtc');
          }
        },
      };

      if (asCaller) {
        await RTCAudio.startAsCaller(common);
      } else {
        await RTCAudio.startAsCallee({ ...common, offerSdp });
      }
    } catch (e) {
      rtcNegotiatingRef.current = false;
      rtcDiagRef.current = e?.message;
      if (mountedRef.current) setAudioEngine('failed');
    }
  };

  // كل رسالة تُضاف تُحفظ فوراً بقاعدة البيانات، وتُشعر المستخدم لو كان بالخلفية
  const addMessage = (msg, notify) => {
    const withTime = { ...msg, time: msg.time || Date.now() };
    setMessages(prev => [...prev, withTime]);
    if (peerIdRef.current) saveMessage(peerIdRef.current, withTime);
    if (notify) markUnreadIfChatHidden();
    if (notify && !appActiveRef.current) {
      const body =
        withTime.type === 'text' ? withTime.text :
        withTime.type === 'voice' ? 'رسالة صوتية' :
        withTime.type === 'image' ? 'صورة' :
        `ملف: ${withTime.fileName || ''}`;
      showMessageNotification(peerNameLabel, body);
    }
  };

  const newTransferId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // مسار موحّد لكل أنواع الإرسال (ملف / صورة / تطبيق / تسجيل صوتي)
  const sendAsset = async ({ uri, name, mimeType, size, kind, localUri }) => {
    // Legacy address is fallback only. FileShare resolves the live signaling
    // socket first, so an inbound/passive peer can send even if peerIpRef was
    // never populated and a stale P2P address cannot override the live route.
    const peerIp = peerIpRef.current || null;

    const transferId = newTransferId();
    setMessages(prev => [...prev, {
      sender: 'me',
      type: kind === 'app' ? 'file' : kind,
      fileName: name,
      mimeType,
      size,
      localUri: localUri || null,
      path: uri,
      isApp: kind === 'app',
      transferId,
      progress: 0,
      status: 'sending',
      time: Date.now(),
    }]);

    activeTransfersRef.current++;
    try {
      await sendFileNative(peerIp, uri, transferId, kind);
    } finally {
      activeTransfersRef.current = Math.max(0, activeTransfersRef.current - 1);
    }
  };

  const handlePickFile = async () => {
    try {
      const picked = await pickFile();
      const files = Array.isArray(picked) ? picked : [picked];
      if (!files.length) return;

      // طابور: منبعتهم واحد ورا التاني عشان ما نزاحم الشبكة
      for (const f of files) {
        const isImage = (f.mimeType || '').startsWith('image/');
        try {
          await sendAsset({
            uri: f.uri, name: f.name, mimeType: f.mimeType,
            size: f.size, kind: isImage ? 'image' : 'file',
            localUri: isImage ? f.uri : null,
          });
        } catch (e) {
          Alert.alert('تعذّر إرسال ملف', `${f.name}: ${e?.message || ''}`);
        }
      }
    } catch (e) {
      if (e?.code !== 'CANCELLED') Alert.alert('تعذّر إرسال الملفات', e?.message || '');
    }
  };

  // التقاط صورة من داخل التطبيق وإرسالها فوراً
  const handleCaptureImage = async () => {
    try {
      const shot = await captureImage();
      await sendAsset({
        uri: shot.uri, name: shot.name, mimeType: shot.mimeType,
        size: shot.size, kind: 'image', localUri: 'file://' + shot.uri,
      });
    } catch (e) {
      if (e?.code !== 'CANCELLED') Alert.alert('تعذّر التقاط الصورة', e?.message || '');
    }
  };

  // إرسال تطبيق مثبّت متل ShareIt — باسم صحيح ومع حزمه المقسّمة
  const handleSendApp = async (app) => {
    try {
      // الوحدة الأصلية بترجّع مسار جاهز: إما APK مفرد باسم التطبيق،
      // أو أرشيف .apks بيضم base مع كل ملفات split. إرسال base وحده كان
      // بيعطي "غير متوافق مع جهازك" لأن الموارد بتكون ناقصة.
      const packed = await packageAppForSending(app.packageName);
      await sendAsset({
        uri: packed.path,
        name: packed.fileName,
        mimeType: packed.mimeType,
        size: packed.size,
        kind: 'app',
      });
      if (packed.bundled) {
        Alert.alert(
          'تطبيق بحزم متعددة',
          `"${app.appName}" مقسّم لـ ${packed.splitCount + 1} ملفات، وبعتناه كأرشيف واحد. الطرف الآخر بيضغط عليه ليثبّته مباشرةً من داخل التطبيق.`
        );
      }
    } catch (e) {
      Alert.alert('تعذّر إرسال التطبيق', e?.message || '');
    }
  };

  const loadInstalledApps = () => listInstalledApps();

  // فتح ملف مستلم — والتطبيقات بتروح لمثبّت الحزم بدل النية العادية
  const handleOpenFile = async (item) => {
    const target = item.path || item.localUri;
    if (!target) { Alert.alert('الملف غير متاح بعد'); return; }
    const clean = target.replace('file://', '');
    const name = (item.fileName || '').toLowerCase();
    const isAppPackage =
      name.endsWith('.apk') || name.endsWith('.apks') ||
      item.mimeType === 'application/vnd.android.package-archive';

    if (isAppPackage) {
      Alert.alert(
        'تثبيت التطبيق',
        `هل تريد تثبيت "${item.fileName}"؟`,
        [
          { text: 'إلغاء', style: 'cancel' },
          {
            text: 'تثبيت',
            onPress: async () => {
              try {
                // PackageInstaller بيركّب base مع كل الحزم المقسّمة دفعة واحدة،
                // فما بتظهر رسالة "غير متوافق مع جهازك"
                await installApp(clean);
              } catch (e) {
                Alert.alert('تعذّر بدء التثبيت', e?.message || '');
              }
            },
          },
        ]
      );
      return;
    }

    try {
      await openReceivedFile(clean, item.mimeType || '*/*');
    } catch (e) {
      Alert.alert('تعذّر فتح الملف', e?.message || 'لا يوجد تطبيق يستطيع فتح هذا النوع');
    }
  };

  const handleStartRecording = async () => {
    try {
      await startVoiceRecording();
      if (mountedRef.current) setIsRecording(true);
    } catch (e) {
      Alert.alert('تعذّر بدء التسجيل', e?.message || '');
    }
  };

  const handleStopRecording = async () => {
    if (!isRecording) return;
    setIsRecording(false);
    try {
      const rec = await stopVoiceRecording();
      if (!rec?.path) return;
      await sendAsset({
        uri: rec.path, name: 'voice.m4a', mimeType: 'audio/mp4',
        size: rec.size, kind: 'voice',
      });
    } catch (e) {
      Alert.alert('تعذّر إرسال التسجيل', e?.message || '');
    }
  };

  const handleSwitchCamera = async () => {
    try { await switchCamera(); }
    catch (e) { Alert.alert('تعذّر تبديل الكاميرا', e?.message || ''); }
  };

  const toggleCamera = () => {
    cameraOnRef.current = !cameraOnRef.current;
    if (!cameraOnRef.current && mountedRef.current) setLocalFrame(null);
    return cameraOnRef.current;
  };

  const peerNameLabel = peerDisplayName || btPeerName || 'الجهاز الآخر';

  const mutedRef = useRef(false);
  const toggleMute = () => {
    mutedRef.current = !mutedRef.current;
    // نكتم المحرك الشغّال — WebRTC أو النظام القديم
    RTCAudio.setMicMuted(mutedRef.current);
    return mutedRef.current;
  };

  return (
    <ThemeProvider>
    <View style={{flex:1}}>
      <Modal visible={showProbe} animationType="slide" onRequestClose={() => setShowProbe(false)}>
        <RtcProbeScreen onClose={() => setShowProbe(false)} />
      </Modal>

      {(
        [States.IDLE, States.DISCONNECTED, States.ERROR].includes(state) ||
        (state === States.CONNECTED && !chatVisible && !inCall && !ringState)
      ) && (
        <ContactsScreen
          peers={contacts}
          discovered={discovered}
          scanning={scanning}
          onRefresh={scanForDevices}
          onScanNew={scanForDevices}
          onOpenChat={connectToContact}
          onConnectLan={handleConnectLan}
          localIp={localIp}
          btDevices={btDevices}
          onSelectBtDevice={btConnect}
          deviceName={identityRef.current?.deviceName}
          wifiDirectEnabled={wifiEnabled}
          statusText={statusText}
          activePeer={state === States.CONNECTED ? activePeer : null}
          unreadCount={unreadCount}
        />
      )}
      {state === States.DISCOVERING && (
        <IdleScreen
          status={showCreateGroup ? 'لم يتم العثور على جهاز قريب بعد. يمكنك إنشاء مجموعة والانتظار.' : 'جاري البحث عن أجهزة قريبة...'}
          onOpenProbe={() => setShowProbe(true)}
          busy={[States.DISCOVERING, States.WIFI_CONNECTING].includes(state)}
          wifiDirectEnabled={wifiEnabled} showCreateGroup={showCreateGroup} onCreateGroup={createGroup}
          activeTier={activeTier} btDevices={btDevices} onBtScan={btScan} onBtConnect={btConnect} btScanning={btScanning}
        />
      )}
      {[States.WIFI_CONNECTING, States.BT_CONNECTING, States.DISCONNECTING].includes(state) && (
        <IdleScreen
          status={statusText || (
            state === States.DISCONNECTING
              ? 'جاري إنهاء الاتصال…'
              : state === States.WIFI_CONNECTING
                ? 'جاري الاتصال...'
                : 'جاري الاتصال عبر البلوتوث...'
          )}
          busy
          wifiDirectEnabled={wifiEnabled} activeTier={activeTier}
          btDevices={btDevices} onBtScan={btScan} onBtConnect={btConnect} btScanning={btScanning}
        />
      )}
      {state === States.CONNECTED && chatVisible && !inCall && !ringState && (
        <ChatScreen
          messages={messages} onSendMessage={sendMsg}
          onStartVideoCall={startVideoCall} onStartVoiceCall={startVoiceCall}
          onBack={() => setChatOpen(false)} onDisconnect={disconnectAll}
          onPickFile={handlePickFile} activeTier={activeTier}
          isRecording={isRecording} onStartRecording={handleStartRecording} onStopRecording={handleStopRecording}
          peerName={peerNameLabel}
          onCaptureImage={handleCaptureImage} onLoadApps={loadInstalledApps}
          onSendApp={handleSendApp} onOpenFile={handleOpenFile}
          onOpenProbe={() => setShowProbe(true)}
        />
      )}
      {state === States.CONNECTED && ringState === 'incoming' && (
        <IncomingCallScreen
          peerName={peerNameLabel}
          isVideo={!!pendingCallRef.current?.video}
          onAccept={acceptIncomingCall}
          onReject={rejectIncomingCall}
        />
      )}
      {state === States.CONNECTED && ringState === 'outgoing' && (
        <IncomingCallScreen
          peerName={peerNameLabel}
          isVideo={!!callVideoRef.current}
          outgoing
          onReject={cancelOutgoingCall}
        />
      )}
      {state === States.CONNECTED && inCall && !ringState && (
        <CallScreen
          localFrame={localFrame} remoteFrame={remoteFrame} messages={messages}
          onSendMessage={sendMsg} onToggleCamera={toggleCamera} onToggleMute={toggleMute}
          onSwitchCamera={handleSwitchCamera} onEndCall={endCall}
          onToggleSpeaker={(on) => setSpeakerphone(on).catch(() => {})}
          onSetVolume={(f) => setCallVolume(f).catch(() => {})}
          peerName={peerNameLabel} videoEnabled={callVideoRef.current}
          audioEngine={audioEngine} audioDiag={rtcDiagRef.current} rtcLog={rtcLog}
        />
      )}
      {state === States.BT_CONNECTED && (
        <BluetoothChatScreen
          messages={btMessages} onSendMessage={sendBtMsg} onEndChat={endBtChat} peerName={btPeerName}
        />
      )}
    </View>
    </ThemeProvider>
  );
}
