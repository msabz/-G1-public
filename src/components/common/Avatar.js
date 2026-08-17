import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useAppTheme } from '../../theme/themeContext';

export const Avatar = ({
  name = '؟',
  size = 48,
  isOnline = false,
  transportType,
}) => {
  const { theme } = useAppTheme();

  const getInitials = (n) => {
    if (!n) return '؟';
    const parts = n.trim().split(' ');
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return n.substring(0, 2).toUpperCase();
  };

  const getTransportIcon = (type) => {
    switch (type) {
      case 'lan':
        return '🌐';
      case 'wifidirect':
      case 'wifi':
        return '📶';
      case 'bluetooth':
      case 'bt':
        return 'ᛒ';
      default:
        return null;
    }
  };

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <View
        style={[
          styles.avatarCircle,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: theme.surfaceVariant,
          },
        ]}
      >
        <Text style={[styles.initials, { fontSize: size * 0.4, color: theme.primary }]}>
          {getInitials(name)}
        </Text>
      </View>

      {isOnline && (
        <View
          style={[
            styles.onlineIndicator,
            {
              backgroundColor: theme.accent,
              borderColor: theme.surface,
              width: size * 0.28,
              height: size * 0.28,
              borderRadius: (size * 0.28) / 2,
            },
          ]}
        />
      )}

      {transportType && (
        <View
          style={[
            styles.transportBadge,
            {
              backgroundColor: theme.surfaceSubtle,
              borderColor: theme.border,
            },
          ]}
        >
          <Text style={styles.transportText}>{getTransportIcon(transportType)}</Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarCircle: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  initials: {
    fontWeight: '700',
  },
  onlineIndicator: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    borderWidth: 2,
  },
  transportBadge: {
    position: 'absolute',
    top: -2,
    left: -2,
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderRadius: 8,
    borderWidth: 1,
  },
  transportText: {
    fontSize: 10,
  },
});
export default Avatar;
