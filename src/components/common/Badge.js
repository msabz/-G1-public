import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useAppTheme } from '../../theme/themeContext';

export const Badge = ({ count, label, variant = 'primary', style }) => {
  const { theme } = useAppTheme();

  const getBg = () => {
    switch (variant) {
      case 'accent':
      case 'primary':
        return theme.accent || theme.primary;
      case 'danger':
        return theme.error;
      case 'subtle':
        return theme.surfaceVariant;
      default:
        return theme.primary;
    }
  };

  const text = count !== undefined ? (count > 99 ? '99+' : count.toString()) : label;
  if (!text && text !== 0) return null;

  return (
    <View style={[styles.badge, { backgroundColor: getBg() }, style]}>
      <Text style={styles.text}>{text}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  text: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
});
export default Badge;
