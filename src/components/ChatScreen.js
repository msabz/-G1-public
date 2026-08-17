import React, { useEffect, useState, useRef } from 'react';
import {
  View, StyleSheet, TouchableOpacity, Text, FlatList, TextInput,
  KeyboardAvoidingView, Platform, Image, Alert, StatusBar, ActivityIndicator, Modal,
  BackHandler,
} from 'react-native';
import { playVoiceFile } from '../media/AudioClip';
import { WA } from '../theme';

function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'م' : 'ص';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

// هل الملف حزمة تطبيق؟ منعرض له نصاً مختلفاً
function isAppFile(item) {
  const n = (item.fileName || '').toLowerCase();
  return n.endsWith('.apk') || n.endsWith('.apks') ||
    item.mimeType === 'application/vnd.android.package-archive';
}

function formatSize(bytes) {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} كيلوبايت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ميجابايت`;
}

// علامات التسليم على شكل صحّين متل واتساب
function Ticks({ status }) {
  if (status === 'sending') return <Text style={styles.metaTick}>🕐</Text>;
  const color = status === 'read' ? WA.tick : WA.subText;
  return <Text style={[styles.metaTick, { color }]}>{status === 'sent' ? '✓' : '✓✓'}</Text>;
}

function MessageMeta({ item, light }) {
  return (
    <View style={styles.metaRow}>
      {item.sender === 'me' && <Ticks status={item.status || 'sent'} />}
      <Text style={[styles.metaTime, light && { color: 'rgba(255,255,255,0.8)' }]}>
        {formatTime(item.time)}
      </Text>
    </View>
  );
}

function ProgressBar({ progress }) {
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${Math.round((progress || 0) * 100)}%` }]} />
    </View>
  );
}

