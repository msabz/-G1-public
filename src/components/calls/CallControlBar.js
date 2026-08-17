import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useAppTheme } from '../../theme/themeContext';

export const CallControlBar = ({
  isMuted = false,
  isSpeakerOn = false,
  isVideo = false,
  onToggleMute,
  onToggleSpeaker,
  onSwitchCamera,
  onHangUp,
}) => {
  const { theme } = useAppTheme();

  return (
    <View style={[styles.bar, { backgroundColor: theme.surface }]}>
      {/* Mute */}
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={onToggleMute}
        style={[
          styles.roundBtn,
          { backgroundColor: isMuted ? theme.error : theme.surfaceVariant },
        ]}
      >
        <Text style={styles.icon}>{isMuted ? '🔇' : '🎤'}</Text>
      </TouchableOpacity>

      {/* Speaker */}
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={onToggleSpeaker}
        style={[
          styles.roundBtn,
          { backgroundColor: isSpeakerOn ? theme.primary : theme.surfaceVariant },
        ]}
      >
        <Text style={styles.icon}>{isSpeakerOn ? '🔊' : '🔈'}</Text>
      </TouchableOpacity>

      {/* Switch Camera for Video */}
      {isVideo && onSwitchCamera && (
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={onSwitchCamera}
          style={[styles.roundBtn, { backgroundColor: theme.surfaceVariant }]}
        >
          <Text style={styles.icon}>🔄</Text>
        </TouchableOpacity>
      )}

      {/* Hang Up */}
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={onHangUp}
        style={[styles.roundBtn, { backgroundColor: theme.error }]}
      >
        <Text style={styles.icon}>📞</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 30,
    marginHorizontal: 20,
    marginBottom: 24,
    elevation: 6,
  },
  roundBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    justifyContent: 'center',
    alignItems: 'center',
  },
  icon: {
    fontSize: 22,
  },
});
export default CallControlBar;
