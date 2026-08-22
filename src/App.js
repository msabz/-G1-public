import { ThemeProvider } from './theme/themeContext';
import React, { useEffect, useState, useRef } from 'react';
import { View, Alert, AppState, Modal, NativeModules, NativeEventEmitter, PermissionsAndroid, Platform } from 'react-native';
import IdleScreen from './components/IdleScreen';
import ChatScreen from './components/ChatScreen';
import CallScreen from './components/CallScreen';
import RtcProbeScreen from './components/RtcProbeScreen';
import IncomingCallScreen from './components/IncomingCallScreen';
import ContactsScreen from './components/ContactsScreen';
import { States, Tiers } from './utils/stateMachine';
import {
  createSignalingServer, connectToSignalingServer, closeSignaling,
  setOnMessage, setOnDisconnect, sendSignalingMessage, waitForClientConnection,
  startPersistentListener, getSignalingHealth,
} from './webrtc/signaling';
import { lanDiscovery } from './network/LanDiscovery';
import { peerRegistry, TRANSPORTS } from './network/PeerRegistry';
import { connectionCoordinator } from './network/ConnectionCoordinator';
import { connectP2pFromApp, resolveStableP2pDeviceId } from './network/p2pAppBridge';
import { resolveKnownLanTarget } from './network/knownLanTarget';
import { setLanPassiveAdmissionContextProvider } from './network/LanPassiveAdmission';
import {
  getPassiveLanPromotionPlan,
  isKnownLanRaceWinner,
  mergePeerMessageHistory,
} from './network/passiveLanAppPolicy';
import { CONTROL_PLANE_OWNERS, getSessionDisconnectPlan } from './network/sessionDisconnectPlan';
import { TransferActivityGate } from './network/transferActivityGate';
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
import { startVoiceRecording, stopVoiceRecording, startRingback, stopRingtone } from './media/AudioClip';
import { installApp, onInstallResult } from './media/AppInstaller';
import {
  saveMessage, loadMessages, savePeer, savePeerAddress, savePeerBluetoothAddress, deletePeer,
  listPeers, getDeviceIdentity, deleteMessageLocal, clearMessages,
  listCallRecords, deleteCallRecord, clearCallHistory, updateMessageStatus,
} from './services/Persistence';
import {
  createIncomingTextMessage,
  createOutgoingTextMessage,
  ensureMessageIdentity,
  removeMessageById,
} from './messaging/messageModel';
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
import {
  BT,
  bluetoothTransport,
  onBtConnected,
  onBtDisconnected,
  onBtMessage,
  onBtDeviceFound,
  onBtDiscoveryFinished,
  onBtReconnecting,
  onBtError,
} from './bluetooth/BluetoothManager';
import {
  CALL_STATES,
  answerIncomingCall as answerRuntimeCall,
  beginOutgoingCall,
  declineIncomingCall as declineRuntimeCall,
  endCall as endRuntimeCall,
  failCall as failRuntimeCall,
  getActiveCall,
  markCallActive,
  registerCallUiController,
  subscribeToCallState,
  waitForCallRuntimeIdle,
} from './services/CallRuntime';

