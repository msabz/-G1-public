import React, { useEffect, useMemo, useState, useRef } from 'react';
import {
  View, StyleSheet, TouchableOpacity, Text, FlatList, TextInput,
  KeyboardAvoidingView, Platform, Image, Alert, StatusBar, ActivityIndicator, Modal,
  BackHandler, Share,
} from 'react-native';
import { playVoiceFile } from '../media/AudioClip';
import { WA } from '../theme';
import { useAppTheme } from '../theme/themeContext';
import { copyText } from '../services/Persistence';
import MessageActionSheet from './MessageActionSheet';
import {
  filterMessages,
  messagePreview,
  resolveReplyMessage,
  shareableMessageText,
} from '../messaging/messageModel';

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
  if (status === 'failed') {
    return (
      <Text
        style={[styles.metaTick, { color: WA.danger }]}
        accessibilityLabel="فشل إرسال الرسالة"
      >
        ✕
      </Text>
    );
  }
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

function ReplyQuote({ message, theme }) {
  return (
    <View
      style={[
        styles.replyQuote,
        { backgroundColor: theme.surfaceVariant, borderRightColor: theme.accent },
      ]}
      accessibilityLabel={`رد على: ${messagePreview(message)}`}
    >
      <Text style={[styles.replyAuthor, { color: theme.primaryLight }]}>
        {message?.sender === 'me' ? 'أنت' : 'الطرف الآخر'}
      </Text>
      <Text style={[styles.replyText, { color: theme.textSecondary }]} numberOfLines={2}>
        {messagePreview(message)}
      </Text>
    </View>
  );
}

