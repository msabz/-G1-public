import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, SafeAreaView, StatusBar } from 'react-native';
import { Avatar } from '../components/common/Avatar';
import { CallControlBar } from '../components/calls/CallControlBar';
import { useAppTheme } from '../theme/themeContext';

export const VoiceCallScreen = ({
  peerName = 'مكالمة جارية',
  callState = 'connected',
  isVideo = false,
  isMuted = false,
  isSpeakerOn = false,
  onToggleMute,
  onToggleSpeaker,
  onSwitchCamera,
  onHangUp,
}) => {
  const { theme } = useAppTheme();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    let timer = null;
    if (callState === 'connected') {
      timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [callState]);

  const formatDuration = (sec) => {
    const mins = Math.floor(sec / 60);
    const s = sec % 60;
    return `${mins.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <StatusBar barStyle={theme.statusBar} backgroundColor={theme.background} />

      <View style={styles.topInfo}>
        <Text style={[styles.callTypeLabel, { color: theme.primary }]}>
          {isVideo ? '📹 مكالمة فيديو DirectChat' : '📞 مكالمة صوتية DirectChat'}
        </Text>

        <View style={styles.avatarBox}>
          <Avatar name={peerName} size={130} isOnline transportType="wifi" />
        </View>

        <Text style={[styles.peerName, { color: theme.text }]}>{peerName}</Text>

        <Text style={[styles.statusText, { color: theme.textSecondary }]}>
          {callState === 'connected'
            ? formatDuration(seconds)
            : callState === 'outgoing_ringing'
            ? 'جاري الاتصال والرنين...'
            : 'جاري تهيئة قناة الصوت...'}
        </Text>
      </View>

      <CallControlBar
        isMuted={isMuted}
        isSpeakerOn={isSpeakerOn}
        isVideo={isVideo}
        onToggleMute={onToggleMute}
        onToggleSpeaker={onToggleSpeaker}
        onSwitchCamera={onSwitchCamera}
        onHangUp={onHangUp}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'space-between',
    paddingVertical: 30,
  },
  topInfo: {
    alignItems: 'center',
    marginTop: 40,
  },
  callTypeLabel: {
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 36,
  },
  avatarBox: {
    marginBottom: 24,
  },
  peerName: {
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 10,
  },
  statusText: {
    fontSize: 18,
    fontWeight: '600',
  },
});
export default VoiceCallScreen;