const DirectConnection = NativeModules.DirectConnectionModule;
const emitter = new NativeEventEmitter(DirectConnection);
const PORT = 8089;
const DISC_TIMEOUT = 10000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const CALL_CONTROL_TYPES = new Set([
  'call-ringing',
  'call-accept',
  'call-connected',
  'call-active',
  'call-reject',
  'call-busy',
  'call-missed',
  'call-cancel',
  'call-failed',
  'call-end',
]);
const TERMINAL_CALL_STATES = new Set([
  CALL_STATES.DECLINED,
  CALL_STATES.BUSY,
  CALL_STATES.MISSED,
  CALL_STATES.FAILED,
  CALL_STATES.ENDED,
]);

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
  const [isRecording, setIsRecording] = useState(false);
  const [localIp, setLocalIp] = useState("127.0.0.1");

  useEffect(() => {
    setLanPassiveAdmissionContextProvider(() => ({
      uiMounted: mountedRef.current,
      appState: stateRef.current,
      pendingKnownLanPeerId: pendingKnownLanPeerIdRef.current,
    }));

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
    if (coordinatorP2pAttemptRef.current) {
      setStatusText('محاولة اتصال Wi-Fi Direct جارية بالفعل…');
      return false;
    }
    let connectedHere = false;
    try {
      const identity = identityRef.current || await getDeviceIdentity().catch(() => null);
      if (!identity?.deviceId) throw new Error('تعذّر تحميل هوية G1 الثابتة');
      identityRef.current = identity;

      setStatusText(`جاري الاتصال بـ ${ip}:${port} عبر الشبكة المحلية...`);
      stateRef.current = States.WIFI_CONNECTING;
      setState(States.WIFI_CONNECTING);
      await connectToSignalingServer(ip, port, 5, 800);
      connectedHere = true;

      if (!mountedRef.current || disconnectingRef.current || !signalingIsHealthy()) {
        throw new Error('أُلغيت محاولة LAN قبل تفعيل الجلسة');
      }
      const identitySent = sendSignalingMessage({
        type: 'identity',
        deviceId: identity.deviceId,
        deviceName: identity.deviceName || 'DirectChat Device',
      });
      if (!identitySent || !signalingIsHealthy()) {
        throw new Error('فشل تبادل هوية G1 عبر LAN');
      }

      peerIpRef.current = ip;
      activeTransportRef.current = TRANSPORTS.LAN;
      activeControlOwnerRef.current = CONTROL_PLANE_OWNERS.LEGACY_APP;
      const peer = {
        host: ip,
        port,
        deviceName: `LAN (${ip})`,
        customName: `LAN (${ip})`,
        transport: 'lan',
        connected: true,
      };
      setActivePeerInfo(peer);
      setPeerDisplayName(`LAN (${ip})`);
      startTransferServer().catch(() => {});
      ensureMicGuard();
      stateRef.current = States.CONNECTED;
      setState(States.CONNECTED);
      setActiveTier(Tiers.LAN);
      setChatOpen(true);
      setStatusText(`متصل عبر الشبكة المحلية (${ip})`);
    } catch (e) {
      console.warn('LAN connection error:', e);
      if (connectedHere) closeSignaling();
      activeTransportRef.current = null;
      activeControlOwnerRef.current = null;
      peerIpRef.current = null;
      stateRef.current = States.IDLE;
      setState(States.IDLE);
      setActiveTier(Tiers.NONE);
      setStatusText('فشل الاتصال بالـ IP');
      Alert.alert('فشل الاتصال عبر الشبكة المحلية', `تعذر الاتصال بـ ${ip}:${port}.\nتأكد أن التطبيق مفتوح على الجهاز الآخر وأنهما على نفس شبكة الواي فاي.`);
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
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
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
  const [callRecords, setCallRecords] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [scanning, setScanning] = useState(false);
  const discoveredRef = useRef({});
  const contactsRef = useRef([]);
  const targetPeerRef = useRef(null);
  const pendingKnownLanPeerIdRef = useRef(null);
  const coordinatorP2pAttemptRef = useRef(null);
  const connectionAddressTrackerRef = useRef(createConnectionAddressTracker());
  const rtcNegotiatingRef = useRef(false);
  const rtcNegotiatingCallIdRef = useRef(null);
  const inCallRef = useRef(false);
  const callVideoRef = useRef(true);
  const peerIpRef = useRef(null);
  const transferActivityGateRef = useRef(new TransferActivityGate());
  const activeTransportRef = useRef(null);
  const activeControlOwnerRef = useRef(null);
  const peerIdRef = useRef(null);
  const identityRef = useRef(null);
  const appActiveRef = useRef(true);
  const reconnectAttemptRef = useRef(0);
  const lastConnectionRef = useRef(null);
  const micGuardRef = useRef(null);
  const pendingCallRef = useRef(null);
  const activeCallIdRef = useRef(null);
  const ringbackCallIdRef = useRef(null);
  const callStartLockRef = useRef(false);
  const callChatLoggedRef = useRef(null);
  const bluetoothPendingPeerRef = useRef(null);
  const bluetoothActivationRef = useRef(null);
  const bluetoothLegacyHandoverRef = useRef(null);
  const pendingBluetoothIdentityRef = useRef(null);
  const automaticFailoverCountRef = useRef(0);
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

  const runReleasedTerminalTask = task => {
    if (typeof task !== 'function') return;
    Promise.resolve()
      .then(task)
      .catch(error => console.warn('[App] deferred terminal cleanup failed:', error?.message || error));
  };

  const releaseTransferActivity = key => {
    runReleasedTerminalTask(transferActivityGateRef.current.end(key));
  };

  const ensureMicGuard = () => {
    if (micGuardRef.current) clearInterval(micGuardRef.current);
    micGuardRef.current = setInterval(() => {
      reportLiveAudio(RTCAudio.hasLiveAudio());
    }, 3000);
  };

  const signalingIsHealthy = () => {
    try {
      return getSignalingHealth()?.connected === true;
    } catch (e) {
      return false;
    }
  };

  const resetActiveSessionUi = ({ clearMessages = true } = {}) => {
    chatVisibleRef.current = false;
    activePeerRef.current = null;
    targetPeerRef.current = null;
    connectionAddressTrackerRef.current.clear();
    peerIdRef.current = null;
    peerIpRef.current = null;
    lastConnectionRef.current = null;
    activeTransportRef.current = null;
    activeControlOwnerRef.current = null;
    transferActivityGateRef.current.reset();
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
    requestWifiDirectPerms().then(async granted => {
      if (!granted) {
        if (mountedRef.current) {
          setStatusText('اسمح لـ G1 بالوصول إلى الأجهزة القريبة لتفعيل Wi-Fi Direct.');
        }
        return;
      }

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
    }).finally(() => {
      // حافظ على طلبات الوسائط/البلوتوث القديمة، لكن نتيجتها لا تملك قرار
      // تشغيل Wi-Fi Direct. رفض الكاميرا أو الميكروفون لا يجعل P2P يختفي.
      requestPerms().catch(() => false);
    });

    setOnMessage(async (msg) => {
      if (msg.type === 'frame') {
        if (mountedRef.current) setRemoteFrame(msg.data);
      } else if (msg.type === 'call-request') {
        // BackgroundRuntime is the single signaling owner and receives every
        // frame before this UI callback. App only mirrors the correlated state.
        const call = getActiveCall();
        if (call && (!msg.callId || call.callId === msg.callId)) {
          activeCallIdRef.current = call?.callId || msg.callId || null;
          pendingCallRef.current = {
            callId: activeCallIdRef.current,
            video: !!call?.video,
            ip: msg.ip || call?.ip || null,
          };
          if (msg.ip) peerIpRef.current = msg.ip;
          if (mountedRef.current) setRingState('incoming');
        }
      } else if (CALL_CONTROL_TYPES.has(msg.type)) {
        if (msg.ip) peerIpRef.current = msg.ip;
        const call = getActiveCall();
        if (
          msg.type === 'call-ringing' &&
          !!msg.callId &&
          call?.callId === msg.callId &&
          call.direction === 'outgoing' &&
          ringbackCallIdRef.current !== msg.callId
        ) {
          ringbackCallIdRef.current = msg.callId;
          startRingback().catch(() => {});
        }

      // ===== إشارات WebRTC (بتمرق على نفس قناة التحكم) =====
      //
      // مهم للخصوصية: كل إشارة لازم تتأكد إن في مكالمة قائمة فعلاً.
      // بدون هالفحص، أي عرض متأخر أو إعادة تشغيل بتوصل بعد إنهاء المكالمة
      // كانت تفتح الميكروفون من جديد بدون أي شاشة مكالمة — فيصير الطرف
      // الآخر يسمعك وأنت مش عارف.
      } else if (msg.type === 'rtc-offer') {
        const call = getActiveCall();
        const matchesActiveCall = !!msg.callId && call?.callId === msg.callId &&
          !TERMINAL_CALL_STATES.has(call.state);
        if (!matchesActiveCall || ![CALL_STATES.CONNECTING, CALL_STATES.ACTIVE].includes(call.state)) {
          return;
        }

        // قبول الإشعار قد يسبق إعادة ربط React. عندها CallRuntime هو مصدر
        // الحقيقة، ولا نرفض العرض الصحيح لمجرد أن ref الواجهة لم يُحدّث بعد.
        activeCallIdRef.current = call.callId;
        inCallRef.current = true;
        callVideoRef.current = call.mediaType === 'video' || call.video === true;
        if (msg.restart && RTCAudio.hasActivePeer()) {
          RTCAudio.handleRestartOffer(msg.sdp).catch(() => {});
        } else if (
          !RTCAudio.hasActivePeer() &&
          rtcNegotiatingCallIdRef.current !== call.callId
        ) {
          beginAudio({ asCaller: false, offerSdp: msg.sdp, callId: call.callId });
        }
      } else if (msg.type === 'rtc-answer') {
        const call = getActiveCall();
        if (
          !!msg.callId &&
          call?.callId === msg.callId &&
          !TERMINAL_CALL_STATES.has(call.state) &&
          rtcNegotiatingCallIdRef.current === call.callId
        ) {
          RTCAudio.acceptAnswer(msg.sdp).catch(() => {});
        }
      } else if (msg.type === 'rtc-ice') {
        const call = getActiveCall();
        if (
          !!msg.callId &&
          call?.callId === msg.callId &&
          !TERMINAL_CALL_STATES.has(call.state)
        ) {
          RTCAudio.addRemoteCandidate(msg.candidate).catch(() => {});
        }
      } else if (msg.type === 'ping') {
        // نبضة إبقاء القناة حيّة — ما بتحتاج أي إجراء
      } else if (msg.type === 'identity') {
        // تبادل الهوية: منعرف مين الطرف الآخر ومنحمّل محادثته المحفوظة
        if (msg.deviceId) {
          const coordinatorStatus = connectionCoordinator.getCoordinatorStatus();
          const signalingHealth = getSignalingHealth();
          const promotionPlan = getPassiveLanPromotionPlan({
            message: msg,
            appState: stateRef.current,
            uiMounted: mountedRef.current,
            pendingKnownLanPeerId: pendingKnownLanPeerIdRef.current,
            coordinatorStatus,
            signalingHealth,
          });
          const currentTarget = targetPeerRef.current;
          const matchingTarget = currentTarget && (
            currentTarget.peerId === msg.deviceId ||
            currentTarget.deviceId === msg.deviceId
          ) ? currentTarget : null;
          const savedContact = contactsRef.current.find(contact => (
            contact.peerId === msg.deviceId || contact.deviceId === msg.deviceId
          )) || null;
          const selected = matchingTarget || savedContact || coordinatorStatus.peer || {};
          const displayName =
            selected.customName || selected.name || msg.deviceName ||
            selected.deviceName || coordinatorStatus.peer?.deviceName || 'الجهاز الآخر';

          peerIdRef.current = msg.deviceId;
          connectionAddressTrackerRef.current.setIdentity({
            peerId: msg.deviceId,
            deviceName: msg.deviceName || selected.name || selected.deviceName || '',
            targetPeer: selected,
          });

          if (promotionPlan && mountedRef.current) {
            peerIpRef.current = promotionPlan.host;
            activeTransportRef.current = TRANSPORTS.LAN;
            activeControlOwnerRef.current = CONTROL_PLANE_OWNERS.COORDINATOR;
            targetPeerRef.current = selected;
            reconnectAttemptRef.current = 0;
            stateRef.current = States.CONNECTED;
            setState(States.CONNECTED);
            setActiveTier(Tiers.LAN);
            setStatusText('متصل عبر الشبكة المحلية');
            setPeerDisplayName(displayName);
            setChatOpen(true);
            startTransferServer().catch(() => {});
            ensureMicGuard();
            setActivePeerInfo({
              ...selected,
              deviceId: msg.deviceId,
              peerId: msg.deviceId,
              host: promotionPlan.host,
              port: selected?.transports?.[TRANSPORTS.LAN]?.port || selected?.port || PORT,
              name: displayName,
              transport: 'lan',
            });
          } else if (mountedRef.current) {
            setPeerDisplayName(displayName);
            setActivePeerInfo({
              ...selected,
              peerId: msg.deviceId,
              name: displayName,
            });
          }

          const sendReciprocalIdentity = localIdentity => {
            if (!localIdentity?.deviceId) return false;
            const currentCoordinatorStatus = connectionCoordinator.getCoordinatorStatus();
            const currentHealth = getSignalingHealth();
            if (!isKnownLanRaceWinner({
              targetDeviceId: msg.deviceId,
              coordinatorStatus: currentCoordinatorStatus,
              signalingHealth: currentHealth,
            })) {
              return false;
            }
            identityRef.current = localIdentity;
            return sendSignalingMessage({
              type: 'identity',
              deviceId: localIdentity.deviceId,
              deviceName: localIdentity.deviceName || 'DirectChat Device',
            });
          };

          if (isKnownLanRaceWinner({
            targetDeviceId: msg.deviceId,
            coordinatorStatus,
            signalingHealth,
          })) {
            if (identityRef.current) {
              sendReciprocalIdentity(identityRef.current);
            } else {
              getDeviceIdentity()
                .then(sendReciprocalIdentity)
                .catch(() => false);
            }
          }

          await savePeer(msg.deviceId, msg.deviceName || displayName, '');
          await saveResolvedPeerAddress(connectionAddressTrackerRef.current, savePeerAddress);
          const history = await loadMessages(msg.deviceId, 300);
          if (mountedRef.current) {
            const normalizedHistory = (history || []).map(h => ({ ...h, time: Number(h.time) }));
            setMessages(prev => (
              promotionPlan
                ? mergePeerMessageHistory(normalizedHistory, prev)
                : normalizedHistory
            ));
          }
          refreshContacts();
        }
      } else if (msg.type === 'my-ip') {
        if (msg.ip) peerIpRef.current = msg.ip;
      } else if (msg.type === 'chat') {
        const incoming = createIncomingTextMessage(msg);
        if (mountedRef.current && incoming) addMessage(incoming, true);
      } else if (msg.type === 'disconnect-ack') {
        const resolveAck = disconnectAckRef.current;
        disconnectAckRef.current = null;
        if (disconnectAckTimerRef.current) {
          clearTimeout(disconnectAckTimerRef.current);
          disconnectAckTimerRef.current = null;
        }
        if (resolveAck) resolveAck(true);
      } else if (msg.type === 'disconnect-request' || msg.type === 'hangup') {
        // نؤكد الاستلام أولاً، ثم ننهي الجلسة حسب النقل الفعلي بدلاً من
        // افتراض أن كل جلسة signaling هي Wi-Fi Direct.
        stateRef.current = States.DISCONNECTING;
        if (mountedRef.current) {
          setState(States.DISCONNECTING);
          setStatusText('طلب الجهاز الآخر إنهاء الاتصال — جاري إنهاء الجلسة…');
        }
        if (msg.type === 'disconnect-request') {
          sendSignalingMessage({ type: 'disconnect-ack' });
        }
        setTimeout(() => {
          finishCurrentTransportDisconnect({ remote: true }).catch(error => {
            console.warn('[App] remote disconnect cleanup failed:', error?.message || error);
          });
        }, 180);
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
      handleTerminalSignalingDisconnect();
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
        transferActivityGateRef.current.begin(`in:${id}`);
        if (!mountedRef.current) return;
        markUnreadIfChatHidden();
        if (kind === 'voice') {
          setMessages(prev => [...prev, ensureMessageIdentity({
            sender: 'remote', type: 'voice', transferId: id, progress: 0, size, time: Date.now(),
          })]);
        } else {
          setMessages(prev => [...prev, ensureMessageIdentity({
            sender: 'remote', type: kind === 'image' ? 'image' : 'file',
            fileName, mimeType, transferId: id, progress: 0, size, time: Date.now(),
          })]);
        }
      }),
      onIncomingDone(({ id, path, size, fileName, kind }) => {
        try {
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
        } finally {
          releaseTransferActivity(`in:${id}`);
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
      onTransferError(({ id, message, direction }) => {
        try {
          if (!mountedRef.current) return;
          setMessages(prev => prev.map(m => m.transferId === id ? { ...m, progress: 1, failed: true } : m));
          Alert.alert('تعذّر نقل الملف', message || '');
        } finally {
          if (direction === 'in') releaseTransferActivity(`in:${id}`);
        }
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
        handleBluetoothConnected(d).catch(error => {
          console.warn('[Bluetooth] activation failed:', error?.message || error);
        });
      }),
      onBtReconnecting(event => {
        if (!mountedRef.current || activeTransportRef.current !== TRANSPORTS.BLUETOOTH) return;
        stateRef.current = States.BT_CONNECTING;
        setState(States.BT_CONNECTING);
        setStatusText(`انقطع Bluetooth مؤقتًا — إعادة الاتصال ${event.attempt || 1}/${event.maxAttempts || 3}…`);
      }),
      onBtDisconnected(event => {
        if (activeTransportRef.current !== TRANSPORTS.BLUETOOTH) return;
        if (disconnectingRef.current || stateRef.current === States.DISCONNECTING) return;
        const failedPeer = snapshotActivePeerForFallback();
        if (peerIdRef.current) peerRegistry.setPeerDisconnected(peerIdRef.current);
        activeTransportRef.current = null;
        activeControlOwnerRef.current = null;
        bluetoothPendingPeerRef.current = null;
        if (!mountedRef.current) return;
        resetActiveSessionUi({ clearMessages: false });
        stateRef.current = States.DISCONNECTED;
        setState(States.DISCONNECTED);
        setActiveTier(Tiers.NONE);
        setStatusText(`تعذّرت إعادة اتصال Bluetooth${event?.reason ? `: ${event.reason}` : ''}`);
        if (event?.unexpected !== false) {
          Promise.resolve()
            .then(() => attemptAlternateTransport(failedPeer, TRANSPORTS.BLUETOOTH))
            .catch(error => {
              console.warn('[App] Bluetooth fallback failed:', error?.message || error);
            });
        }
      }),
      onBtMessage(message => {
        Promise.resolve(handleBluetoothMessage(message)).catch(error => {
          console.warn('[Bluetooth] message handling failed:', error?.message || error);
        });
      }),
      onBtError(event => {
        if (!mountedRef.current || event?.recoverable !== false) return;
        setStatusText(event?.message || 'خطأ Bluetooth غير قابل للاسترداد');
      }),
    ];
    return () => {
      mountedRef.current = false;
      appStateSub?.remove();
      subs.forEach(s => s.remove());
      // Root/Activity teardown is not an explicit disconnect. Keep signaling,
      // file server and the foreground availability service alive so removing
      // G1 from Recents does not make the peer go offline. Explicit disconnect
      // flows still call the transport-aware finish helpers.
    };
  // الاشتراكات الأصلية تُثبت مرة واحدة وتعتمد على refs للحالة الحية؛
  // إعادة إنشائها مع كل render تضاعف مستمعي المقابس وWi-Fi Direct.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function requestWifiDirectPerms() {
    const permission = Platform.Version >= 33
      ? PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES
      : PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
    try {
      if (await PermissionsAndroid.check(permission)) return true;
      const result = await PermissionsAndroid.request(permission);
      return result === PermissionsAndroid.RESULTS.GRANTED;
    } catch (e) {
      return false;
    }
  }

  async function requestBluetoothPerms() {
    const permissions = Platform.Version >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    try {
      const result = await PermissionsAndroid.requestMultiple(permissions);
      return permissions.every(permission => (
        result[permission] === PermissionsAndroid.RESULTS.GRANTED
      ));
    } catch (e) {
      return false;
    }
  }

  async function requestPerms() {
    const perms = [
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ...(Platform.Version >= 33
        ? [PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]),
      ...(Platform.Version >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          ]
        : []),
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
    if (!(await requestWifiDirectPerms())) { Alert.alert('إذن الأجهزة القريبة مطلوب للاتصال عبر Wi-Fi Direct'); return; }
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
  }

  const handlePeerConnected = async initialInfo => {
    if (!initialInfo?.groupFormed || disconnectingRef.current) return;
    const coordinatorStatus = connectionCoordinator.getCoordinatorStatus();
    if (
      coordinatorStatus.transport === TRANSPORTS.P2P &&
      (coordinatorStatus.state === 'CONNECTING' || coordinatorStatus.state === 'CONNECTED')
    ) {
      // Adapter/coordinator owns this group event; App must not open a second
      // signaling path for the same Wi-Fi Direct route.
      return;
    }
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
      ensureMicGuard();

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
      activeTransportRef.current = TRANSPORTS.P2P;
      activeControlOwnerRef.current = CONTROL_PLANE_OWNERS.LEGACY_APP;
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
      activeTransportRef.current = TRANSPORTS.P2P;
      activeControlOwnerRef.current = CONTROL_PLANE_OWNERS.LEGACY_APP;
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

  const handleTerminalSignalingDisconnect = () => {
    const plan = getSessionDisconnectPlan({
      transport: activeTransportRef.current,
      controlOwner: activeControlOwnerRef.current,
      unexpected: true,
    });

    const finalize = async () => {
      if (!mountedRef.current) return;
      if (disconnectingRef.current || stateRef.current !== States.CONNECTED) return;
      const coordinatorStatus = connectionCoordinator.getCoordinatorStatus();
      if (
        coordinatorStatus.state === 'CONNECTED' &&
        coordinatorStatus.transport === TRANSPORTS.BLUETOOTH
      ) {
        // make-before-break intentionally closes the former signaling socket
        // only after Bluetooth has been promoted.
        return;
      }
      if (signalingIsHealthy()) return;

      if (plan.attemptLegacyWifiDirectReconnect) {
        const recovered = await attemptReconnect();
        if (recovered || !mountedRef.current || signalingIsHealthy()) return;
      }

      const failedTransport = activeTransportRef.current;
      const failedPeer = snapshotActivePeerForFallback();
      const disconnected = await finishCurrentTransportDisconnect({ unexpected: true });
      if (disconnected) {
        await attemptAlternateTransport(failedPeer, failedTransport);
      }
    };

    if (plan.attemptLegacyWifiDirectReconnect) {
      if (disconnectGraceRef.current) clearTimeout(disconnectGraceRef.current);
      disconnectGraceRef.current = setTimeout(() => {
        disconnectGraceRef.current = null;
        if (!mountedRef.current || disconnectingRef.current || stateRef.current !== States.CONNECTED) return;
        if (signalingIsHealthy()) return;
        if (transferActivityGateRef.current.deferTerminal(finalize)) return;
        finalize().catch(error => {
          console.warn('[App] terminal P2P recovery failed:', error?.message || error);
        });
      }, 4000);
      return;
    }

    if (transferActivityGateRef.current.deferTerminal(finalize)) return;
    finalize().catch(error => {
      console.warn('[App] terminal signaling cleanup failed:', error?.message || error);
    });
  };

  function handlePeerDisconnected() {
    // أثناء الفصل المتعمّد، cleanupConnection هو مصدر الحقيقة وينتظر
    // requestGroupInfo؛ لا نسمح لبث متأخر بتغيير الحالة قبله.
    if (disconnectingRef.current || stateRef.current === States.DISCONNECTING) return;
    if (stateRef.current === States.CONNECTED) {
      if (activeTransportRef.current !== TRANSPORTS.P2P) {
        console.log('[Wi-Fi Direct] تجاهل بث انفصال P2P لأن النقل النشط ليس P2P');
        return;
      }
      if (activeControlOwnerRef.current === CONTROL_PLANE_OWNERS.COORDINATOR) {
        const failedPeer = snapshotActivePeerForFallback();
        finishCurrentTransportDisconnect({ unexpected: true })
          .then(disconnected => (
            disconnected
              ? attemptAlternateTransport(failedPeer, TRANSPORTS.P2P)
              : false
          ))
          .catch(error => {
            console.warn('[App] coordinator P2P disconnect cleanup failed:', error?.message || error);
          });
      } else {
        const failedPeer = snapshotActivePeerForFallback();
        finishWifiDisconnect({ unexpected: true })
          .then(disconnected => (
            disconnected
              ? attemptAlternateTransport(failedPeer, TRANSPORTS.P2P)
              : false
          ))
          .catch(error => {
            console.warn('[App] legacy P2P fallback failed:', error?.message || error);
          });
      }
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
    if (!(await requestBluetoothPerms())) {
      Alert.alert('إذن Bluetooth مطلوب', 'الاكتشاف والاتصال لا يحتاجان إذن الكاميرا أو الميكروفون.');
      return;
    }
    const supported = await BT.isSupported().catch(() => false);
    if (!supported) { Alert.alert('البلوتوث غير مدعوم على هذا الجهاز'); return; }
    const enabled = await BT.isEnabled().catch(() => false);
    if (!enabled) { await BT.requestEnable().catch(() => {}); return; }

    foundDevicesRef.current = {};
    setBtDevices([]);
    setBtScanning(true);
    await bluetoothTransport.discover({
      timeoutMs: 12000,
      requestDiscoverable: true,
      discoverableSeconds: 120,
    }).catch(error => {
      setBtScanning(false);
      Alert.alert('تعذّر اكتشاف أجهزة Bluetooth', error?.message || '');
    });
  };

  const buildBluetoothPeer = deviceOrAddress => {
    const device = typeof deviceOrAddress === 'string'
      ? (btDevices.find(item => item.address === deviceOrAddress) || { address: deviceOrAddress })
      : (deviceOrAddress || {});
    const address = String(device.address || device.btAddress || '').trim().toUpperCase();
    if (!address) throw new Error('عنوان Bluetooth غير متاح');

    const known = peerRegistry.getAllPeers().find(peer => (
      String(peer?.transports?.[TRANSPORTS.BLUETOOTH]?.address || '').toUpperCase() === address
    ));
    const savedContact = contactsRef.current.find(contact => (
      String(contact?.btAddress || '').trim().toUpperCase() === address
    ));
    const deviceId = known?.deviceId || savedContact?.peerId || savedContact?.deviceId ||
      `bluetooth:${address}`;
    peerRegistry.upsertBluetoothPeer({
      deviceId,
      deviceName: device.name || device.deviceName || savedContact?.customName ||
        savedContact?.name || known?.deviceName || 'Bluetooth Device',
      address,
      isOnline: true,
    });
    return peerRegistry.getPeer(deviceId);
  };

  const activateBluetoothUi = (peer, route = {}) => {
    const activation = (async () => {
      if (!peer?.deviceId || !mountedRef.current) return false;
      const address = route.address || peer.transports?.[TRANSPORTS.BLUETOOTH]?.address;
      const displayName = route.deviceName || peer.deviceName || 'Bluetooth Device';
      peerIdRef.current = peer.deviceId;
      peerIpRef.current = null;
      activeTransportRef.current = TRANSPORTS.BLUETOOTH;
      activeControlOwnerRef.current = CONTROL_PLANE_OWNERS.COORDINATOR;
      bluetoothPendingPeerRef.current = peer;
      // Do not expose the previous peer's messages while persistence resolves.
      // Bluetooth frames received during activation are merged below.
      messagesRef.current = [];
      setMessages([]);

      await savePeer(peer.deviceId, displayName, '');
      if (address) await savePeerBluetoothAddress(peer.deviceId, address, displayName);
      const history = await loadMessages(peer.deviceId, 300);
      if (!mountedRef.current || activeTransportRef.current !== TRANSPORTS.BLUETOOTH) return false;

      const normalizedHistory = (history || []).map(message => ({
        ...message,
        time: Number(message.time),
      }));
      const activationHistory = mergePeerMessageHistory(
        normalizedHistory,
        messagesRef.current,
      );
      messagesRef.current = activationHistory;
      setMessages(activationHistory);
      setBtPeerName(displayName);
      setPeerDisplayName(displayName);
      setActivePeerInfo({
        ...peer,
        peerId: peer.deviceId,
        deviceId: peer.deviceId,
        deviceAddress: address,
        btAddress: address,
        name: displayName,
        transport: 'bluetooth',
      });
      stateRef.current = States.CONNECTED;
      setState(States.CONNECTED);
      setActiveTier(Tiers.BLUETOOTH);
      setStatusText('متصل عبر Bluetooth');
      setChatOpen(true);
      refreshContacts();

      connectionCoordinator.sendMessage({
        type: 'identity',
        deviceId: identityRef.current?.deviceId,
        deviceName: identityRef.current?.deviceName || 'G1 Device',
      });
      return true;
    })();

    const trackedActivation = activation.finally(() => {
      if (bluetoothActivationRef.current === trackedActivation) {
        bluetoothActivationRef.current = null;
      }
      const pendingIdentity = pendingBluetoothIdentityRef.current;
      if (pendingIdentity && activeTransportRef.current === TRANSPORTS.BLUETOOTH) {
        pendingBluetoothIdentityRef.current = null;
        Promise.resolve(handleBluetoothMessage(pendingIdentity)).catch(error => {
          console.warn('[Bluetooth] deferred identity failed:', error?.message || error);
        });
      }
    });
    bluetoothActivationRef.current = trackedActivation;
    return trackedActivation;
  };

  const handleBluetoothConnected = async event => {
    const route = event?.route || event || {};
    const peer = bluetoothPendingPeerRef.current || buildBluetoothPeer({
      address: route.address,
      name: route.deviceName,
    });
    const status = connectionCoordinator.getCoordinatorStatus();
    const plannedLegacyHandover = bluetoothLegacyHandoverRef.current;
    const routeAddress = String(route.address || '').trim().toUpperCase();

    // Outgoing connects are promoted by btConnect after the coordinator's
    // pending attempt resolves. Incoming native sockets need to be adopted.
    if (status.state === 'CONNECTING' && status.transport === TRANSPORTS.BLUETOOTH) return false;
    if (status.pendingHandover?.token?.transport === TRANSPORTS.BLUETOOTH) return false;
    if (
      plannedLegacyHandover &&
      (!plannedLegacyHandover.address || plannedLegacyHandover.address === routeAddress)
    ) {
      return false;
    }
    if (
      (activeTransportRef.current && activeTransportRef.current !== TRANSPORTS.BLUETOOTH) ||
      (status.state === 'CONNECTED' && status.transport !== TRANSPORTS.BLUETOOTH)
    ) {
      // An unsolicited inbound RFCOMM socket must never replace a healthy IP
      // session behind the coordinator's back. Planned changes go exclusively
      // through handoverPeer(), which commits the candidate before break.
      await bluetoothTransport.disconnect().catch(() => false);
      return false;
    }
    try {
      if (!(status.state === 'CONNECTED' && status.transport === TRANSPORTS.BLUETOOTH)) {
        await connectionCoordinator.connectBluetoothPeer(peer, 8000, {
          adapterOptions: { autoReconnect: true, maxReconnectAttempts: 3 },
        });
      }
      return activateBluetoothUi(peer, route);
    } catch (error) {
      const current = connectionCoordinator.getCoordinatorStatus();
      if (!(current.state === 'CONNECTED' && current.transport === TRANSPORTS.BLUETOOTH)) {
        await bluetoothTransport.disconnect().catch(() => false);
      }
      throw error;
    }
  };

  const handleBluetoothMessage = async event => {
    if (!mountedRef.current) return;
    let message = event?.message;
    if (!message || typeof message !== 'object') {
      try { message = JSON.parse(event?.text || ''); } catch (e) {
        message = { type: 'chat', text: event?.text, time: Date.now() };
      }
    }
    if (message.type === 'identity') {
      const pendingActivation = bluetoothActivationRef.current;
      if (pendingActivation) await pendingActivation.catch(() => false);
      if (activeTransportRef.current !== TRANSPORTS.BLUETOOTH) {
        if (
          stateRef.current === States.BT_CONNECTING ||
          bluetoothLegacyHandoverRef.current
        ) {
          pendingBluetoothIdentityRef.current = event;
        }
        return;
      }
      const stableDeviceId = typeof message.deviceId === 'string' ? message.deviceId.trim() : '';
      const previousPeerId = peerIdRef.current;
      const address = event?.address || activePeerRef.current?.btAddress || activePeerRef.current?.deviceAddress;
      if (message.deviceName) {
        setBtPeerName(message.deviceName);
        setPeerDisplayName(message.deviceName);
        setActivePeerInfo({ name: message.deviceName, deviceName: message.deviceName });
      }
      if (stableDeviceId && stableDeviceId !== previousPeerId && stableDeviceId !== identityRef.current?.deviceId) {
        peerIdRef.current = stableDeviceId;
        peerRegistry.upsertBluetoothPeer({
          deviceId: stableDeviceId,
          deviceName: message.deviceName || btPeerName || 'Bluetooth Device',
          address,
          isOnline: true,
        });
        peerRegistry.setPeerConnected(stableDeviceId, TRANSPORTS.BLUETOOTH);
        const stablePeer = peerRegistry.getPeer(stableDeviceId);
        const coordinatorStatus = connectionCoordinator.getCoordinatorStatus();
        if (
          stablePeer &&
          coordinatorStatus.state === 'CONNECTED' &&
          coordinatorStatus.transport === TRANSPORTS.BLUETOOTH &&
          coordinatorStatus.peer?.deviceId === previousPeerId
        ) {
          connectionCoordinator.rebindConnectedPeer(stablePeer, {
            expectedDeviceId: previousPeerId,
          });
        }
        bluetoothPendingPeerRef.current = stablePeer;
        setActivePeerInfo({
          ...(stablePeer || {}),
          peerId: stableDeviceId,
          deviceId: stableDeviceId,
          deviceAddress: address,
          btAddress: address,
          transport: 'bluetooth',
          name: message.deviceName || btPeerName || 'Bluetooth Device',
        });

        // Preserve messages received before the stable app identity arrived,
        // then continue the session under the same peer used by LAN/P2P.
        const provisionalHistory = [...messagesRef.current];
        await Promise.all(provisionalHistory.map(item => saveMessage(stableDeviceId, item)));
        await savePeer(stableDeviceId, message.deviceName || btPeerName || 'Bluetooth Device', '');
        if (address) {
          await savePeerBluetoothAddress(
            stableDeviceId,
            address,
            message.deviceName || btPeerName || 'Bluetooth Device'
          );
        }
        const stableHistory = await loadMessages(stableDeviceId, 300);
        if (mountedRef.current && peerIdRef.current === stableDeviceId) {
          const mergedHistory = mergePeerMessageHistory(
            mergePeerMessageHistory(stableHistory || [], provisionalHistory),
            messagesRef.current,
          );
          messagesRef.current = mergedHistory;
          setMessages(mergedHistory);
        }
        if (previousPeerId?.startsWith('bluetooth:')) await deletePeer(previousPeerId);
      } else if (previousPeerId) {
        await savePeer(previousPeerId, message.deviceName || btPeerName || 'Bluetooth Device', '');
      }
      return;
    }
    if (message.type === 'chat') {
      const incoming = createIncomingTextMessage(message);
      if (incoming) addMessage(incoming, true);
      return;
    }
    if (message.type === 'disconnect-request' || message.type === 'hangup') {
      connectionCoordinator.sendMessage({ type: 'disconnect-ack' });
      finishCurrentTransportDisconnect({ remote: true }).catch(() => {});
      return;
    }
    if (message.type === 'disconnect-ack') {
      if (disconnectAckRef.current) {
        const resolve = disconnectAckRef.current;
        disconnectAckRef.current = null;
        resolve(true);
      }
      return;
    }
    if (message.type === 'call-request' || message.type === 'rtc-offer') {
      connectionCoordinator.sendMessage({
        type: 'call-failed',
        callId: message.callId,
        reason: 'Bluetooth does not expose an IP media route',
      });
      return;
    }
    if (message.type?.startsWith('call-') || message.type?.startsWith('rtc-')) {
      // Bluetooth is a text-only route. In particular, never answer an incoming
      // call-failed with another call-failed (which would create an endless loop).
      return;
    }
  };

  const releaseLegacyIpTransportForBluetooth = async transport => {
    const call = getActiveCall();
    if (call && !TERMINAL_CALL_STATES.has(call.state)) {
      endRuntimeCall(call.callId, { reason: 'transport-changed-to-bluetooth' });
    }
    endCallLocal();
    stopTransferServer().catch(() => {});
    stopConnectionService();
    if (micGuardRef.current) {
      clearInterval(micGuardRef.current);
      micGuardRef.current = null;
    }
    if (disconnectGraceRef.current) {
      clearTimeout(disconnectGraceRef.current);
      disconnectGraceRef.current = null;
    }
    closeSignaling();
    if (transport === TRANSPORTS.P2P) {
      const cleanup = await cleanupWifiDirect(10000).catch(error => ({
        clean: false,
        error: error?.message || String(error),
      }));
      if (cleanup?.clean !== true) {
        console.warn('[Bluetooth] previous Wi-Fi Direct group cleanup was not confirmed');
      }
    }
    peerIpRef.current = null;
    lastConnectionRef.current = null;
    activeTransportRef.current = null;
    activeControlOwnerRef.current = null;
    return true;
  };

  const btConnect = async deviceOrAddress => {
    if (coordinatorP2pAttemptRef.current) {
      setStatusText('محاولة اتصال Wi-Fi Direct جارية بالفعل…');
      return false;
    }
    let peer = null;
    let preparedLegacyCandidate = false;
    let releasedLegacyTransport = false;
    const previousTransport = activeTransportRef.current;
    try {
      peer = buildBluetoothPeer(deviceOrAddress);
      bluetoothPendingPeerRef.current = peer;
      stateRef.current = States.BT_CONNECTING;
      setState(States.BT_CONNECTING);
      setStatusText(`جاري الاتصال بـ ${peer.deviceName || 'الجهاز'} عبر Bluetooth…`);
      await bluetoothTransport.stopDiscovery().catch(() => {});
      const coordinatorStatus = connectionCoordinator.getCoordinatorStatus();
      let route;
      if (coordinatorStatus.state === 'CONNECTED') {
        const currentPeerId = coordinatorStatus.peer?.deviceId ||
          activePeerRef.current?.deviceId || activePeerRef.current?.peerId;
        if (currentPeerId !== peer.deviceId) {
          throw new Error('لا يمكن الانتقال إلى Bluetooth لجهاز مختلف قبل قطع الجلسة الحالية');
        }
        route = await connectionCoordinator.handoverPeer(peer, TRANSPORTS.BLUETOOTH, {
          timeoutMs: 8000,
          adapter: bluetoothTransport,
          adapterOptions: { autoReconnect: true, maxReconnectAttempts: 3 },
        });
      } else if (previousTransport && previousTransport !== TRANSPORTS.BLUETOOTH) {
        const currentPeerId = peerIdRef.current ||
          activePeerRef.current?.deviceId || activePeerRef.current?.peerId;
        if (currentPeerId !== peer.deviceId) {
          throw new Error('لا يمكن الانتقال إلى Bluetooth لجهاز مختلف قبل قطع الجلسة الحالية');
        }

        // Legacy LAN/P2P is not owned by ConnectionCoordinator. Prepare the
        // authenticated RFCOMM candidate first, then close the old IP route,
        // and finally let the coordinator adopt the already-connected socket.
        const address = String(
          peer.transports?.[TRANSPORTS.BLUETOOTH]?.address || peer.btAddress || ''
        ).trim().toUpperCase();
        bluetoothLegacyHandoverRef.current = { peerId: peer.deviceId, address };
        await bluetoothTransport.connectPeer(peer, {
          autoReconnect: true,
          maxReconnectAttempts: 3,
          timeoutMs: 8000,
        });
        preparedLegacyCandidate = true;
        await releaseLegacyIpTransportForBluetooth(previousTransport);
        releasedLegacyTransport = true;
        route = await connectionCoordinator.connectBluetoothPeer(peer, 8000, {
          adapterOptions: { autoReconnect: true, maxReconnectAttempts: 3 },
        });
      } else {
        const selection = await connectionCoordinator.connectPeer(peer, { maxAttempts: 1 });
        route = selection?.result || selection?.session || selection;
      }
      bluetoothLegacyHandoverRef.current = null;
      await activateBluetoothUi(peer, route);
      return true;
    } catch (e) {
      bluetoothLegacyHandoverRef.current = null;
      const currentStatus = connectionCoordinator.getCoordinatorStatus();
      if (
        preparedLegacyCandidate &&
        !(currentStatus.state === 'CONNECTED' && currentStatus.transport === TRANSPORTS.BLUETOOTH)
      ) {
        await bluetoothTransport.disconnect().catch(() => false);
      }
      bluetoothPendingPeerRef.current = null;
      Alert.alert('فشل الاتصال عبر البلوتوث', e?.message || '');
      const status = connectionCoordinator.getCoordinatorStatus();
      if (status.state === 'CONNECTED') {
        stateRef.current = States.CONNECTED;
        setState(States.CONNECTED);
        setActiveTier(
          status.transport === TRANSPORTS.LAN
            ? Tiers.LAN
            : status.transport === TRANSPORTS.BLUETOOTH
              ? Tiers.BLUETOOTH
              : Tiers.WIFI_DIRECT
        );
        setStatusText('فشل الانتقال إلى Bluetooth؛ بقي المسار السابق متصلًا.');
        setChatOpen(true);
      } else if (previousTransport && !releasedLegacyTransport) {
        stateRef.current = States.CONNECTED;
        setState(States.CONNECTED);
        setActiveTier(previousTransport === TRANSPORTS.LAN ? Tiers.LAN : Tiers.WIFI_DIRECT);
        setStatusText('فشل الانتقال إلى Bluetooth؛ بقي المسار السابق متصلًا.');
        setChatOpen(true);
      } else {
        if (releasedLegacyTransport) resetActiveSessionUi({ clearMessages: false });
        stateRef.current = States.IDLE;
        setState(States.IDLE);
        setActiveTier(Tiers.NONE);
      }
      return false;
    }
  };

  const endCallLocal = () => {
    stopRingtone().catch(() => {});
    ringbackCallIdRef.current = null;
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
    rtcNegotiatingCallIdRef.current = null;
    if (mountedRef.current) {
      setAudioEngine(null);
      setInCall(false);
      setLocalFrame(null);
      setRemoteFrame(null);
    }
  };

  const startAcceptedIncomingMedia = call => {
    if (!call || call.direction !== 'incoming') return false;
    activeCallIdRef.current = call.callId;
    inCallRef.current = true;
    callVideoRef.current = call.mediaType === 'video' || call.video === true;
    rtcActiveRef.current = false;
    rtcNegotiatingRef.current = false;
    rtcNegotiatingCallIdRef.current = null;
    pendingCallRef.current = null;

    if (mountedRef.current) {
      setRingState(null);
      setInCall(true);
      setAudioEngine(null);
      setRtcLog([]);
    }
    if (callVideoRef.current) {
      cameraOnRef.current = true;
      startCameraCapture().catch(() => {});
    }
    return true;
  };

  function cleanupSessionResources({ disconnectViaCoordinator = false } = {}) {
    connectionAttemptRef.current += 1;
    incomingInvitationRef.current = null;
    connectionAddressTrackerRef.current.clear();
    const activeCall = getActiveCall();
    if (activeCall && !TERMINAL_CALL_STATES.has(activeCall.state)) {
      endRuntimeCall(activeCall.callId, { reason: 'transport-disconnected', signal: false });
    }
    endCallLocal();
    if (disconnectViaCoordinator) {
      connectionCoordinator.disconnect();
    } else {
      closeSignaling();
    }
    stopTransferServer().catch(() => {});
    stopConnectionService();
    peerIpRef.current = null;
    transferActivityGateRef.current.reset();
    if (micGuardRef.current) { clearInterval(micGuardRef.current); micGuardRef.current = null; }
    if (disconnectGraceRef.current) { clearTimeout(disconnectGraceRef.current); disconnectGraceRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  }

  /** قبول المكالمة الواردة — هون فقط بينفتح الميكروفون */
  const acceptIncomingCall = async () => {
    const callId = pendingCallRef.current?.callId || activeCallIdRef.current;
    if (!callId) return false;
    return answerRuntimeCall(callId, { source: 'ui' });
  };

  /** رفض المكالمة الواردة — ما بينفتح ميكروفون إطلاقاً */
  const rejectIncomingCall = () => {
    const callId = pendingCallRef.current?.callId || activeCallIdRef.current;
    if (!callId) return false;
    return declineRuntimeCall(callId, { source: 'ui' });
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

    cleanupSessionResources({ disconnectViaCoordinator: false });
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

  const waitForCoordinatorP2pCleanup = async (timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const p2p = connectionCoordinator.getCoordinatorStatus()?.p2p;
      if (!p2p || (
        p2p.state === 'IDLE' &&
        !p2p.activeRoute &&
        !p2p.pendingPeerId
      )) {
        return true;
      }
      if (p2p.state === 'ERROR') return false;
      await delay(250);
    }
    return false;
  };

  const finishLogicalDisconnect = async ({
    remote = false,
    unexpected = false,
    disconnectViaCoordinator = false,
  } = {}) => {
    if (disconnectingRef.current) return false;
    disconnectingRef.current = true;
    connectionSetupRef.current = false;
    stateRef.current = States.DISCONNECTING;
    if (mountedRef.current) {
      setState(States.DISCONNECTING);
      setStatusText('جاري إنهاء الاتصال…');
    }

    const coordinatorOwnsP2p =
      disconnectViaCoordinator && activeTransportRef.current === TRANSPORTS.P2P;
    cleanupSessionResources({ disconnectViaCoordinator });

    if (coordinatorOwnsP2p) {
      const clean = await waitForCoordinatorP2pCleanup(10000);
      if (!clean) {
        if (mountedRef.current) {
          stateRef.current = States.ERROR;
          setState(States.ERROR);
          setStatusText('لم يؤكد منسق الاتصال تنظيف مسار Wi-Fi Direct خلال المهلة.');
        }
        disconnectingRef.current = false;
        return false;
      }
    }

    if (mountedRef.current) {
      resetActiveSessionUi({ clearMessages: !unexpected });
      setActiveTier(Tiers.NONE);
      if (unexpected) {
        stateRef.current = States.DISCONNECTED;
        setState(States.DISCONNECTED);
        setStatusText('انقطع الاتصال. يمكنك الاتصال مجدداً.');
      } else {
        stateRef.current = States.IDLE;
        setState(States.IDLE);
        setStatusText('');
      }
      if (remote) Alert.alert('أنهى الطرف الآخر الاتصال');
    }

    disconnectingRef.current = false;
    return true;
  };

  const finishCurrentTransportDisconnect = async ({ remote = false, unexpected = false } = {}) => {
    const plan = getSessionDisconnectPlan({
      transport: activeTransportRef.current,
      controlOwner: activeControlOwnerRef.current,
      unexpected,
    });

    if (plan.cleanupWifiDirect && !plan.disconnectViaCoordinator) {
      return finishWifiDisconnect({ remote, unexpected });
    }

    return finishLogicalDisconnect({
      remote,
      unexpected,
      disconnectViaCoordinator: plan.disconnectViaCoordinator,
    });
  };

  function snapshotActivePeerForFallback() {
    const coordinatorPeer = connectionCoordinator.getCoordinatorStatus()?.peer || null;
    const active = activePeerRef.current || null;
    const pendingBluetooth = bluetoothPendingPeerRef.current || null;
    const deviceId = peerIdRef.current || coordinatorPeer?.deviceId ||
      active?.deviceId || active?.peerId || pendingBluetooth?.deviceId;
    if (!deviceId) return null;
    const registered = peerRegistry.getPeer(deviceId);
    return {
      ...(pendingBluetooth || {}),
      ...(coordinatorPeer || {}),
      ...(active || {}),
      ...(registered || {}),
      deviceId,
      peerId: deviceId,
      transports: {
        ...(pendingBluetooth?.transports || {}),
        ...(coordinatorPeer?.transports || {}),
        ...(active?.transports || {}),
        ...(registered?.transports || {}),
      },
    };
  }

  async function attemptAlternateTransport(peer, failedTransport) {
    if (!peer?.deviceId || !failedTransport || !mountedRef.current || disconnectingRef.current) {
      return false;
    }
    if (automaticFailoverCountRef.current >= 2) {
      setStatusText('توقف الانتقال التلقائي بعد محاولتين؛ أعد الاتصال يدويًا.');
      return false;
    }

    const alternateTransports = Object.entries(peer.transports || {})
      .filter(([transport, endpoint]) => transport !== failedTransport && !!endpoint);
    if (!alternateTransports.length) return false;

    automaticFailoverCountRef.current += 1;
    stateRef.current = States.DISCONNECTED;
    setState(States.DISCONNECTED);
    setStatusText(
      `فقدنا ${failedTransport}؛ جاري الانتقال التلقائي (${automaticFailoverCountRef.current}/2)…`
    );
    await connectToContact(peer, {
      excludeTransports: [failedTransport],
      isFailover: true,
    });
    return connectionCoordinator.getCoordinatorStatus().state === 'CONNECTED';
  }

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
      const wifiPermissionGranted = await requestWifiDirectPerms();
      if (!wifiPermissionGranted) {
        throw new Error('إذن الأجهزة القريبة مطلوب لاستخدام Wi-Fi Direct');
      }

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
    const [saved, calls] = await Promise.all([listPeers(), listCallRecords(300)]);
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
    setCallRecords(calls || []);
  };

  const handleDeleteCallRecord = async callId => {
    if (!callId) return false;
    const deleted = await deleteCallRecord(callId);
    if (deleted && mountedRef.current) {
      setCallRecords(previous => previous.filter(record => record.callId !== callId));
    }
    return deleted;
  };

  const handleClearCallHistory = async () => {
    const cleared = await clearCallHistory();
    if (cleared && mountedRef.current) setCallRecords([]);
    return cleared;
  };

  const beginWifiNegotiation = async (selected, { incoming = false } = {}) => {
    const stableDeviceId = incoming ? null : resolveStableP2pDeviceId(selected, selected);
    if (stableDeviceId) {
      connectionAddressTrackerRef.current.beginAttempt();
      targetPeerRef.current = selected;
      connectionSetupRef.current = false;
      const coordinatorAttemptId = ++connectionAttemptRef.current;
      coordinatorP2pAttemptRef.current = {
        attemptId: coordinatorAttemptId,
        deviceId: stableDeviceId,
      };
      setMessages([]);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      connectionPhaseRef.current = 'اتصال Wi-Fi Direct عبر المنسق';
      if (mountedRef.current) {
        setStatusText(`جاري الاتصال بـ ${selected.customName || selected.name || 'الجهاز'} عبر Wi-Fi Direct…`);
      }

      try {
        const identity = identityRef.current || await getDeviceIdentity().catch(() => null);
        if (!identity?.deviceId) throw new Error('تعذّر تحميل هوية G1 الثابتة');
        identityRef.current = identity;
        connectionCoordinator.setIdentity(identity);

        const result = await connectP2pFromApp({
contact: selected,
discoveredPeer: selected,
timeoutMs: 30000,
        });

        if (
!mountedRef.current ||
disconnectingRef.current ||
coordinatorAttemptId !== connectionAttemptRef.current
        ) {
connectionCoordinator.disconnect();
return false;
        }

        const route = result.route || {};
        if (route.connectionEpoch != null) {
connectionAddressTrackerRef.current.activateConnection(route.connectionEpoch);
        }

        const peer = result.peer;
        const displayName =
result.displayName || selected.customName || selected.name ||
peer.deviceName || 'الجهاز الآخر';
        await savePeer(peer.deviceId, peer.deviceName || displayName, '');
        await savePeerAddress(
peer.deviceId,
selected.deviceAddress,
peer.deviceName || displayName
        );
        const history = await loadMessages(peer.deviceId, 300);

        peerIdRef.current = peer.deviceId;
        peerIpRef.current = route.isGroupOwner ? null : (route.groupOwnerAddress || null);
        lastConnectionRef.current = null;
        activeTransportRef.current = TRANSPORTS.P2P;
        activeControlOwnerRef.current = CONTROL_PLANE_OWNERS.COORDINATOR;
        reconnectAttemptRef.current = 0;
        targetPeerRef.current = {
...selected,
deviceId: peer.deviceId,
peerId: peer.deviceId,
name: displayName,
        };

        setActivePeerInfo({
...selected,
deviceId: peer.deviceId,
peerId: peer.deviceId,
name: displayName,
transport: 'p2p',
        });
        setPeerDisplayName(displayName);
        startTransferServer().catch(() => {});
        ensureMicGuard();
        startConnectionService('متصل عبر واي فاي مباشر');
        const normalizedHistory = (history || []).map(item => ({
...item,
time: Number(item.time),
        }));
        setMessages(prev => mergePeerMessageHistory(normalizedHistory, prev));

        connectionPhaseRef.current = 'متصل';
        stateRef.current = States.CONNECTED;
        setState(States.CONNECTED);
        setActiveTier(Tiers.WIFI_DIRECT);
        setStatusText('');
        setChatOpen(true);
        refreshContacts();
        return true;
      } catch (error) {
        console.warn('[App] coordinator P2P connect failed:', error?.message || error);
        const coordinatorStatus = connectionCoordinator.getCoordinatorStatus();
        if (
coordinatorStatus.transport === TRANSPORTS.P2P &&
coordinatorStatus.peer?.deviceId === stableDeviceId &&
coordinatorStatus.state !== 'IDLE'
        ) {
connectionCoordinator.disconnect();
        }
        if (
mountedRef.current &&
!disconnectingRef.current &&
coordinatorAttemptId === connectionAttemptRef.current
        ) {
activeTransportRef.current = null;
activeControlOwnerRef.current = null;
peerIpRef.current = null;
lastConnectionRef.current = null;
targetPeerRef.current = null;
stateRef.current = States.IDLE;
setState(States.IDLE);
setActiveTier(Tiers.NONE);
setStatusText(
  `فشل اتصال Wi-Fi Direct عبر المنسق: ${error?.message || 'خطأ غير معروف'}`
);
        }
        return false;
      } finally {
        if (coordinatorP2pAttemptRef.current?.attemptId === coordinatorAttemptId) {
coordinatorP2pAttemptRef.current = null;
        }
      }
    }

    // Incoming invitations and peers without a provable stable G1 identity stay
    // on the legacy path for this surgical slice.
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
    if (coordinatorP2pAttemptRef.current) {
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
      Alert.alert('جاري إنهاء الاتصال', 'انتظر حتى يكتمل إنهاء الاتصال الحالي.');
      return;
    }
    if (coordinatorP2pAttemptRef.current) {
      setStatusText('محاولة اتصال Wi-Fi Direct جارية بالفعل…');
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

  const connectKnownLanPeer = async (contact, target) => {
    const lanInfo = target?.transports?.[TRANSPORTS.LAN];
    if (!target?.deviceId || !lanInfo?.host) {
      throw new Error('هدف LAN المعروف غير مكتمل');
    }

    pendingKnownLanPeerIdRef.current = target.deviceId;
    try {
      const identity = identityRef.current || await getDeviceIdentity().catch(() => null);
      if (!identity?.deviceId) throw new Error('تعذّر تحميل هوية G1 الثابتة');
      identityRef.current = identity;

      if (isKnownLanRaceWinner({
        targetDeviceId: target.deviceId,
        coordinatorStatus: connectionCoordinator.getCoordinatorStatus(),
        signalingHealth: getSignalingHealth(),
      })) {
        return true;
      }

      connectionAttemptRef.current += 1;
      targetPeerRef.current = contact;
      connectionPhaseRef.current = 'اتصال LAN مباشر';
      setMessages([]);
      stateRef.current = States.WIFI_CONNECTING;
      setState(States.WIFI_CONNECTING);
      setStatusText(`جاري الاتصال بـ ${contact.customName || contact.name || target.deviceName || 'الجهاز'} عبر الشبكة المحلية…`);

      await connectionCoordinator.connectLanPeer(target, 8000, {
        maxRetries: 5,
        retryDelayMs: 800,
      });

      if (!mountedRef.current || disconnectingRef.current) {
        throw new Error('أُلغيت محاولة LAN قبل تفعيل الجلسة');
      }

      const displayName = contact.customName || contact.name || target.deviceName || 'الجهاز الآخر';
      await savePeer(target.deviceId, target.deviceName || displayName, '');
      const history = await loadMessages(target.deviceId, 300);

      const coordinatorStatus = connectionCoordinator.getCoordinatorStatus();
      if (
        !mountedRef.current ||
        disconnectingRef.current ||
        !signalingIsHealthy() ||
        coordinatorStatus.state !== 'CONNECTED' ||
        coordinatorStatus.peer?.deviceId !== target.deviceId ||
        coordinatorStatus.transport !== TRANSPORTS.LAN
      ) {
        throw new Error('انتهت جلسة LAN قبل اكتمال تهيئة المحادثة');
      }

      const identitySent = sendSignalingMessage({
        type: 'identity',
        deviceId: identity.deviceId,
        deviceName: identity.deviceName || 'DirectChat Device',
      });
      if (!identitySent || !signalingIsHealthy()) {
        throw new Error('فشل تبادل هوية G1 عبر LAN');
      }

      peerIdRef.current = target.deviceId;
      peerIpRef.current = lanInfo.host;
      activeTransportRef.current = TRANSPORTS.LAN;
      activeControlOwnerRef.current = CONTROL_PLANE_OWNERS.COORDINATOR;
      setActivePeerInfo({
        ...contact,
        deviceId: target.deviceId,
        peerId: target.deviceId,
        host: lanInfo.host,
        port: lanInfo.port || PORT,
        name: displayName,
        transport: 'lan',
      });
      setPeerDisplayName(displayName);
      startTransferServer().catch(() => {});
      ensureMicGuard();
      setMessages((history || []).map(h => ({ ...h, time: Number(h.time) })));

      reconnectAttemptRef.current = 0;
      stateRef.current = States.CONNECTED;
      setState(States.CONNECTED);
      setActiveTier(Tiers.LAN);
      setStatusText('متصل عبر الشبكة المحلية');
      setChatOpen(true);
      refreshContacts();
      return true;
    } catch (error) {
      const coordinatorStatus = connectionCoordinator.getCoordinatorStatus();
      const signalingHealth = getSignalingHealth();
      if (isKnownLanRaceWinner({
        targetDeviceId: target.deviceId,
        coordinatorStatus,
        signalingHealth,
      })) {
        return true;
      }
      if (
        coordinatorStatus.peer?.deviceId === target.deviceId &&
        coordinatorStatus.transport === TRANSPORTS.LAN
      ) {
        connectionCoordinator.disconnect();
      }
      if (activeControlOwnerRef.current === CONTROL_PLANE_OWNERS.COORDINATOR) {
        activeControlOwnerRef.current = null;
      }
      if (activeTransportRef.current === TRANSPORTS.LAN) {
        activeTransportRef.current = null;
      }
      peerIpRef.current = null;
      stateRef.current = States.IDLE;
      if (mountedRef.current) {
        setState(States.IDLE);
        setActiveTier(Tiers.NONE);
      }
      throw error;
    } finally {
      if (pendingKnownLanPeerIdRef.current === target.deviceId) {
        pendingKnownLanPeerIdRef.current = null;
      }
    }
  };

  /**
   * الاتصال بجهاز محدّد اختاره المستخدم.
   *
   * سابقاً كان الكود يتصل بأول جهاز يظهر بالقائمة — حتى لو كان جهاز
   * جار ما عليه التطبيق. المحاولة كانت تفشل ويعلق الإطار فتفشل اللي
   * بعدها كمان. هلق الاتصال بيصير بالجهاز يلي اخترته أنت فقط.
   */
  const connectToContact = async (contact, selectionOptions = {}) => {
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
      Alert.alert('جاري إنهاء الاتصال', 'انتظر حتى يكتمل إنهاء الاتصال الحالي.');
      return;
    }
    if (coordinatorP2pAttemptRef.current) {
      setStatusText('محاولة اتصال Wi-Fi Direct جارية بالفعل…');
      return;
    }

    try {
      if (!selectionOptions.isFailover) automaticFailoverCountRef.current = 0;
      const stableId = contact.deviceId || contact.peerId || null;
      const registryPeer = stableId ? peerRegistry.getPeer(stableId) : null;
      const knownLanTarget = resolveKnownLanTarget(contact, registryPeer);

      if (stableId) {
        const p2pAddress = contact.transports?.[TRANSPORTS.P2P]?.deviceAddress ||
          registryPeer?.transports?.[TRANSPORTS.P2P]?.deviceAddress ||
          (
            contact.transport !== 'bluetooth' &&
            !contact.btAddress &&
            String(contact.deviceAddress || '').includes(':')
              ? contact.deviceAddress
              : null
          );
        const bluetoothAddress = contact.transports?.[TRANSPORTS.BLUETOOTH]?.address ||
          registryPeer?.transports?.[TRANSPORTS.BLUETOOTH]?.address ||
          contact.btAddress || null;
        const transports = {
          ...(contact.transports || {}),
          ...(registryPeer?.transports || {}),
          ...(knownLanTarget?.transports || {}),
        };
        if (p2pAddress && !transports[TRANSPORTS.P2P]) {
          transports[TRANSPORTS.P2P] = { deviceAddress: p2pAddress, isReachable: true };
        }
        if (bluetoothAddress && !transports[TRANSPORTS.BLUETOOTH]) {
          transports[TRANSPORTS.BLUETOOTH] = { address: bluetoothAddress, isReachable: true };
        }

        const selectionPeer = {
          ...(registryPeer || {}),
          deviceId: stableId,
          deviceName: contact.customName || contact.name || registryPeer?.deviceName || 'G1 Device',
          transports,
        };
        const excludedTransports = new Set(selectionOptions.excludeTransports || []);
        const candidateCount = Object.entries(transports)
          .filter(([transport, endpoint]) => !!endpoint && !excludedTransports.has(transport))
          .length;
        if (candidateCount > 0) {
          await connectionCoordinator.connectPeer(selectionPeer, {
            maxAttempts: 3,
            lanTimeoutMs: 8000,
            p2pTimeoutMs: 30000,
            bluetoothTimeoutMs: 8000,
            excludeTransports: [...excludedTransports],
            handlers: {
              connectLan: knownLanTarget
                ? () => connectKnownLanPeer(contact, knownLanTarget)
                : undefined,
              cancelLan: () => connectionCoordinator.cancelConnecting(),
              connectP2p: p2pAddress
                ? async () => {
                    if (scanPromiseRef.current) await scanPromiseRef.current;
                    let freshPeer = findFreshPeer(contact);
                    if (!freshPeer) {
                      await runFreshDiscovery();
                      freshPeer = findFreshPeer(contact);
                    }
                    if (!freshPeer) throw new Error('لم يظهر مسار Wi‑Fi Direct حديث لهذا الجهاز');
                    const selected = {
                      ...contact,
                      ...freshPeer,
                      peerId: freshPeer.isMusab
                        ? (freshPeer.peerId || contact.peerId)
                        : (contact.peerId || freshPeer.peerId),
                      deviceAddress: freshPeer.deviceAddress,
                    };
                    const connected = await beginWifiNegotiation(selected);
                    if (!connected) throw new Error('فشل تفعيل جلسة Wi‑Fi Direct');
                    return connected;
                  }
                : undefined,
              cancelP2p: () => connectionCoordinator.cancelConnecting(),
              connectBluetooth: bluetoothAddress
                ? async () => {
                    bluetoothPendingPeerRef.current = selectionPeer;
                    const route = await connectionCoordinator.connectBluetoothPeer(selectionPeer, 8000, {
                      adapterOptions: { autoReconnect: true, maxReconnectAttempts: 3 },
                    });
                    await activateBluetoothUi(selectionPeer, route);
                    return route;
                  }
                : undefined,
              cancelBluetooth: () => bluetoothTransport.cancelConnect('Transport fallback advanced'),
              onFallbackStep: transport => {
                if (mountedRef.current) {
                  const label = transport === TRANSPORTS.LAN
                    ? 'LAN'
                    : transport === TRANSPORTS.P2P ? 'Wi‑Fi Direct' : 'Bluetooth';
                  setStatusText(`جاري تجربة ${label}…`);
                }
              },
            },
          });
          return;
        }
        if (selectionOptions.isFailover) {
          throw new Error('لا يوجد ناقل بديل معروف لهذا الجهاز');
        }
      }

      if (knownLanTarget) {
        try {
          await connectKnownLanPeer(contact, knownLanTarget);
          return;
        } catch (lanErr) {
          console.log('[App] known LAN attempt failed, falling back to P2P:', lanErr?.message || lanErr);
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
        const coordinatorStatus = connectionCoordinator.getCoordinatorStatus();
        if (coordinatorStatus.transport === TRANSPORTS.P2P) {
          await recoverFailedConnection(connectionPhaseRef.current, e);
        } else {
          connectionCoordinator.cancelConnecting();
          stateRef.current = States.IDLE;
          if (mountedRef.current) {
            setState(States.IDLE);
            setActiveTier(Tiers.NONE);
            setStatusText(e?.message || 'تعذّر الاتصال بأي مسار متاح');
          }
        }
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
    const existingCall = getActiveCall();
    if (
      callStartLockRef.current ||
      inCallRef.current ||
      ringStateRef.current ||
      (existingCall && !TERMINAL_CALL_STATES.has(existingCall.state))
    ) {
      return false;
    }
    if (activeTransportRef.current === TRANSPORTS.BLUETOOTH) {
      Alert.alert(
        'المكالمات تحتاج مسار IP',
        'محادثة Bluetooth تعمل دون إنترنت، لكن الصوت والفيديو يحتاجان LAN أو Wi‑Fi Direct.'
      );
      return false;
    }
    callStartLockRef.current = true;
    try {
      const currentPeer = activePeerRef.current || {};
      const callId = beginOutgoingCall({
        peerId: peerIdRef.current || currentPeer.deviceId || currentPeer.peerId || 'unknown-peer',
        peerName: peerDisplayName || currentPeer.customName || currentPeer.name || 'G1 Device',
        video: withVideo,
      });
      activeCallIdRef.current = callId;
      ringbackCallIdRef.current = null;
      inCallRef.current = false;
      callVideoRef.current = withVideo;
      rtcActiveRef.current = false;
      rtcNegotiatingRef.current = false;
      rtcNegotiatingCallIdRef.current = null;
      setAudioEngine(null);
      setRtcLog([]);

      // ما منفتح كاميرا ولا ميكروفون هون — منستنى الطرف الآخر يرد.
      // بنعرض شاشة "جاري الاتصال" لحد ما يقبل أو يرفض أو تنتهي المهلة.
      if (mountedRef.current) setRingState('outgoing');

      const myIp = await DirectConnection.getLocalIpAddress().catch(() => null);
      const sent = sendSignalingMessage({ type: 'call-request', callId, ip: myIp, video: withVideo });
      if (!sent) failRuntimeCall(callId, 'call-request-send-failed');
      return sent;
    } catch (error) {
      if (error?.code !== 'CALL_ALREADY_ACTIVE') {
        console.warn('[Call] failed to start:', error?.message || error);
      }
      return false;
    } finally {
      callStartLockRef.current = false;
    }
  };

  /** إلغاء مكالمة صادرة قبل ما يرد الطرف الآخر */
  const cancelOutgoingCall = () => {
    const callId = activeCallIdRef.current || getActiveCall()?.callId;
    return callId ? endRuntimeCall(callId, { reason: 'caller-cancelled' }) : false;
  };

  const startVideoCall = () => startCallWith(true);
  const startVoiceCall = () => startCallWith(false);

  const endCall = () => {
    const callId = activeCallIdRef.current || getActiveCall()?.callId;
    return callId ? endRuntimeCall(callId, { reason: 'local-ended' }) : false;
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
    let sent = false;
    try {
      const result = activeTransportRef.current === TRANSPORTS.BLUETOOTH
        ? connectionCoordinator.sendMessage({ type: 'disconnect-request' })
        : sendSignalingMessage({ type: 'disconnect-request' });
      sent = result?.then ? await result.then(() => true, () => false) : result === true;
    } catch (e) {
      sent = false;
    }
    if (sent) {
      await ack;
    } else {
      if (disconnectAckTimerRef.current) clearTimeout(disconnectAckTimerRef.current);
      disconnectAckTimerRef.current = null;
      disconnectAckRef.current = null;
    }

    await finishCurrentTransportDisconnect();
  };

  const sendMsg = (input) => {
    const outgoing = createOutgoingTextMessage(input);
    if (!outgoing) return false;
    const frame = {
      type: 'chat',
      messageId: outgoing.messageId,
      text: outgoing.text,
      replyToMessageId: outgoing.replyToMessageId,
      time: outgoing.time,
    };
    if (activeTransportRef.current === TRANSPORTS.BLUETOOTH) {
      addMessage({ ...outgoing, status: 'sending' });
      Promise.resolve(connectionCoordinator.sendMessage(frame)).then(result => {
        if (result === false) throw new Error('Bluetooth send returned false');
        if (mountedRef.current) {
          setMessages(previous => previous.map(message => (
            message.messageId === outgoing.messageId ? { ...message, status: 'sent' } : message
          )));
        }
        if (peerIdRef.current) updateMessageStatus(peerIdRef.current, outgoing.messageId, 'sent');
      }).catch(() => {
        if (mountedRef.current) {
          setMessages(previous => previous.map(message => (
            message.messageId === outgoing.messageId ? { ...message, status: 'failed' } : message
          )));
          Alert.alert('تعذّر إرسال الرسالة عبر Bluetooth');
        }
        if (peerIdRef.current) updateMessageStatus(peerIdRef.current, outgoing.messageId, 'failed');
      });
      return true;
    }
    const sent = sendSignalingMessage(frame);
    addMessage({ ...outgoing, status: sent ? 'sent' : 'failed' });
    return sent;
  };

  const deleteLocalMessage = async messageId => {
    if (!messageId) return false;
    if (peerIdRef.current) {
      const deleted = await deleteMessageLocal(peerIdRef.current, messageId);
      if (!deleted) return false;
    }
    setMessages(prev => removeMessageById(prev, messageId));
    return true;
  };

  const clearCurrentConversation = async () => {
    if (peerIdRef.current) {
      const cleared = await clearMessages(peerIdRef.current);
      if (!cleared) return false;
    }
    setMessages([]);
    return true;
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
  const beginAudio = async ({ asCaller, offerSdp, callId }) => {
    const mediaCallId = callId || getActiveCall()?.callId;
    const initialCall = getActiveCall();
    if (
      !mediaCallId ||
      initialCall?.callId !== mediaCallId ||
      TERMINAL_CALL_STATES.has(initialCall.state) ||
      rtcNegotiatingCallIdRef.current === mediaCallId ||
      rtcActiveRef.current
    ) {
      return false;
    }
    const useSpeaker = !!callVideoRef.current;
    const isCurrentMediaCall = () => {
      const call = getActiveCall();
      return call?.callId === mediaCallId && !TERMINAL_CALL_STATES.has(call.state);
    };
    const failActiveMedia = reason => {
      const failureReason = reason || 'media-failed';
      const call = getActiveCall();
      if (call?.callId === mediaCallId && !TERMINAL_CALL_STATES.has(call.state)) {
        sendSignalingMessage({
          type: 'call-failed',
          callId: mediaCallId,
          reason: failureReason,
        });
        failRuntimeCall(mediaCallId, failureReason);
      }
    };

    if (!RTCAudio.isWebRTCAvailable()) {
      rtcDiagRef.current = 'WebRTC غير متاح';
      failActiveMedia('webrtc-unavailable');
      if (mountedRef.current) setAudioEngine('failed');
      return false;
    }

    rtcNegotiatingRef.current = true;
    rtcNegotiatingCallIdRef.current = mediaCallId;

    try {
      // تهيئة بيئة الصوت قبل ما تمسك WebRTC الميكروفون
      await startAudioSession(useSpeaker);
      const common = {
        signalSender: (message) => sendSignalingMessage({
          ...message,
          callId: mediaCallId,
        }),
        onFailure: (reason) => {
          if (!isCurrentMediaCall()) return;
          rtcNegotiatingRef.current = false;
          if (rtcNegotiatingCallIdRef.current === mediaCallId) {
            rtcNegotiatingCallIdRef.current = null;
          }
          rtcDiagRef.current = reason || 'سبب غير معروف';
          failActiveMedia(reason || 'media-failed');
          if (mountedRef.current) {
            setRtcLog(prev => [...prev.slice(-9), `✗ ${reason}`]);
            setAudioEngine('failed');
          }
        },
        onDiagnostic: (msg) => {
          if (!isCurrentMediaCall()) return;
          rtcDiagRef.current = msg;
          if (mountedRef.current) {
            setRtcLog(prev => [...prev.slice(-9), `${new Date().toLocaleTimeString()} ${msg}`]);
          }
        },
        onState: (state) => {
          if (state === 'connected' && !rtcActiveRef.current && isCurrentMediaCall()) {
            rtcActiveRef.current = true;
            rtcNegotiatingRef.current = false;
            if (rtcNegotiatingCallIdRef.current === mediaCallId) {
              rtcNegotiatingCallIdRef.current = null;
            }
            const call = getActiveCall();
            if (call?.callId === mediaCallId && call.state !== CALL_STATES.ACTIVE && markCallActive(mediaCallId)) {
              sendSignalingMessage({ type: 'call-active', callId: mediaCallId });
            }
            if (mountedRef.current) setAudioEngine('webrtc');
          }
        },
      };

      if (asCaller) {
        await RTCAudio.startAsCaller(common);
      } else {
        await RTCAudio.startAsCallee({ ...common, offerSdp });
      }
      return true;
    } catch (e) {
      if (!isCurrentMediaCall()) return false;
      rtcNegotiatingRef.current = false;
      if (rtcNegotiatingCallIdRef.current === mediaCallId) {
        rtcNegotiatingCallIdRef.current = null;
      }
      rtcDiagRef.current = e?.message;
      failActiveMedia(e?.message || 'media-start-failed');
      if (mountedRef.current) setAudioEngine('failed');
      return false;
    }
  };

  // كل رسالة تُضاف تُحفظ فوراً بقاعدة البيانات، وتُشعر المستخدم لو كان بالخلفية
  const addMessage = (msg, notify) => {
    const withTime = ensureMessageIdentity({ ...msg, time: msg.time || Date.now() });
    if (!withTime) return;
    // Persistence/identity promotion can complete before React flushes state.
    // Keep the live ref authoritative immediately so an in-flight Bluetooth
    // activation cannot replace a just-received frame with an older snapshot.
    const alreadyTracked = messagesRef.current.some(message => (
      message.messageId && message.messageId === withTime.messageId
    ));
    if (!alreadyTracked) messagesRef.current = [...messagesRef.current, withTime];
    setMessages(prev => (
      prev.some(message => message.messageId && message.messageId === withTime.messageId)
        ? prev
        : [...prev, withTime]
    ));
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

  useEffect(() => {
    const restoreCallUi = call => {
      if (!call || TERMINAL_CALL_STATES.has(call.state)) return;
      activeCallIdRef.current = call.callId;
      callVideoRef.current = call.mediaType === 'video' || call.video === true;
      pendingCallRef.current = {
        callId: call.callId,
        video: callVideoRef.current,
        ip: call.ip || null,
      };
      // Recovery never opens camera/microphone automatically. It only restores
      // an actionable ringing surface so the user remains in control.
      if (mountedRef.current && call.state !== CALL_STATES.ACTIVE) {
        setRingState(call.direction === 'incoming' ? 'incoming' : 'outgoing');
      }
    };

    const controller = registerCallUiController({
      restore: restoreCallUi,
      accept: call => startAcceptedIncomingMedia(call),
    });

    const stateSubscription = subscribeToCallState((call, previous, reason) => {
      if (!call) return;
      activeCallIdRef.current = call.callId;
      callVideoRef.current = call.mediaType === 'video' || call.video === true;

      if (call.state === CALL_STATES.RINGING) {
        inCallRef.current = false;
        pendingCallRef.current = {
          callId: call.callId,
          video: callVideoRef.current,
          ip: call.ip || null,
        };
        if (mountedRef.current) {
          setRingState(call.direction === 'incoming' ? 'incoming' : 'outgoing');
          setInCall(false);
        }
        return;
      }

      if (call.state === CALL_STATES.CONNECTING && call.direction === 'outgoing') {
        // A restored session is deliberately left for explicit user action;
        // never reopen microphone/camera after JS recreation.
        if (call.recovered || reason === 'runtime-restored' || audioStartedRef.current) return;
        inCallRef.current = true;
        audioStartedRef.current = true;
        if (mountedRef.current) {
          setRingState(null);
          setInCall(true);
          setAudioEngine(null);
        }
        if (callVideoRef.current) {
          cameraOnRef.current = true;
          startCameraCapture().catch(() => {});
        }
        beginAudio({ asCaller: true, callId: call.callId });
        return;
      }

      if (call.state === CALL_STATES.ACTIVE) {
        inCallRef.current = true;
        if (mountedRef.current) {
          setRingState(null);
          setInCall(true);
        }
        return;
      }

      if (
        TERMINAL_CALL_STATES.has(call.state) &&
        previous &&
        !TERMINAL_CALL_STATES.has(previous.state)
      ) {
        endCallLocal();
        if (callChatLoggedRef.current !== call.callId) {
          callChatLoggedRef.current = call.callId;
          const result = call.state === CALL_STATES.MISSED
            ? (call.direction === 'incoming' ? 'missed' : 'noanswer')
            : call.state === CALL_STATES.DECLINED
              ? (call.direction === 'incoming' ? 'declined' : 'rejected')
              : call.state === CALL_STATES.BUSY
                ? 'busy'
                : call.state === CALL_STATES.FAILED
                  ? 'failed'
                  : call.endReason === 'caller-cancelled'
                    ? 'cancelled'
                    : 'ended';
          addMessage({
            sender: call.direction === 'incoming' ? 'remote' : 'me',
            type: 'call',
            callKind: callVideoRef.current ? 'video' : 'voice',
            callResult: result,
            duration: call.duration || 0,
          }, call.direction === 'incoming' && call.state === CALL_STATES.MISSED);
        }
        waitForCallRuntimeIdle().then(() => refreshContacts()).catch(() => {});
      }
    });

    return () => {
      controller?.remove?.();
      stateSubscription?.remove?.();
    };
  // The runtime/controller is registered once and all mutable call/session
  // data is read through refs. Re-registering per render duplicates actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newTransferId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // مسار موحّد لكل أنواع الإرسال (ملف / صورة / تطبيق / تسجيل صوتي)
  const sendAsset = async ({ uri, name, mimeType, size, kind, localUri }) => {
    if (activeTransportRef.current === TRANSPORTS.BLUETOOTH) {
      throw new Error('نقل الملفات يحتاج LAN أو Wi‑Fi Direct؛ Bluetooth مخصص للرسائل النصية.');
    }
    // Legacy address is fallback only. FileShare resolves the live signaling
    // socket first, so an inbound/passive peer can send even if peerIpRef was
    // never populated and a stale P2P address cannot override the live route.
    const peerIp = peerIpRef.current || null;

    const transferId = newTransferId();
    setMessages(prev => [...prev, ensureMessageIdentity({
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
    })]);

    transferActivityGateRef.current.begin(`out:${transferId}`);
    try {
      await sendFileNative(peerIp, uri, transferId, kind);
    } finally {
      releaseTransferActivity(`out:${transferId}`);
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
    if (activeTransportRef.current === TRANSPORTS.BLUETOOTH) {
      Alert.alert('الرسائل الصوتية غير متاحة', 'انتقل إلى LAN أو Wi‑Fi Direct لإرسال الملفات والصوت.');
      return;
    }
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
          callRecords={callRecords}
          onDeleteCallRecord={handleDeleteCallRecord}
          onClearCallHistory={handleClearCallHistory}
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
          onDeleteMessage={deleteLocalMessage}
          onClearConversation={clearCurrentConversation}
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
    </View>
    </ThemeProvider>
  );
}
