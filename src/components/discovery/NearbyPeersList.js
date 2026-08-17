import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useAppTheme } from '../../theme/themeContext';
import { peerRegistry, PEER_STATUS } from '../../network/PeerRegistry';

export const NearbyPeersList = ({
  onSelectPeer,
  isScanning = false,
  activePeerId = null,
}) => {
  const { theme } = useAppTheme();
  const [peers, setPeers] = useState(peerRegistry.getAllPeers());

  useEffect(() => {
    const unsubscribe = peerRegistry.subscribe(updatedPeers => {
      setPeers([...updatedPeers]);
    });
    return () => unsubscribe();
  }, []);

  const getInitials = name => {
    if (!name) return 'G1';
    const words = name.trim().split(' ');
    if (words.length >= 2) {
      return `${words[0][0]}${words[1][0]}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  const renderStatusBadge = peer => {
    if (peer.deviceId === activePeerId || peer.status === PEER_STATUS.CONNECTED) {
      return (
        <View style={[styles.badge, { backgroundColor: '#10B98122', borderColor: '#10B981' }]}>
          <View style={[styles.dot, { backgroundColor: '#10B981' }]} />
          <Text style={[styles.badgeText, { color: '#10B981' }]}>متصل</Text>
        </View>
      );
    }
    if (peer.status === PEER_STATUS.CONNECTING) {
      return (
        <View style={[styles.badge, { backgroundColor: '#F59E0B22', borderColor: '#F59E0B' }]}>
          <ActivityIndicator size="small" color="#F59E0B" style={{ marginRight: 4 }} />
          <Text style={[styles.badgeText, { color: '#F59E0B' }]}>جاري الاتصال...</Text>
        </View>
      );
    }
    if (peer.status === PEER_STATUS.ONLINE) {
      return (
        <View style={[styles.badge, { backgroundColor: '#3B82F622', borderColor: '#3B82F6' }]}>
          <View style={[styles.dot, { backgroundColor: '#3B82F6' }]} />
          <Text style={[styles.badgeText, { color: '#3B82F6' }]}>متاح</Text>
        </View>
      );
    }
    return (
      <View style={[styles.badge, { backgroundColor: '#6B728022', borderColor: '#6B7280' }]}>
        <View style={[styles.dot, { backgroundColor: '#6B7280' }]} />
        <Text style={[styles.badgeText, { color: '#9CA3AF' }]}>غير متصل</Text>
      </View>
    );
  };

  const renderPeerItem = ({ item }) => {
    const isConnected = item.deviceId === activePeerId || item.status === PEER_STATUS.CONNECTED;
    const isConnecting = item.status === PEER_STATUS.CONNECTING;

    return (
      <TouchableOpacity
        style={[
          styles.peerCard,
          {
            backgroundColor: isConnected ? theme.surfaceVariant : theme.surface,
            borderColor: isConnected ? theme.primary : theme.border,
          },
        ]}
        onPress={() => onSelectPeer && onSelectPeer(item)}
        activeOpacity={0.7}
        disabled={isConnecting}
      >
        <View style={styles.avatarContainer}>
          <View style={[styles.avatar, { backgroundColor: theme.primaryLight || '#3B82F6' }]}>
            <Text style={styles.avatarText}>{getInitials(item.deviceName)}</Text>
          </View>
          <View
            style={[
              styles.onlineIndicator,
              {
                backgroundColor:
                  item.status === PEER_STATUS.ONLINE || isConnected
                    ? '#10B981'
                    : '#6B7280',
              },
            ]}
          />
        </View>

        <View style={styles.infoContainer}>
          <View style={styles.nameRow}>
            <Text style={[styles.peerName, { color: theme.text }]} numberOfLines={1}>
              {item.deviceName || 'G1 Device'}
            </Text>
            {item.isTrusted ? <Text style={styles.trustedIcon}> 🔒</Text> : null}
          </View>
          <Text style={[styles.statusSubtitle, { color: theme.textMuted }]}>
            {isConnected
              ? 'جلسة نشطة الآن'
              : item.status === PEER_STATUS.ONLINE
              ? 'جاهز للاتصال الفوري'
              : 'جهاز محفوظ مسبقاً'}
          </Text>
        </View>

        <View style={styles.actionContainer}>
          {renderStatusBadge(item)}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>الأجهزة القريبة</Text>
        {isScanning ? (
          <View style={styles.scanningIndicator}>
            <ActivityIndicator size="small" color={theme.primary} />
            <Text style={[styles.scanningText, { color: theme.primary }]}> جاري الاكتشاف...</Text>
          </View>
        ) : null}
      </View>

      {peers.length === 0 ? (
        <View style={[styles.emptyContainer, { borderColor: theme.border }]}>
          <Text style={styles.emptyIcon}>📡</Text>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>
            {isScanning ? 'جاري البحث عن أجهزة قريبة...' : 'لم يتم العثور على أجهزة بعد'}
          </Text>
          <Text style={[styles.emptyHint, { color: theme.textMuted }]}>
            تأكد من فتح تطبيق G1 على الجهاز الآخر وتواجدهما على نفس شبكة الواي فاي أو تفعيل Wi-Fi Direct.
          </Text>
        </View>
      ) : (
        <FlatList
          data={peers}
          keyExtractor={item => item.deviceId}
          renderItem={renderPeerItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginVertical: 12,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '800',
  },
  scanningIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  scanningText: {
    fontSize: 12,
    fontWeight: '600',
  },
  listContent: {
    paddingBottom: 8,
  },
  peerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 8,
    elevation: 2,
  },
  avatarContainer: {
    position: 'relative',
    marginRight: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '800',
  },
  onlineIndicator: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#1F2937',
  },
  infoContainer: {
    flex: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  peerName: {
    fontSize: 15,
    fontWeight: '700',
  },
  trustedIcon: {
    fontSize: 12,
  },
  statusSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  actionContainer: {
    marginLeft: 8,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  emptyContainer: {
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 8,
  },
  emptyIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
    textAlign: 'center',
  },
  emptyHint: {
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
});

export default NearbyPeersList;
