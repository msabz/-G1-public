import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  StatusBar, ActivityIndicator, Modal, RefreshControl, Alert, SafeAreaView, ScrollView,
} from 'react-native';
import { useAppTheme } from '../theme/themeContext';
import { Avatar } from './common/Avatar';
import { Badge } from './common/Badge';
import { Button } from './common/Button';
import { NearbyPeersList } from './discovery/NearbyPeersList';
import { DeveloperDiagnosticsModal } from './discovery/DeveloperDiagnosticsModal';

const P2P_PEER_DISPLAY_GRACE_MS = 6000;

function formatWhen(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    let h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'م' : 'ص';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'أمس';
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

export default function ContactsScreen({
  peers = [],
  discovered = [],
  scanning = false,
  onRefresh,
  onOpenChat,
  onScanNew,
  onConnectLan,
  deviceName = 'جهازي',
  wifiDirectEnabled = true,
  statusText = '',
  activePeer = null,
  unreadCount = 0,
  localIp = '127.0.0.1',
  btDevices = [],
  onSelectBtDevice,
  callRecords = [],
  onDeleteCallRecord,
  onClearCallHistory,
}) {
  const { theme, isDark, setThemeMode, mode } = useAppTheme();
  const [activeTab, setActiveTab] = useState('chats'); // 'chats', 'discovery', 'calls'
  const [lanModalVisible, setLanModalVisible] = useState(false);
  const [addPeerOpen, setAddPeerOpen] = useState(false);
  const [visibleDiscovered, setVisibleDiscovered] = useState(discovered);
  const visibleDiscoveredRef = useRef({});
  const peerExpiryTimerRef = useRef(null);
  const previousScanningRef = useRef(scanning);

  const toggleTheme = () => {
    setThemeMode(isDark ? 'light' : 'dark');
  };

  // requestPeers() is a point-in-time snapshot. A transient empty snapshot must
  // not make a peer visually blink out, but it must never leave a stale route
  // connectable. Keep a short display-only grace with available=false, and
  // discard the cache immediately when a new user scan begins.
  useEffect(() => {
    const now = Date.now();
    const newScanStarted = scanning && !previousScanningRef.current;
    previousScanningRef.current = scanning;
    const previous = newScanStarted ? {} : visibleDiscoveredRef.current;
    const next = {};

    (discovered || []).forEach((peer, index) => {
      const key = String(
        peer?.deviceAddress || peer?.peerId || peer?.deviceName || `peer:${index}`
      ).toLowerCase();
      next[key] = {
        ...(previous[key] || {}),
        ...peer,
        lastSeenAt: now,
        transientMissing: false,
      };
    });

    if (!newScanStarted) {
      Object.entries(previous).forEach(([key, peer]) => {
        if (next[key]) return;
        const lastSeenAt = Number(peer?.lastSeenAt) || 0;
        if (lastSeenAt > 0 && now - lastSeenAt < P2P_PEER_DISPLAY_GRACE_MS) {
          next[key] = {
            ...peer,
            available: false,
            transientMissing: true,
          };
        }
      });
    }

    visibleDiscoveredRef.current = next;
    setVisibleDiscovered(Object.values(next));

    if (peerExpiryTimerRef.current) {
      clearTimeout(peerExpiryTimerRef.current);
      peerExpiryTimerRef.current = null;
    }

    const scheduleNextExpiry = () => {
      const snapshot = visibleDiscoveredRef.current;
      const stalePeers = Object.values(snapshot).filter(
        peer => peer.transientMissing === true && Number(peer.lastSeenAt) > 0
      );
      if (!stalePeers.length) return;

      const nextExpiryAt = Math.min(
        ...stalePeers.map(peer => Number(peer.lastSeenAt) + P2P_PEER_DISPLAY_GRACE_MS)
      );
      const waitMs = Math.max(50, nextExpiryAt - Date.now() + 25);
      peerExpiryTimerRef.current = setTimeout(() => {
        peerExpiryTimerRef.current = null;
        const cutoff = Date.now();
        const pruned = Object.fromEntries(
          Object.entries(visibleDiscoveredRef.current).filter(([, peer]) => (
            peer.transientMissing !== true ||
            cutoff - Number(peer.lastSeenAt || 0) < P2P_PEER_DISPLAY_GRACE_MS
          ))
        );
        visibleDiscoveredRef.current = pruned;
        setVisibleDiscovered(Object.values(pruned));
        scheduleNextExpiry();
      }, waitMs);
    };

    scheduleNextExpiry();
  }, [discovered, scanning]);

  useEffect(() => () => {
    if (peerExpiryTimerRef.current) clearTimeout(peerExpiryTimerRef.current);
  }, []);

  const samePeer = (a, b) => {
    if (!a || !b) return false;
    if (a.peerId && b.peerId && a.peerId === b.peerId) return true;
    return !!a.deviceAddress && !!b.deviceAddress &&
      a.deviceAddress.toLowerCase() === b.deviceAddress.toLowerCase();
  };

  const displayPeers = (peers || []).map((p) =>
    samePeer(p, activePeer)
      ? {
          ...p,
          ...activePeer,
          peerId: activePeer.peerId || p.peerId,
          customName: p.customName || activePeer.customName,
          connected: true,
          unreadCount: unreadCount || 0,
        }
      : p
  );

  if (activePeer && !displayPeers.some((p) => samePeer(p, activePeer))) {
    displayPeers.unshift({
      ...activePeer,
      peerId: activePeer.peerId || `active:${activePeer.deviceAddress || 'current'}`,
      customName: activePeer.customName || activePeer.deviceName || 'جهاز متصل',
      connected: true,
      unreadCount: unreadCount || 0,
      transport: activePeer.transport || 'wifi',
    });
  }

  const renderChatItem = ({ item }) => {
    const name = item.customName || item.deviceName || item.name || item.peerId || 'جهة اتصال';
    const isConnected = !!item.connected;
    const lastMsg = item.lastMessage || (isConnected ? 'متصل وجاهز للمحادثة' : 'غير متصل');
    const timeStr = formatWhen(item.lastSeen || item.lastMessageTime || Date.now());

    return (
      <TouchableOpacity
        activeOpacity={0.7}
        style={[styles.chatRow, { backgroundColor: theme.surface, borderBottomColor: theme.borderSubtle }]}
        onPress={() => onOpenChat && onOpenChat(item)}
      >
        <Avatar
          name={name}
          size={52}
          isOnline={isConnected}
          transportType={item.transport || (item.deviceAddress?.includes('.') ? 'lan' : 'wifidirect')}
        />

        <View style={styles.chatInfo}>
          <View style={styles.chatHeaderRow}>
            <Text style={[styles.chatName, { color: theme.text }]} numberOfLines={1}>{name}</Text>
            <Text style={[styles.chatTime, { color: isConnected ? theme.accent : theme.textMuted }]}>
              {timeStr}
            </Text>
          </View>

          <View style={styles.chatSubRow}>
            <Text
              style={[
                styles.lastMsgText,
                { color: isConnected ? theme.primaryLight : theme.textSecondary, fontWeight: isConnected ? '600' : '400' },
              ]}
              numberOfLines={1}
            >
              {lastMsg}
            </Text>
            {item.unreadCount > 0 ? (
              <Badge count={item.unreadCount} variant="accent" />
            ) : isConnected ? (
              <View style={[styles.connectedPill, { backgroundColor: theme.surfaceVariant }]}>
                <Text style={{ color: theme.accent, fontSize: 11, fontWeight: '700' }}>متصل ⚡</Text>
              </View>
            ) : null}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderDiscoveryTab = () => (
    <ScrollView style={styles.tabContent} showsVerticalScrollIndicator={false}>
      {/* Zero-Config Nearby Devices */}
      <NearbyPeersList
        isScanning={scanning}
        activePeerId={activePeer?.deviceId || activePeer?.peerId}
        onSelectPeer={(peer) => onOpenChat && onOpenChat(peer)}
      />

      {/* Wi-Fi Direct Nearby Peers */}
      <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border, marginTop: 14 }]}>
        <View style={styles.sectionHeaderRow}>
          <Text style={[styles.sectionTitle, { color: theme.primary }]}>📶 أجهزة Wi-Fi Direct المجاورة (P2P)</Text>
          {scanning && <ActivityIndicator size="small" color={theme.accent} />}
        </View>

        {visibleDiscovered.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={[styles.emptyText, { color: theme.textMuted }]}>
              {scanning ? 'جاري البحث عن أجهزة قريبة...' : 'لم يتم العثور على أجهزة بعد. اضغط "بحث جديد" بالأسفل.'}
            </Text>
          </View>
        ) : (
          visibleDiscovered.map((d, index) => {
            const dName = d.deviceName || d.name || d.deviceAddress || 'جهاز مجاور';
            const isConfirmed = d.isMusab === true;
            const isAvailable = d.available === true;
            const isTransient = d.transientMissing === true;
            const statusLabel = isTransient
              ? 'شوهد قبل لحظات — جارٍ التحقق'
              : isAvailable && isConfirmed
                ? '✓ DirectChat مؤكد'
                : isAvailable
                  ? 'جهاز Wi-Fi Direct قريب — غير مؤكد كـ DirectChat'
                  : isConfirmed
                    ? 'DirectChat مؤكد — غير متاح الآن'
                    : 'جهاز Wi-Fi Direct — غير متاح الآن';
            return (
              <TouchableOpacity
                key={d.deviceAddress || index}
                activeOpacity={isAvailable ? 0.7 : 1}
                disabled={!isAvailable}
                style={[styles.peerRow, { borderBottomColor: theme.borderSubtle }]}
                onPress={isAvailable ? () => onOpenChat && onOpenChat(d) : undefined}
              >
                <Avatar
                  name={dName}
                  size={46}
                  transportType="wifidirect"
                  isOnline={isConfirmed && isAvailable}
                />
                <View style={styles.peerInfo}>
                  <Text style={[styles.peerName, { color: theme.text }]}>{dName}</Text>
                  <Text style={[
                    styles.peerStatus,
                    { color: isConfirmed && isAvailable ? theme.accent : theme.textMuted },
                  ]}>
                    {statusLabel}
                  </Text>
                </View>
                <Button
                  title={isAvailable ? 'اتصال' : 'غير متاح'}
                  size="small"
                  variant={isConfirmed && isAvailable ? 'primary' : 'secondary'}
                  disabled={!isAvailable}
                  onPress={isAvailable ? () => onOpenChat && onOpenChat(d) : undefined}
                />
              </TouchableOpacity>
            );
          })
        )}

        <Button
          title={scanning ? 'جاري التحديث...' : '🔄 إعادة البحث عن أجهزة'}
          variant="secondary"
          size="medium"
          loading={scanning}
          onPress={() => onScanNew && onScanNew()}
          style={{ marginTop: 10 }}
        />
      </View>

      {/* Bluetooth Fallback Devices */}
      {btDevices && btDevices.length > 0 && (
        <View style={[styles.sectionCard, { backgroundColor: theme.surface, borderColor: theme.border, marginTop: 14 }]}>
          <Text style={[styles.sectionTitle, { color: theme.primary }]}>ᛒ أجهزة بلوتوث المقترنة</Text>
          {btDevices.map((bt, i) => (
            <TouchableOpacity
              key={bt.address || i}
              style={[styles.peerRow, { borderBottomColor: theme.borderSubtle }]}
              onPress={() => onSelectBtDevice && onSelectBtDevice(bt)}
            >
              <Avatar name={bt.name || 'BT'} size={42} transportType="bluetooth" />
              <View style={styles.peerInfo}>
                <Text style={[styles.peerName, { color: theme.text }]}>{bt.name || 'Bluetooth Device'}</Text>
                <Text style={[styles.peerStatus, { color: theme.textMuted }]}>{bt.address}</Text>
              </View>
              <Button title="محادثة BT" size="small" variant="secondary" onPress={() => onSelectBtDevice && onSelectBtDevice(bt)} />
            </TouchableOpacity>
          ))}
        </View>
      )}
      <View style={{ height: 90 }} />
    </ScrollView>
  );

  const callStateLabel = record => {
    const state = record.finalState || record.state;
    const labels = {
      ended: 'انتهت',
      missed: 'فائتة',
      declined: 'مرفوضة',
      rejected: 'مرفوضة من الطرف الآخر',
      busy: 'مشغول',
      noanswer: 'بلا رد',
      cancelled: 'ملغاة',
      failed: 'فشلت',
      active: 'جارية',
      connected: 'متصلة',
      ringing: 'ترن',
    };
    return labels[state] || state || 'مكالمة';
  };

  const callDurationLabel = seconds => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!total) return '';
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return minutes ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${remainder} ث`;
  };

  const renderCallsTab = () => {
    if (!callRecords.length) {
      return (
        <View style={[styles.tabContent, styles.centerEmpty]}>
          <Text style={{ fontSize: 48, marginBottom: 12 }}>📞</Text>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>لا يوجد سجل مكالمات بعد</Text>
          <Text style={[styles.emptySubtitle, { color: theme.textSecondary }]}> 
            تظهر هنا المكالمات الصوتية والفيديو، بما فيها الفائتة والمرفوضة.
          </Text>
        </View>
      );
    }

    return (
      <FlatList
        style={styles.tabContent}
        data={callRecords}
        keyExtractor={(item, index) => item.callId || String(index)}
        contentContainerStyle={{ paddingBottom: 110 }}
        ListHeaderComponent={(
          <View style={styles.callHistoryHeader}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>سجل المكالمات</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="مسح سجل المكالمات"
              onPress={() => Alert.alert(
                'مسح سجل المكالمات',
                'هل تريد حذف جميع سجلات المكالمات من هذا الجهاز؟',
                [
                  { text: 'إلغاء', style: 'cancel' },
                  { text: 'مسح', style: 'destructive', onPress: () => onClearCallHistory?.() },
                ],
              )}
              style={styles.callDeleteButton}
            >
              <Text style={{ color: theme.danger || '#C62828', fontWeight: '700' }}>مسح الكل</Text>
            </TouchableOpacity>
          </View>
        )}
        renderItem={({ item }) => {
          const incoming = item.direction === 'incoming';
          const video = item.mediaType === 'video' || item.video === true;
          const stateLabel = callStateLabel(item);
          const duration = callDurationLabel(item.duration);
          const peerName = item.peerName || item.peerId || 'جهاز G1';
          return (
            <View
              accessible
              accessibilityLabel={`${incoming ? 'مكالمة واردة' : 'مكالمة صادرة'} ${video ? 'فيديو' : 'صوتية'} مع ${peerName}، ${stateLabel}`}
              style={[styles.callRow, { backgroundColor: theme.surface, borderBottomColor: theme.borderSubtle }]}
            >
              <Avatar name={peerName} size={46} />
              <View style={styles.callInfo}>
                <Text style={[styles.peerName, { color: theme.text }]} numberOfLines={1}>{peerName}</Text>
                <Text style={[styles.callMeta, { color: theme.textSecondary }]}>
                  {incoming ? '↙ واردة' : '↗ صادرة'} · {video ? 'فيديو' : 'صوت'} · {stateLabel}
                  {duration ? ` · ${duration}` : ''}
                </Text>
                <Text style={[styles.chatTime, { color: theme.textMuted }]}>{formatWhen(item.startedAt)}</Text>
              </View>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`حذف سجل المكالمة مع ${peerName}`}
                onPress={() => onDeleteCallRecord?.(item.callId)}
                style={styles.callDeleteButton}
              >
                <Text style={{ fontSize: 19 }}>🗑️</Text>
              </TouchableOpacity>
            </View>
          );
        }}
      />
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <StatusBar barStyle={theme.statusBar} backgroundColor={theme.primaryDark} />

      {/* DirectChat Top Header */}
      <View style={[styles.header, { backgroundColor: theme.primary }]}>
        <View style={styles.headerTop}>
          <Text style={styles.appTitle}>DirectChat</Text>
          <View style={styles.headerIcons}>
            <TouchableOpacity onPress={() => setLanModalVisible(true)} style={styles.iconBtn}>
              <Text style={styles.headerIconText}>🌐</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={toggleTheme} style={styles.iconBtn}>
              <Text style={styles.headerIconText}>{isDark ? '☀️' : '🌙'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onScanNew && onScanNew()} style={styles.iconBtn}>
              <Text style={styles.headerIconText}>🔍</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Status bar row */}
        {statusText ? (
          <View style={styles.statusBarRow}>
            <View style={styles.statusDot} />
            <Text style={styles.statusBarText} numberOfLines={1}>{statusText}</Text>
          </View>
        ) : null}

        {/* 3 Main Tabs */}
        <View style={styles.tabsRow}>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'chats' && styles.activeTabBtn]}
            onPress={() => setActiveTab('chats')}
          >
            <Text style={[styles.tabText, activeTab === 'chats' && styles.activeTabText]}>الدردشات</Text>
            {unreadCount > 0 && <Badge count={unreadCount} variant="accent" style={{ marginLeft: 4 }} />}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'discovery' && styles.activeTabBtn]}
            onPress={() => setActiveTab('discovery')}
          >
            <Text style={[styles.tabText, activeTab === 'discovery' && styles.activeTabText]}>الأجهزة والشبكة</Text>
            {visibleDiscovered.length > 0 && <Badge count={visibleDiscovered.length} variant="subtle" style={{ marginLeft: 4 }} />}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'calls' && styles.activeTabBtn]}
            onPress={() => setActiveTab('calls')}
          >
            <Text style={[styles.tabText, activeTab === 'calls' && styles.activeTabText]}>المكالمات</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Tab Body */}
      {activeTab === 'chats' ? (
        displayPeers.length === 0 ? (
          <View style={[styles.tabContent, styles.centerEmpty]}>
            <Text style={{ fontSize: 44, marginBottom: 12 }}>💬</Text>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>لا توجد محادثات نشطة</Text>
            <Text style={[styles.emptySubtitle, { color: theme.textSecondary }]}>
              انتقل لتبويب "الأجهزة والشبكة" أو اضغط على زر الواي فاي بالأسفل للاتصال بجهاز قريب.
            </Text>
            <Button
              title="🌐 اتصال عبر IP نفس الشبكة"
              variant="primary"
              size="medium"
              onPress={() => setLanModalVisible(true)}
              style={{ marginTop: 16 }}
            />
          </View>
        ) : (
          <FlatList
            data={displayPeers}
            keyExtractor={(item, index) => item.peerId || item.deviceAddress || String(index)}
            renderItem={renderChatItem}
            refreshControl={<RefreshControl refreshing={scanning} onRefresh={onRefresh} colors={[theme.primary]} />}
            contentContainerStyle={{ paddingBottom: 100 }}
          />
        )
      ) : activeTab === 'discovery' ? (
        renderDiscoveryTab()
      ) : (
        renderCallsTab()
      )}

      {/* Floating Action Buttons */}
      <View style={styles.fabContainer}>
        <TouchableOpacity
          activeOpacity={0.8}
          style={[styles.fabSecondary, { backgroundColor: theme.surfaceVariant }]}
          onPress={() => setLanModalVisible(true)}
        >
          <Text style={{ fontSize: 20 }}>🛠️</Text>
        </TouchableOpacity>

        <TouchableOpacity
          activeOpacity={0.8}
          style={[styles.fabPrimary, { backgroundColor: theme.accent }]}
          onPress={() => {
            setActiveTab('discovery');
            onScanNew && onScanNew();
          }}
        >
          <Text style={{ fontSize: 24, color: '#FFFFFF' }}>🔍</Text>
        </TouchableOpacity>
      </View>

      {/* Developer Diagnostics Modal */}
      <DeveloperDiagnosticsModal
        visible={lanModalVisible}
        onClose={() => setLanModalVisible(false)}
        onManualConnectLan={onConnectLan}
        myLocalIp={localIp}
        myDeviceName={deviceName}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingTop: 12,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  appTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  headerIcons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBtn: {
    padding: 6,
    marginLeft: 10,
  },
  headerIconText: {
    fontSize: 20,
  },
  statusBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#25D366',
    marginRight: 6,
  },
  statusBarText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 12,
    fontWeight: '600',
  },
  tabsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.15)',
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  activeTabBtn: {
    borderBottomWidth: 3,
    borderBottomColor: '#FFFFFF',
  },
  tabText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    fontWeight: '700',
  },
  activeTabText: {
    color: '#FFFFFF',
  },
  tabContent: {
    flex: 1,
    padding: 14,
  },
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 0.5,
  },
  chatInfo: {
    flex: 1,
    marginLeft: 14,
  },
  chatHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  chatName: {
    fontSize: 16,
    fontWeight: '700',
    flex: 1,
    marginRight: 8,
  },
  chatTime: {
    fontSize: 12,
  },
  chatSubRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  lastMsgText: {
    fontSize: 13,
    flex: 1,
    marginRight: 8,
  },
  connectedPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  sectionCard: {
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    elevation: 2,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '800',
  },
  sectionDesc: {
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 10,
  },
  ipRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
  },
  peerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 0.5,
  },
  peerInfo: {
    flex: 1,
    marginLeft: 12,
  },
  peerName: {
    fontSize: 15,
    fontWeight: '700',
  },
  peerStatus: {
    fontSize: 12,
    marginTop: 2,
  },
  callHistoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  callRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 0.5,
  },
  callInfo: {
    flex: 1,
    marginHorizontal: 12,
  },
  callMeta: {
    fontSize: 12,
    marginTop: 3,
    marginBottom: 3,
  },
  callDeleteButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  emptyBox: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 13,
    textAlign: 'center',
  },
  centerEmpty: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 30,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },
  fabContainer: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    alignItems: 'center',
  },
  fabSecondary: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
    elevation: 5,
  },
  fabPrimary: {
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 6,
  },
});