function formatCallDuration(sec) {
  if (!sec || sec < 60) return `${sec || 0} ث`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// نص وأيقونة سجل المكالمة حسب نتيجتها
function callInfo(item) {
  const isVideo = item.callKind === 'video';
  const label = isVideo ? 'مكالمة فيديو' : 'مكالمة صوتية';
  switch (item.callResult) {
    case 'ended':
      return { title: label, sub: formatCallDuration(item.duration), missed: false, isVideo };
    case 'missed':
      return { title: `${label} فائتة`, sub: 'اضغط لمعاودة الاتصال', missed: true, isVideo };
    case 'noanswer':
      return { title: label, sub: 'لم يتم الرد', missed: false, isVideo };
    case 'declined':
      return { title: label, sub: 'تم الرفض', missed: true, isVideo };
    case 'rejected':
      return { title: label, sub: 'مرفوضة', missed: false, isVideo };
    case 'busy':
      return { title: label, sub: 'مشغول', missed: false, isVideo };
    case 'cancelled':
      return { title: label, sub: 'ملغاة', missed: false, isVideo };
    default:
      return { title: label, sub: '', missed: false, isVideo };
  }
}

function MessageBubble({ item, onOpenFile, onViewImage, onRedial }) {
  const isMe = item.sender === 'me';

  // ===== سجل مكالمة =====
  if (item.type === 'call') {
    const info = callInfo(item);
    return (
      <View style={styles.row}>
        <TouchableOpacity
          activeOpacity={info.missed ? 0.7 : 1}
          disabled={!info.missed}
          onPress={() => onRedial && onRedial(info.isVideo)}
          style={[styles.bubble, isMe ? styles.outBubble : styles.inBubble, styles.callBubble]}
        >
          <View style={[styles.callIconBox, info.missed && styles.callIconMissed]}>
            <Text style={{ fontSize: 17 }}>
              {info.isVideo ? '🎥' : '📞'}
            </Text>
          </View>
          <View style={{ flex: 1, marginRight: 10 }}>
            <Text style={styles.callTitle}>{info.title}</Text>
            <Text style={[styles.callSub, info.missed && { color: '#E0453F' }]}>{info.sub}</Text>
          </View>
          <Text style={styles.metaTime}>{formatTime(item.time)}</Text>
        </TouchableOpacity>
      </View>
    );
  }
  const bubbleStyle = [styles.bubble, isMe ? styles.outBubble : styles.inBubble];

  // ===== رسالة صوتية =====
  if (item.type === 'voice') {
    const busy = item.progress != null && item.progress < 1;
    return (
      <View style={styles.row}>
        <View style={[...bubbleStyle, styles.voiceBubble]}>
          <TouchableOpacity
            disabled={busy || !item.path}
            onPress={async () => {
              try { await playVoiceFile(item.path); }
              catch (e) { Alert.alert('تعذّر التشغيل', e?.message || ''); }
            }}
            style={styles.playBtn}
          >
            <Text style={styles.playIcon}>{busy ? '⏳' : '▶'}</Text>
          </TouchableOpacity>
          <View style={{ flex: 1, marginHorizontal: 8 }}>
            <View style={styles.waveform}>
              {[8, 14, 20, 12, 18, 10, 16, 22, 12, 8, 15, 19, 11, 17, 9].map((h, i) => (
                <View key={i} style={[styles.waveBar, { height: h }]} />
              ))}
            </View>
            {busy && <ProgressBar progress={item.progress} />}
          </View>
          <MessageMeta item={item} />
        </View>
      </View>
    );
  }

  // ===== صورة =====
  if (item.type === 'image') {
    const busy = item.progress != null && item.progress < 1;
    return (
      <View style={styles.row}>
        <TouchableOpacity
          activeOpacity={0.85}
          disabled={busy || !(item.path || item.localUri)}
          onPress={() => onViewImage && onViewImage(item)}
          style={[...bubbleStyle, styles.mediaBubble]}
        >
          {item.localUri && !busy ? (
            <Image source={{ uri: item.localUri }} style={styles.imagePreview} resizeMode="cover" />
          ) : (
            <View style={styles.imagePlaceholder}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.placeholderText}>
                {busy ? `${Math.round((item.progress || 0) * 100)}%` : 'صورة'}
              </Text>
            </View>
          )}
          {busy && <ProgressBar progress={item.progress} />}
          <View style={styles.mediaMeta}><MessageMeta item={item} light /></View>
        </TouchableOpacity>
      </View>
    );
  }

  // ===== ملف =====
  if (item.type === 'file') {
    const busy = item.progress != null && item.progress < 1;
    const canOpen = !busy && (item.path || item.localUri);
    return (
      <View style={styles.row}>
        <TouchableOpacity
          activeOpacity={canOpen ? 0.7 : 1}
          disabled={!canOpen}
          onPress={() => onOpenFile && onOpenFile(item)}
          style={[...bubbleStyle, { minWidth: 230 }]}
        >
          <View style={styles.fileRow}>
            <View style={styles.fileIconBox}>
              <Text style={{ fontSize: 22 }}>{isAppFile(item) ? '📦' : '📄'}</Text>
            </View>
            <View style={{ flex: 1, marginRight: 10 }}>
              <Text style={styles.fileName} numberOfLines={1}>{item.fileName}</Text>
              <Text style={styles.fileSub}>
                {busy
                  ? `${isMe ? 'جاري الإرسال' : 'جاري الاستلام'} · ${Math.round(item.progress * 100)}%`
                  : `${formatSize(item.size)}${canOpen ? (isAppFile(item) ? ' · اضغط للتثبيت' : ' · اضغط للفتح') : ''}`}
              </Text>
            </View>
          </View>
          {busy && <ProgressBar progress={item.progress} />}
          <MessageMeta item={item} />
        </TouchableOpacity>
      </View>
    );
  }

  // ===== نص =====
  return (
    <View style={styles.row}>
      <View style={bubbleStyle}>
        <Text style={styles.msgText}>{item.text}</Text>
        <MessageMeta item={item} />
      </View>
    </View>
  );
}

