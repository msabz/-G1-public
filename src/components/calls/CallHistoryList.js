import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme } from '../../theme/themeContext';
import {
  callHistoryPresentation,
  formatCallHistoryDuration,
  loadCallHistory,
  removeAllCallHistory,
  removeCallHistoryEntry,
} from '../../services/CallHistory';

function formatWhen(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString('ar', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function CallHistoryList({
  peerId = null,
  refreshKey = 0,
  onCallBack,
  onOpenPeer,
}) {
  const { theme } = useAppTheme();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRecords(await loadCallHistory({ peerId }));
    } finally {
      setLoading(false);
    }
  }, [peerId]);

  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  const removeOne = record => {
    Alert.alert('حذف سجل المكالمة؟', 'سيُحذف هذا السجل من الجهاز فقط.', [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'حذف',
        style: 'destructive',
        onPress: async () => {
          if (await removeCallHistoryEntry(record.callId)) {
            setRecords(current => current.filter(item => item.callId !== record.callId));
          }
        },
      },
    ]);
  };

  const clearAll = () => {
    Alert.alert('مسح سجل المكالمات؟', 'لا يمكن التراجع عن هذا الإجراء.', [
      { text: 'إلغاء', style: 'cancel' },
      {
        text: 'مسح',
        style: 'destructive',
        onPress: async () => {
          if (await removeAllCallHistory()) setRecords([]);
        },
      },
    ]);
  };

  if (loading) {
    return <ActivityIndicator style={styles.loading} color={theme.accent} accessibilityLabel="جاري تحميل سجل المكالمات" />;
  }

  return (
    <View style={styles.container}>
      {records.length > 0 && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="مسح سجل المكالمات"
          onPress={clearAll}
          style={styles.clearButton}
        >
          <Text style={[styles.clearText, { color: theme.error }]}>مسح السجل</Text>
        </TouchableOpacity>
      )}
      <FlatList
        data={records}
        keyExtractor={item => item.callId}
        onRefresh={refresh}
        refreshing={loading}
        ListEmptyComponent={(
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📞</Text>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>لا توجد مكالمات بعد</Text>
            <Text style={[styles.emptySubtitle, { color: theme.textSecondary }]}>ستظهر المكالمات الصوتية والفيديو هنا.</Text>
          </View>
        )}
        renderItem={({ item }) => {
          const call = callHistoryPresentation(item);
          const resultColor = call.isMissed || call.finalState === 'failed'
            ? (theme.error || '#E0453F')
            : theme.textSecondary;
          return (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`${call.peerName || 'جهاز'}، ${call.resultLabel}`}
              onPress={() => onOpenPeer?.(call)}
              onLongPress={() => removeOne(call)}
              style={[styles.row, { backgroundColor: theme.surface, borderBottomColor: theme.borderSubtle }]}
            >
              <View style={[styles.avatar, { backgroundColor: theme.surfaceVariant }]}>
                <Text style={[styles.avatarText, { color: theme.text }]}>{(call.peerName || 'G')[0].toUpperCase()}</Text>
              </View>
              <View style={styles.details}>
                <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>{call.peerName || 'G1 Device'}</Text>
                <View style={styles.metaRow}>
                  <Text style={[styles.result, { color: resultColor }]}>{call.directionIcon} {call.resultLabel}</Text>
                  <Text style={[styles.time, { color: theme.textMuted }]}> · {formatWhen(call.startedAt)}</Text>
                </View>
                {call.duration > 0 && (
                  <Text style={[styles.duration, { color: theme.textMuted }]}>{formatCallHistoryDuration(call.duration)}</Text>
                )}
              </View>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`معاودة ${call.mediaType === 'video' ? 'مكالمة الفيديو' : 'المكالمة الصوتية'}`}
                onPress={() => onCallBack?.(call)}
                style={[styles.callback, { backgroundColor: theme.surfaceVariant }]}
              >
                <Text style={styles.callbackIcon}>{call.mediaIcon}</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: { flex: 1 },
  clearButton: { alignSelf: 'flex-start', paddingHorizontal: 16, paddingVertical: 10 },
  clearText: { fontSize: 13, fontWeight: '700' },
  row: {
    minHeight: 76,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 19, fontWeight: '800' },
  details: { flex: 1, marginHorizontal: 12, alignItems: 'flex-end' },
  name: { fontSize: 15, fontWeight: '700', maxWidth: '100%' },
  metaRow: { flexDirection: 'row-reverse', marginTop: 4 },
  result: { fontSize: 12, fontWeight: '600' },
  time: { fontSize: 12 },
  duration: { fontSize: 11, marginTop: 3 },
  callback: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  callbackIcon: { fontSize: 18 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, paddingHorizontal: 30 },
  emptyIcon: { fontSize: 46, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '800' },
  emptySubtitle: { fontSize: 13, textAlign: 'center', marginTop: 7 },
});