function MessageBubble({ item, onOpenFile, onViewImage, onRedial, onLongPress, replyMessage, theme }) {
  const isMe = item.sender === 'me';
  const openMessageActions = () => onLongPress?.(item);
  const messageAccessibilityHint = onLongPress
    ? 'اضغط مطولاً أو استخدم إجراءات إمكانية الوصول لفتح خيارات الرسالة'
    : undefined;
  const messageAccessibilityActions = onLongPress
    ? [{ name: 'showMessageActions', label: 'فتح خيارات الرسالة' }]
    : undefined;
  const handleMessageAccessibilityAction = event => {
    if (event.nativeEvent.actionName === 'showMessageActions') openMessageActions();
  };
  const bubbleStyle = [
    styles.bubble,
    isMe ? styles.outBubble : styles.inBubble,
    { backgroundColor: isMe ? theme.chatBubbleMine : theme.chatBubblePeer },
  ];

  // ===== سجل مكالمة =====
  if (item.type === 'call') {
    const info = callInfo(item);
    return (
      <View style={styles.row}>
        <TouchableOpacity
          activeOpacity={info.missed ? 0.7 : 0.9}
          onPress={() => info.missed && onRedial && onRedial(info.isVideo)}
          onLongPress={openMessageActions}
          delayLongPress={350}
          style={[...bubbleStyle, styles.callBubble]}
          accessibilityRole="button"
          accessibilityLabel={`${info.title}. ${info.sub}`}
          accessibilityHint={messageAccessibilityHint}
          accessibilityActions={messageAccessibilityActions}
          onAccessibilityAction={handleMessageAccessibilityAction}
        >
          <View style={[styles.callIconBox, info.missed && styles.callIconMissed]}>
            <Text style={{ fontSize: 17 }}>
              {info.isVideo ? '🎥' : '📞'}
            </Text>
          </View>
          <View style={{ flex: 1, marginRight: 10 }}>
            <Text style={[styles.callTitle, { color: theme.text }]}>{info.title}</Text>
            <Text style={[styles.callSub, { color: theme.textSecondary }, info.missed && { color: theme.error }]}>{info.sub}</Text>
          </View>
          <Text style={styles.metaTime}>{formatTime(item.time)}</Text>
        </TouchableOpacity>
      </View>
    );
  }
  // ===== رسالة صوتية =====
  if (item.type === 'voice') {
    const busy = item.progress != null && item.progress < 1;
    return (
      <View style={styles.row}>
        <TouchableOpacity
          activeOpacity={0.9}
          onLongPress={openMessageActions}
          delayLongPress={350}
          style={[...bubbleStyle, styles.voiceBubble]}
          accessibilityRole="button"
          accessibilityLabel="رسالة صوتية"
          accessibilityHint={messageAccessibilityHint}
          accessibilityActions={messageAccessibilityActions}
          onAccessibilityAction={handleMessageAccessibilityAction}
        >
          <TouchableOpacity
            disabled={busy || !item.path}
            onPress={async () => {
              try { await playVoiceFile(item.path); }
              catch (e) { Alert.alert('تعذّر التشغيل', e?.message || ''); }
            }}
            style={styles.playBtn}
            accessibilityRole="button"
            accessibilityLabel="تشغيل الرسالة الصوتية"
            accessibilityState={{ disabled: busy || !item.path }}
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
        </TouchableOpacity>
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
          onPress={() => !busy && (item.path || item.localUri) && onViewImage && onViewImage(item)}
          onLongPress={openMessageActions}
          delayLongPress={350}
          style={[...bubbleStyle, styles.mediaBubble]}
          accessibilityRole="imagebutton"
          accessibilityLabel={item.fileName || 'صورة'}
          accessibilityHint={messageAccessibilityHint}
          accessibilityActions={messageAccessibilityActions}
          onAccessibilityAction={handleMessageAccessibilityAction}
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
          onPress={() => canOpen && onOpenFile && onOpenFile(item)}
          onLongPress={openMessageActions}
          delayLongPress={350}
          style={[...bubbleStyle, { minWidth: 230 }]}
          accessibilityRole="button"
          accessibilityLabel={item.fileName || 'ملف'}
          accessibilityHint={messageAccessibilityHint}
          accessibilityActions={messageAccessibilityActions}
          onAccessibilityAction={handleMessageAccessibilityAction}
        >
          <View style={[styles.fileRow, { backgroundColor: theme.surfaceVariant }]}>
            <View style={styles.fileIconBox}>
              <Text style={{ fontSize: 22 }}>{isAppFile(item) ? '📦' : '📄'}</Text>
            </View>
            <View style={{ flex: 1, marginRight: 10 }}>
              <Text style={[styles.fileName, { color: theme.text }]} numberOfLines={1}>{item.fileName}</Text>
              <Text style={[styles.fileSub, { color: theme.textSecondary }]}>
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
      <TouchableOpacity
        activeOpacity={0.9}
        onLongPress={openMessageActions}
        delayLongPress={350}
        style={bubbleStyle}
        accessibilityRole="button"
        accessibilityLabel={`${isMe ? 'رسالتك' : 'رسالة واردة'}: ${item.text}`}
        accessibilityHint={messageAccessibilityHint}
        accessibilityActions={messageAccessibilityActions}
        onAccessibilityAction={handleMessageAccessibilityAction}
      >
        {item.replyToMessageId ? (
          <ReplyQuote message={replyMessage} theme={theme} />
        ) : null}
        <Text style={[styles.msgText, { color: isMe ? theme.chatTextMine : theme.chatTextPeer }]}>
          {item.text}
        </Text>
        <MessageMeta item={item} />
      </TouchableOpacity>
    </View>
  );
}

export default function ChatScreen({
  messages, onSendMessage, onStartVideoCall, onStartVoiceCall,
  onBack, onDisconnect, onPickFile, activeTier,
  isRecording, onStartRecording, onStopRecording, peerName,
  onCaptureImage, onLoadApps, onSendApp, onOpenFile, onOpenProbe,
  onDeleteMessage, onClearConversation,
}) {
  const { theme, mode, isDark, setThemeMode } = useAppTheme();
  const [msgText, setMsgText] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const [apps, setApps] = useState([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appSearch, setAppSearch] = useState('');
  const [viewerImage, setViewerImage] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [actionMessage, setActionMessage] = useState(null);
  const [replyTarget, setReplyTarget] = useState(null);
  const listRef = useRef(null);
  const tierLabel = activeTier === 'WIFI_DIRECT'
    ? 'متصل عبر واي فاي مباشر'
    : activeTier === 'BLUETOOTH'
      ? 'متصل عبر Bluetooth'
        : activeTier === 'LAN'
          ? 'متصل عبر الشبكة المحلية'
          : 'متصل';
  const mediaEnabled = activeTier !== 'BLUETOOTH';
  const hasText = msgText.trim().length > 0;
  const visibleMessages = useMemo(
    () => filterMessages(messages, searchQuery),
    [messages, searchQuery]
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  useEffect(() => {
    if (mediaEnabled) return;
    setSheetOpen(false);
    setAppsOpen(false);
    if (isRecording) onStopRecording?.();
  }, [isRecording, mediaEnabled, onStopRecording]);

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

  const cycleTheme = () => {
    const nextMode = mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system';
    setThemeMode(nextMode);
  };

  const closeActionMenu = () => setActionMessage(null);

  const replyToSelectedMessage = () => {
    const selected = actionMessage;
    closeActionMenu();
    if (selected) setReplyTarget(selected);
  };

  const shareMessage = async () => {
    const selected = actionMessage;
    closeActionMenu();
    const text = shareableMessageText(selected);
    if (!text) return;
    try {
      await Share.share({ message: text, title: selected?.fileName || 'DirectChat' });
    } catch (error) {
      Alert.alert('تعذّرت المشاركة', error?.message || '');
    }
  };

  const copyMessage = async () => {
    const text = shareableMessageText(actionMessage);
    closeActionMenu();
    if (!text) return;
    const copied = await copyText(text);
    if (!copied) Alert.alert('تعذّر النسخ', 'لم يتمكن النظام من نسخ محتوى الرسالة.');
  };

  const deleteSelectedMessage = () => {
    const selected = actionMessage;
    closeActionMenu();
    if (!selected?.messageId) return;
    Alert.alert('حذف الرسالة محلياً؟', 'ستُحذف من هذا الجهاز فقط.', [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'حذف',
        style: 'destructive',
        onPress: async () => {
          const deleted = await onDeleteMessage?.(selected.messageId);
          if (deleted === false) Alert.alert('تعذّر الحذف', 'بقيت الرسالة محفوظة على هذا الجهاز.');
        },
      },
    ]);
  };

  const clearConversation = () => {
    setMenuOpen(false);
    Alert.alert('مسح المحادثة محلياً؟', 'لن تُحذف الرسائل من الجهاز الآخر.', [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'مسح',
        style: 'destructive',
        onPress: async () => {
          const cleared = await onClearConversation?.();
          if (cleared === false) Alert.alert('تعذّر المسح', 'بقيت المحادثة محفوظة على هذا الجهاز.');
        },
      },
    ]);
  };

  const sendText = () => {
    const text = msgText.trim();
    if (!text) return;
    onSendMessage({ text, replyToMessageId: replyTarget?.messageId || null });
    setMsgText('');
    setReplyTarget(null);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <StatusBar backgroundColor={theme.primaryDark} barStyle={theme.statusBar} />

      {/* ===== الشريط العلوي ===== */}
      <View style={[styles.header, { backgroundColor: theme.primaryDark }]}>
        <TouchableOpacity
          onPress={onBack}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="العودة إلى المحادثات"
        >
          <Text style={styles.backIcon}>←</Text>
        </TouchableOpacity>

        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(peerName || 'M')[0].toUpperCase()}</Text>
        </View>

        <View style={{ flex: 1, marginHorizontal: 10 }}>
          <Text style={styles.headerName} numberOfLines={1}>{peerName || 'Musabchat'}</Text>
          <Text style={styles.headerStatus} numberOfLines={1}>{tierLabel}</Text>
        </View>

        <TouchableOpacity
          onPress={mediaEnabled ? onStartVideoCall : undefined}
          disabled={!mediaEnabled}
          style={[styles.headerBtn, !mediaEnabled && { opacity: 0.35 }]}
          accessibilityRole="button"
          accessibilityLabel="بدء مكالمة فيديو"
          accessibilityState={{ disabled: !mediaEnabled }}
        >
          <Text style={styles.headerIcon}>🎥</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={mediaEnabled ? onStartVoiceCall : undefined}
          disabled={!mediaEnabled}
          style={[styles.headerBtn, !mediaEnabled && { opacity: 0.35 }]}
          accessibilityRole="button"
          accessibilityLabel="بدء مكالمة صوتية"
          accessibilityState={{ disabled: !mediaEnabled }}
        >
          <Text style={styles.headerIcon}>📞</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setMenuOpen(true)}
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel="خيارات المحادثة"
        >
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
          <View style={[styles.menuCard, { backgroundColor: theme.surface }]}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                setSearchOpen(true);
              }}
            >
              <Text style={[styles.menuItemText, { color: theme.text }]}>البحث في المحادثة</Text>
            </TouchableOpacity>
            <View style={[styles.menuDivider, { backgroundColor: theme.border }]} />
            <TouchableOpacity style={styles.menuItem} onPress={cycleTheme}>
              <Text style={[styles.menuItemText, { color: theme.text }]}>المظهر: {mode === 'system' ? 'النظام' : isDark ? 'داكن' : 'فاتح'}</Text>
            </TouchableOpacity>
            <View style={[styles.menuDivider, { backgroundColor: theme.border }]} />
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => { setMenuOpen(false); onOpenProbe(); }}
            >
              <Text style={[styles.menuItemText, { color: theme.text }]}>فحص الاتصال</Text>
            </TouchableOpacity>
            <View style={[styles.menuDivider, { backgroundColor: theme.border }]} />
            <TouchableOpacity style={styles.menuItem} onPress={clearConversation}>
              <Text style={styles.menuDangerText}>مسح المحادثة محلياً</Text>
            </TouchableOpacity>
            <View style={[styles.menuDivider, { backgroundColor: theme.border }]} />
            <TouchableOpacity style={styles.menuItem} onPress={confirmDisconnect}>
              <Text style={styles.menuDangerText}>قطع الاتصال</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {searchOpen ? (
        <View style={[styles.searchBar, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <TouchableOpacity
            onPress={() => {
              setSearchOpen(false);
              setSearchQuery('');
            }}
            style={styles.searchClose}
            accessibilityRole="button"
            accessibilityLabel="إغلاق البحث"
          >
            <Text style={[styles.searchCloseText, { color: theme.primary }]}>✕</Text>
          </TouchableOpacity>
          <TextInput
            autoFocus
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="ابحث في الرسائل والملفات"
            placeholderTextColor={theme.textMuted}
            style={[styles.searchInput, { color: theme.text, backgroundColor: theme.surfaceVariant }]}
            accessibilityLabel="بحث في المحادثة"
          />
          <Text style={[styles.searchCount, { color: theme.textSecondary }]}>
            {visibleMessages.length}/{messages.length}
          </Text>
        </View>
      ) : null}

      <MessageActionSheet
        visible={!!actionMessage}
        message={actionMessage}
        theme={theme}
        onClose={closeActionMenu}
        onReply={replyToSelectedMessage}
        onCopy={copyMessage}
        onShare={shareMessage}
        onDelete={deleteSelectedMessage}
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* ===== منطقة الرسائل ===== */}
        <View style={[styles.chatArea, { backgroundColor: theme.background }]}>
          <FlatList
            ref={listRef}
            data={visibleMessages}
            renderItem={({ item }) => (
              <MessageBubble
                item={item}
                onOpenFile={onOpenFile}
                onViewImage={setViewerImage}
                onRedial={mediaEnabled
                  ? (v) => (v ? onStartVideoCall() : onStartVoiceCall())
                  : undefined}
                onLongPress={setActionMessage}
                replyMessage={resolveReplyMessage(messages, item.replyToMessageId)}
                theme={theme}
              />
            )}
            keyExtractor={(item, i) => item.messageId || `${item.time || 'message'}:${i}`}
            contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 8 }}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            ListEmptyComponent={
              <View style={styles.emptyBox}>
                <Text style={styles.emptyText}>
                  {searchQuery
                    ? 'لا توجد نتائج مطابقة'
                    : '🔒 الرسائل تُنقل مباشرة بين الجهازين بدون أي خادم وسيط'}
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

        {replyTarget ? (
          <View style={[styles.replyComposer, { backgroundColor: theme.surface, borderRightColor: theme.accent }]}>
            <TouchableOpacity
              onPress={() => setReplyTarget(null)}
              style={styles.replyDismiss}
              accessibilityRole="button"
              accessibilityLabel="إلغاء الرد"
            >
              <Text style={[styles.replyDismissText, { color: theme.textMuted }]}>✕</Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={[styles.replyAuthor, { color: theme.primaryLight }]}>الرد على رسالة</Text>
              <Text style={[styles.replyText, { color: theme.textSecondary }]} numberOfLines={2}>
                {messagePreview(replyTarget)}
              </Text>
            </View>
          </View>
        ) : null}

        <View style={[styles.inputRow, { backgroundColor: theme.background }]}>
          <View style={[styles.inputPill, { backgroundColor: theme.surface }]}>
            <TouchableOpacity
              onPress={mediaEnabled ? () => setSheetOpen(true) : undefined}
              disabled={!mediaEnabled}
              style={[styles.pillBtn, !mediaEnabled && { opacity: 0.35 }]}
              accessibilityRole="button"
              accessibilityLabel="إرفاق ملف أو تطبيق"
              accessibilityState={{ disabled: !mediaEnabled }}
            >
              <Text style={styles.pillIcon}>📎</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={mediaEnabled ? onCaptureImage : undefined}
              disabled={!mediaEnabled}
              style={[styles.pillBtn, !mediaEnabled && { opacity: 0.35 }]}
              accessibilityRole="button"
              accessibilityLabel="التقاط صورة"
              accessibilityState={{ disabled: !mediaEnabled }}
            >
              <Text style={styles.pillIcon}>📷</Text>
            </TouchableOpacity>
            <TextInput
              value={msgText}
              onChangeText={setMsgText}
              placeholder="رسالة"
              placeholderTextColor="#8696A0"
              style={[styles.input, { color: theme.text }]}
              multiline
              accessibilityLabel="نص الرسالة"
            />
          </View>

          {hasText ? (
            <TouchableOpacity
              onPress={sendText}
              style={[styles.sendCircle, { backgroundColor: theme.primaryLight }]}
              accessibilityRole="button"
              accessibilityLabel="إرسال الرسالة"
            >
              <Text style={styles.sendIcon}>➤</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPressIn={mediaEnabled ? onStartRecording : undefined}
              onPressOut={mediaEnabled ? onStopRecording : undefined}
              disabled={!mediaEnabled}
              style={[
                styles.sendCircle,
                { backgroundColor: theme.primaryLight },
                isRecording && styles.sendCircleRec,
                !mediaEnabled && { opacity: 0.35 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="اضغط باستمرار لتسجيل رسالة صوتية"
              accessibilityState={{ disabled: !mediaEnabled }}
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
      <Modal visible={mediaEnabled && sheetOpen} transparent animationType="fade" onRequestClose={() => setSheetOpen(false)}>
        <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setSheetOpen(false)}>
          <View style={[styles.sheet, { backgroundColor: theme.surface }]}>
            <View style={styles.sheetGrip} />
            <View style={styles.sheetGrid}>
              <TouchableOpacity
                style={styles.sheetItem}
                onPress={() => {
                  setSheetOpen(false);
                  if (!mediaEnabled) return;
                  onPickFile?.();
                }}
              >
                <View style={[styles.sheetIcon, { backgroundColor: '#7F66FF' }]}>
                  <Text style={styles.sheetIconText}>📄</Text>
                </View>
                <Text style={[styles.sheetLabel, { color: theme.textSecondary }]}>مستند</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.sheetItem}
                onPress={() => {
                  setSheetOpen(false);
                  if (!mediaEnabled) return;
                  onCaptureImage?.();
                }}
              >
                <View style={[styles.sheetIcon, { backgroundColor: '#E0453F' }]}>
                  <Text style={styles.sheetIconText}>📷</Text>
                </View>
                <Text style={[styles.sheetLabel, { color: theme.textSecondary }]}>كاميرا</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.sheetItem}
                onPress={async () => {
                  setSheetOpen(false);
                  if (!mediaEnabled) return;
                  setAppsOpen(true);
                  setAppsLoading(true);
                  try {
                    const list = await onLoadApps?.();
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
                <Text style={[styles.sheetLabel, { color: theme.textSecondary }]}>تطبيق</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ===== منتقي التطبيقات المثبتة ===== */}
      <Modal visible={mediaEnabled && appsOpen} animationType="slide" onRequestClose={() => setAppsOpen(false)}>
        <View style={{ flex: 1, backgroundColor: theme.background }}>
          <View style={[styles.header, { backgroundColor: theme.primaryDark }]}>
            <TouchableOpacity onPress={() => setAppsOpen(false)} style={styles.backBtn}>
              <Text style={styles.backIcon}>←</Text>
            </TouchableOpacity>
            <Text style={[styles.headerName, { flex: 1, marginHorizontal: 10 }]}>إرسال تطبيق</Text>
          </View>

          <TextInput
            value={appSearch}
            onChangeText={setAppSearch}
            placeholder="ابحث عن تطبيق"
            placeholderTextColor={theme.textMuted}
            style={[styles.appSearch, { backgroundColor: theme.surfaceVariant, color: theme.text }]}
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
                  style={[styles.appRow, { borderBottomColor: theme.borderSubtle }]}
                  onPress={() => {
                    setAppsOpen(false);
                    if (!mediaEnabled) return;
                    onSendApp?.(app);
                  }}
                >
                  <View style={styles.appIcon}>
                    <Text style={{ fontSize: 20 }}>📦</Text>
                  </View>
                  <View style={{ flex: 1, marginHorizontal: 12 }}>
                    <Text style={[styles.appName, { color: theme.text }]} numberOfLines={1}>{app.appName}</Text>
                    <Text style={[styles.appMeta, { color: theme.textSecondary }]}>{formatSize(app.size)}</Text>
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

  searchBar: {
    minHeight: 58, flexDirection: 'row-reverse', alignItems: 'center',
    paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8,
  },
  searchClose: { width: 38, height: 38, justifyContent: 'center', alignItems: 'center' },
  searchCloseText: { fontSize: 20, fontWeight: '700' },
  searchInput: {
    flex: 1, minHeight: 42, borderRadius: 21, paddingHorizontal: 14,
    fontSize: 15, textAlign: 'right',
  },
  searchCount: { minWidth: 48, fontSize: 12, textAlign: 'center' },

  chatArea: { flex: 1, backgroundColor: WA.chatBg },
  emptyBox: { alignItems: 'center', marginTop: 24, paddingHorizontal: 30 },
  emptyText: {
    backgroundColor: '#FFF3C4', color: '#5B5343', fontSize: 12,
    textAlign: 'center', padding: 10, borderRadius: 8, overflow: 'hidden',
  },

  row: { width: '100%' },
  bubble: {
    maxWidth: '82%', paddingHorizontal: 9, paddingTop: 6, paddingBottom: 4,
    minHeight: 48, justifyContent: 'center',
    borderRadius: 8, marginVertical: 2, elevation: 1,
  },
  outBubble: { alignSelf: 'flex-end', backgroundColor: WA.outBubble, borderTopRightRadius: 0 },
  inBubble: { alignSelf: 'flex-start', backgroundColor: WA.inBubble, borderTopLeftRadius: 0 },
  msgText: {
    color: WA.text, fontSize: 15, lineHeight: 20,
    textAlign: 'right', writingDirection: 'auto',
  },
  replyQuote: {
    borderRightWidth: 3, borderRadius: 6, paddingHorizontal: 8,
    paddingVertical: 5, marginBottom: 5, minWidth: 150,
  },
  replyComposer: {
    flexDirection: 'row-reverse', alignItems: 'center', minHeight: 58,
    marginHorizontal: 8, marginTop: 5, paddingHorizontal: 10, paddingVertical: 7,
    borderRightWidth: 4, borderRadius: 8,
  },
  replyAuthor: { textAlign: 'right', fontSize: 12, fontWeight: '700' },
  replyText: {
    textAlign: 'right', writingDirection: 'auto', fontSize: 12, marginTop: 2,
  },
  replyDismiss: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
  replyDismissText: { fontSize: 18 },

  metaRow: { flexDirection: 'row-reverse', alignItems: 'center', alignSelf: 'flex-start', marginTop: 2 },
  metaTime: { fontSize: 11, color: WA.subText, marginRight: 4 },
  metaTick: { fontSize: 11, marginLeft: 3 },

  voiceBubble: { flexDirection: 'row-reverse', alignItems: 'center', minWidth: 230 },
  playBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#F0F0F0', justifyContent: 'center', alignItems: 'center' },
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
  fileName: {
    color: WA.text, fontWeight: '600', fontSize: 14,
    textAlign: 'right', writingDirection: 'auto',
  },
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