export default function ChatScreen({
  messages, onSendMessage, onStartVideoCall, onStartVoiceCall,
  onBack, onDisconnect, onPickFile, activeTier,
  isRecording, onStartRecording, onStopRecording, peerName,
  onCaptureImage, onLoadApps, onSendApp, onOpenFile, onOpenProbe,
}) {
  const [msgText, setMsgText] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const [apps, setApps] = useState([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appSearch, setAppSearch] = useState('');
  const [viewerImage, setViewerImage] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const listRef = useRef(null);
  const tierLabel = activeTier === 'WIFI_DIRECT' ? 'متصل عبر واي فاي مباشر' : 'متصل';
  const hasText = msgText.trim().length > 0;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const confirmDisconnect = () => {
    setMenuOpen(false);
    Alert.alert(
      'قطع الاتصال؟',
      'سيُغلق الاتصال مع الجهاز الآخر. تبقى الرسائل محفوظة ويمكنك الاتصال به مجدداً.',
      [
        { text: 'إلغاء', style: 'cancel' },
        { text: 'قطع الاتصال', style: 'destructive', onPress: () => onDisconnect() },
      ]
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar backgroundColor={WA.green} barStyle="light-content" />

      {/* ===== الشريط العلوي ===== */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backIcon}>←</Text>
        </TouchableOpacity>

        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(peerName || 'M')[0].toUpperCase()}</Text>
        </View>

        <View style={{ flex: 1, marginHorizontal: 10 }}>
          <Text style={styles.headerName} numberOfLines={1}>{peerName || 'Musabchat'}</Text>
          <Text style={styles.headerStatus} numberOfLines={1}>{tierLabel}</Text>
        </View>

        <TouchableOpacity onPress={onStartVideoCall} style={styles.headerBtn}>
          <Text style={styles.headerIcon}>🎥</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onStartVoiceCall} style={styles.headerBtn}>
          <Text style={styles.headerIcon}>📞</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setMenuOpen(true)} style={styles.headerBtn}>
          <Text style={styles.menuIcon}>⋮</Text>
        </TouchableOpacity>
      </View>

      {/* الرجوع لا يقطع الجلسة؛ القطع موجود فقط كخيار صريح مع تأكيد. */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <View style={styles.menuRoot}>
          <TouchableOpacity
            style={styles.menuBackdrop}
            activeOpacity={1}
            onPress={() => setMenuOpen(false)}
          />
          <View style={styles.menuCard}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => { setMenuOpen(false); onOpenProbe(); }}
            >
              <Text style={styles.menuItemText}>فحص الاتصال</Text>
            </TouchableOpacity>
            <View style={styles.menuDivider} />
            <TouchableOpacity style={styles.menuItem} onPress={confirmDisconnect}>
              <Text style={styles.menuDangerText}>قطع الاتصال</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* ===== منطقة الرسائل ===== */}
        <View style={styles.chatArea}>
          <FlatList
            ref={listRef}
            data={messages}
            renderItem={({ item }) => <MessageBubble item={item} onOpenFile={onOpenFile} onViewImage={setViewerImage} onRedial={(v) => (v ? onStartVideoCall() : onStartVoiceCall())} />}
            keyExtractor={(_, i) => i.toString()}
            contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 8 }}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            ListEmptyComponent={
              <View style={styles.emptyBox}>
                <Text style={styles.emptyText}>
                  🔒 الرسائل تُنقل مباشرة بين الجهازين بدون أي خادم وسيط
                </Text>
              </View>
            }
          />
        </View>

        {/* ===== شريط الإدخال ===== */}
        {isRecording ? (
          <View style={styles.recordBar}>
            <Text style={styles.recordDot}>🔴</Text>
            <Text style={styles.recordText}>جاري التسجيل… ارفع إصبعك للإرسال</Text>
          </View>
        ) : null}

        <View style={styles.inputRow}>
          <View style={styles.inputPill}>
            <TouchableOpacity onPress={() => setSheetOpen(true)} style={styles.pillBtn}>
              <Text style={styles.pillIcon}>📎</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onCaptureImage} style={styles.pillBtn}>
              <Text style={styles.pillIcon}>📷</Text>
            </TouchableOpacity>
            <TextInput
              value={msgText}
              onChangeText={setMsgText}
              placeholder="رسالة"
              placeholderTextColor="#8696A0"
              style={styles.input}
              multiline
            />
          </View>

          {hasText ? (
            <TouchableOpacity
              onPress={() => { onSendMessage(msgText); setMsgText(''); }}
              style={styles.sendCircle}
            >
              <Text style={styles.sendIcon}>➤</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPressIn={onStartRecording}
              onPressOut={onStopRecording}
              style={[styles.sendCircle, isRecording && styles.sendCircleRec]}
            >
              <Text style={styles.sendIcon}>🎙</Text>
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>

      {/* ===== عارض الصور داخل التطبيق ===== */}
      <Modal visible={!!viewerImage} transparent animationType="fade" onRequestClose={() => setViewerImage(null)}>
        <View style={styles.viewerRoot}>
          <View style={styles.viewerBar}>
            <TouchableOpacity onPress={() => setViewerImage(null)} style={styles.backBtn}>
              <Text style={styles.backIcon}>←</Text>
            </TouchableOpacity>
            <Text style={styles.viewerTitle} numberOfLines={1}>
              {viewerImage?.fileName || 'صورة'}
            </Text>
            <TouchableOpacity
              onPress={() => { const it = viewerImage; setViewerImage(null); onOpenFile && onOpenFile(it); }}
              style={styles.backBtn}
            >
              <Text style={styles.viewerAction}>فتح خارجياً</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.viewerBody}
            activeOpacity={1}
            onPress={() => setViewerImage(null)}
          >
            {viewerImage?.localUri ? (
              <Image
                source={{ uri: viewerImage.localUri }}
                style={styles.viewerImage}
                resizeMode="contain"
              />
            ) : null}
          </TouchableOpacity>
        </View>
      </Modal>

      {/* ===== قائمة الإرفاق (متل واتساب) ===== */}
      <Modal visible={sheetOpen} transparent animationType="fade" onRequestClose={() => setSheetOpen(false)}>
        <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setSheetOpen(false)}>
          <View style={styles.sheet}>
            <View style={styles.sheetGrip} />
            <View style={styles.sheetGrid}>
              <TouchableOpacity
                style={styles.sheetItem}
                onPress={() => { setSheetOpen(false); onPickFile(); }}
              >
                <View style={[styles.sheetIcon, { backgroundColor: '#7F66FF' }]}>
                  <Text style={styles.sheetIconText}>📄</Text>
                </View>
                <Text style={styles.sheetLabel}>مستند</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.sheetItem}
                onPress={() => { setSheetOpen(false); onCaptureImage(); }}
              >
                <View style={[styles.sheetIcon, { backgroundColor: '#E0453F' }]}>
                  <Text style={styles.sheetIconText}>📷</Text>
                </View>
                <Text style={styles.sheetLabel}>كاميرا</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.sheetItem}
                onPress={async () => {
                  setSheetOpen(false);
                  setAppsOpen(true);
                  setAppsLoading(true);
                  try {
                    const list = await onLoadApps();
                    setApps(list || []);
                  } catch (e) {
                    Alert.alert('تعذّر قراءة قائمة التطبيقات', e?.message || '');
                  } finally {
                    setAppsLoading(false);
                  }
                }}
              >
                <View style={[styles.sheetIcon, { backgroundColor: '#0AA5A5' }]}>
                  <Text style={styles.sheetIconText}>📱</Text>
                </View>
                <Text style={styles.sheetLabel}>تطبيق</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ===== منتقي التطبيقات المثبتة ===== */}
      <Modal visible={appsOpen} animationType="slide" onRequestClose={() => setAppsOpen(false)}>
        <View style={{ flex: 1, backgroundColor: '#fff' }}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => setAppsOpen(false)} style={styles.backBtn}>
              <Text style={styles.backIcon}>←</Text>
            </TouchableOpacity>
            <Text style={[styles.headerName, { flex: 1, marginHorizontal: 10 }]}>إرسال تطبيق</Text>
          </View>

          <TextInput
            value={appSearch}
            onChangeText={setAppSearch}
            placeholder="ابحث عن تطبيق"
            placeholderTextColor="#8696A0"
            style={styles.appSearch}
          />

          {appsLoading ? (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              <ActivityIndicator size="large" color={WA.greenLight} />
              <Text style={{ color: WA.subText, marginTop: 12 }}>جاري قراءة التطبيقات…</Text>
            </View>
          ) : (
            <FlatList
              data={apps.filter(a => !appSearch || (a.appName || '').toLowerCase().includes(appSearch.toLowerCase()))}
              keyExtractor={a => a.packageName}
              renderItem={({ item: app }) => (
                <TouchableOpacity
                  style={styles.appRow}
                  onPress={() => { setAppsOpen(false); onSendApp(app); }}
                >
                  <View style={styles.appIcon}>
                    <Text style={{ fontSize: 20 }}>📦</Text>
                  </View>
                  <View style={{ flex: 1, marginHorizontal: 12 }}>
                    <Text style={styles.appName} numberOfLines={1}>{app.appName}</Text>
                    <Text style={styles.appMeta}>{formatSize(app.size)}</Text>
                  </View>
                  <Text style={styles.appSend}>إرسال</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={{ textAlign: 'center', color: WA.subText, marginTop: 30 }}>
                  لا توجد تطبيقات مطابقة
                </Text>
              }
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: WA.chatBg },

  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: WA.green, paddingHorizontal: 6, paddingVertical: 8,
    elevation: 4,
  },
  backBtn: { padding: 6 },
  backIcon: { color: '#fff', fontSize: 22 },
  avatar: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: '#B5CBC5',
    justifyContent: 'center', alignItems: 'center',
  },
  avatarText: { color: WA.green, fontWeight: '700', fontSize: 17 },
  headerName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  headerStatus: { color: 'rgba(255,255,255,0.85)', fontSize: 12 },
  headerBtn: { padding: 8 },
  headerIcon: { fontSize: 18 },
  menuIcon: { color: '#fff', fontSize: 27, lineHeight: 27 },
  menuRoot: { flex: 1 },
  menuBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.12)' },
  menuCard: {
    position: 'absolute', top: 48, right: 8, width: 175,
    backgroundColor: '#fff', borderRadius: 8, elevation: 8, overflow: 'hidden',
  },
  menuItem: { paddingHorizontal: 18, paddingVertical: 15 },
  menuItemText: { color: WA.text, fontSize: 15, textAlign: 'right' },
  menuDangerText: { color: WA.danger, fontSize: 15, textAlign: 'right', fontWeight: '600' },
  menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#E8ECEE' },

  chatArea: { flex: 1, backgroundColor: WA.chatBg },
  emptyBox: { alignItems: 'center', marginTop: 24, paddingHorizontal: 30 },
  emptyText: {
    backgroundColor: '#FFF3C4', color: '#5B5343', fontSize: 12,
    textAlign: 'center', padding: 10, borderRadius: 8, overflow: 'hidden',
  },

  row: { width: '100%' },
  bubble: {
    maxWidth: '82%', paddingHorizontal: 9, paddingTop: 6, paddingBottom: 4,
    borderRadius: 8, marginVertical: 2, elevation: 1,
  },
  outBubble: { alignSelf: 'flex-end', backgroundColor: WA.outBubble, borderTopRightRadius: 0 },
  inBubble: { alignSelf: 'flex-start', backgroundColor: WA.inBubble, borderTopLeftRadius: 0 },
  msgText: { color: WA.text, fontSize: 15, lineHeight: 20 },

  metaRow: { flexDirection: 'row-reverse', alignItems: 'center', alignSelf: 'flex-start', marginTop: 2 },
  metaTime: { fontSize: 11, color: WA.subText, marginRight: 4 },
  metaTick: { fontSize: 11, marginLeft: 3 },

  voiceBubble: { flexDirection: 'row-reverse', alignItems: 'center', minWidth: 230 },
  playBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#F0F0F0', justifyContent: 'center', alignItems: 'center' },
  playIcon: { fontSize: 14, color: WA.green },
  waveform: { flexDirection: 'row', alignItems: 'center', height: 24, gap: 2 },
  waveBar: { width: 2.5, backgroundColor: '#9AAAB2', borderRadius: 2 },

  mediaBubble: { padding: 3 },
  imagePreview: { width: 220, height: 220, borderRadius: 6 },
  imagePlaceholder: {
    width: 220, height: 220, borderRadius: 6, backgroundColor: '#9AAAB2',
    justifyContent: 'center', alignItems: 'center', gap: 8,
  },
  placeholderText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  mediaMeta: { position: 'absolute', bottom: 8, left: 10 },

  callBubble: { flexDirection: 'row-reverse', alignItems: 'center', minWidth: 230 },
  callIconBox: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.05)',
    justifyContent: 'center', alignItems: 'center',
  },
  callIconMissed: { backgroundColor: 'rgba(224,69,63,0.12)' },
  callTitle: { color: WA.text, fontSize: 14, fontWeight: '600' },
  callSub: { color: WA.subText, fontSize: 12, marginTop: 2 },

  fileRow: { flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.04)', borderRadius: 6, padding: 8 },
  fileIconBox: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.06)', justifyContent: 'center', alignItems: 'center' },
  fileName: { color: WA.text, fontWeight: '600', fontSize: 14 },
  fileSub: { color: WA.subText, fontSize: 11, marginTop: 2 },

  progressTrack: { height: 3, backgroundColor: 'rgba(0,0,0,0.12)', borderRadius: 2, marginTop: 6, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: WA.greenLight },

  recordBar: { flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: '#FFEBEE', padding: 10, gap: 8 },
  recordDot: { fontSize: 12 },
  recordText: { color: WA.danger, fontSize: 13, fontWeight: '600' },

  inputRow: { flexDirection: 'row-reverse', alignItems: 'flex-end', padding: 6, gap: 6, backgroundColor: WA.chatBg },
  inputPill: {
    flex: 1, flexDirection: 'row-reverse', alignItems: 'center',
    backgroundColor: WA.inputBg, borderRadius: 24, paddingHorizontal: 6, minHeight: 48,
    elevation: 1,
  },
  input: { flex: 1, fontSize: 15, color: WA.text, paddingHorizontal: 8, maxHeight: 110, textAlign: 'right' },
  pillBtn: { padding: 8 },
  pillIcon: { fontSize: 20 },
  sendCircle: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: WA.greenLight,
    justifyContent: 'center', alignItems: 'center', elevation: 2,
  },
  sendCircleRec: { backgroundColor: WA.danger },
  sendIcon: { fontSize: 20, color: '#fff' },

  viewerRoot: { flex: 1, backgroundColor: '#000' },
  viewerBar: { flexDirection: 'row-reverse', alignItems: 'center', paddingTop: 36, paddingBottom: 12, paddingHorizontal: 8, backgroundColor: 'rgba(0,0,0,0.85)' },
  viewerTitle: { flex: 1, color: '#fff', fontSize: 15, marginHorizontal: 10, textAlign: 'right' },
  viewerAction: { color: WA.tick, fontSize: 13, fontWeight: '600' },
  viewerBody: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  viewerImage: { width: '100%', height: '100%' },

  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 34, paddingTop: 10 },
  sheetGrip: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#D5DBDE', alignSelf: 'center', marginBottom: 18 },
  sheetGrid: { flexDirection: 'row-reverse', flexWrap: 'wrap', paddingHorizontal: 20, gap: 24 },
  sheetItem: { alignItems: 'center', width: 76, marginBottom: 18 },
  sheetIcon: { width: 54, height: 54, borderRadius: 27, justifyContent: 'center', alignItems: 'center' },
  sheetIconText: { fontSize: 24 },
  sheetLabel: { marginTop: 7, fontSize: 12, color: WA.subText },

  appSearch: {
    margin: 12, paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: '#F0F2F5', borderRadius: 22, fontSize: 15,
    color: WA.text, textAlign: 'right',
  },
  appRow: {
    flexDirection: 'row-reverse', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#EDF1F2',
  },
  appIcon: { width: 44, height: 44, borderRadius: 10, backgroundColor: '#F0F2F5', justifyContent: 'center', alignItems: 'center' },
  appName: { fontSize: 15, color: WA.text, fontWeight: '600' },
  appMeta: { fontSize: 12, color: WA.subText, marginTop: 2 },
  appSend: { color: WA.greenLight, fontWeight: '700', fontSize: 13 },
});
