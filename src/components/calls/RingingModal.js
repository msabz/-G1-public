import React from 'react';
import { View, Text, StyleSheet, Modal as RNModal, TouchableOpacity } from 'react-native';
import { useAppTheme } from '../../theme/themeContext';
import { Avatar } from '../common/Avatar';

export const RingingModal = ({
  visible,
  callerName = 'مكالمة واردة',
  isVideo = false,
  onAccept,
  onDecline,
}) => {
  const { theme } = useAppTheme();

  if (!visible) return null;

  return (
    <RNModal visible={visible} transparent animationType="slide">
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={styles.topSection}>
          <Text style={[styles.callTypeHeader, { color: theme.primary }]}>
            {isVideo ? '📹 مكالمة فيديو واردة' : '📞 مكالمة صوتية واردة'}
          </Text>

          <View style={styles.avatarWrapper}>
            <Avatar name={callerName} size={120} isOnline transportType="wifi" />
          </View>

          <Text style={[styles.callerName, { color: theme.text }]}>{callerName}</Text>
          <Text style={[styles.ringingText, { color: theme.textSecondary }]}>جاري الرنين...</Text>
        </View>

        <View style={styles.actionsRow}>
          {/* Decline */}
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={onDecline}
            style={[styles.callActionBtn, { backgroundColor: theme.error }]}
          >
            <Text style={styles.btnIcon}>✕</Text>
            <Text style={styles.btnLabel}>رفض</Text>
          </TouchableOpacity>

          {/* Accept */}
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={onAccept}
            style={[styles.callActionBtn, { backgroundColor: theme.success || theme.accent }]}
          >
            <Text style={styles.btnIcon}>📞</Text>
            <Text style={styles.btnLabel}>قبول</Text>
          </TouchableOpacity>
        </View>
      </View>
    </RNModal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'space-between',
    paddingVertical: 60,
    paddingHorizontal: 24,
  },
  topSection: {
    alignItems: 'center',
    marginTop: 50,
  },
  callTypeHeader: {
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 36,
  },
  avatarWrapper: {
    marginBottom: 24,
  },
  callerName: {
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 10,
  },
  ringingText: {
    fontSize: 16,
    fontWeight: '600',
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 40,
  },
  callActionBtn: {
    width: 120,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
  },
  btnIcon: {
    fontSize: 22,
    color: '#FFFFFF',
    fontWeight: '800',
  },
  btnLabel: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 2,
  },
});
export default RingingModal;
