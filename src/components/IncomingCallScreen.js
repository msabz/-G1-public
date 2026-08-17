import React, { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar, Animated, Easing,
} from 'react-native';
import { WA } from '../theme';

/**
 * شاشة المكالمة الواردة.
 *
 * نقطة أساسية: هالشاشة ما بتفتح الميكروفون إطلاقاً. الميكروفون
 * ما بينفتح إلا بعد ما يضغط المستخدم "ردّ" — وهاد يمنع أي طرف من
 * فتح ميكروفون الطرف الآخر بدون إذنه.
 */
export default function IncomingCallScreen({ peerName, isVideo, outgoing, onAccept, onReject }) {
  // نبض هادئ حول الأفاتار أثناء الرنين
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1100, easing: Easing.in(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  const glow = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] });

  const letter = (peerName || 'M')[0].toUpperCase();

  return (
    <View style={styles.container}>
      <StatusBar backgroundColor="#0B141A" barStyle="light-content" />

      <View style={styles.top}>
        <Text style={styles.callType}>
          {outgoing
            ? (isVideo ? '🎥 مكالمة فيديو…' : '📞 جاري الاتصال…')
            : (isVideo ? '🎥 مكالمة فيديو واردة' : '📞 مكالمة صوتية واردة')}
        </Text>
      </View>

      <View style={styles.middle}>
        <View style={styles.avatarWrap}>
          <Animated.View style={[styles.glowRing, { transform: [{ scale }], opacity: glow }]} />
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{letter}</Text>
          </View>
        </View>

        <Text style={styles.name} numberOfLines={1}>{peerName || 'الجهاز الآخر'}</Text>
        <Text style={styles.encrypted}>
          {outgoing ? 'يرنّ عند الطرف الآخر…' : '🔒 اتصال مباشر بين الجهازين'}
        </Text>
      </View>

      <View style={[styles.actions, outgoing && { justifyContent: 'center' }]}>
        <View style={styles.actionCol}>
          <TouchableOpacity style={[styles.actionBtn, styles.rejectBtn]} onPress={onReject}>
            <Text style={styles.rejectIcon}>📞</Text>
          </TouchableOpacity>
          <Text style={styles.actionLabel}>{outgoing ? 'إلغاء' : 'رفض'}</Text>
        </View>

        {!outgoing && (
          <View style={styles.actionCol}>
            <TouchableOpacity style={[styles.actionBtn, styles.acceptBtn]} onPress={onAccept}>
              <Text style={styles.acceptIcon}>{isVideo ? '🎥' : '📞'}</Text>
            </TouchableOpacity>
            <Text style={styles.actionLabel}>{isVideo ? 'فيديو' : 'ردّ'}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B141A', justifyContent: 'space-between' },

  top: { alignItems: 'center', paddingTop: 60 },
  callType: { color: '#8696A0', fontSize: 15 },

  middle: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  avatarWrap: { justifyContent: 'center', alignItems: 'center', marginBottom: 26 },
  glowRing: {
    position: 'absolute', width: 150, height: 150, borderRadius: 75,
    backgroundColor: WA.teal,
  },
  avatar: {
    width: 130, height: 130, borderRadius: 65, backgroundColor: '#2A3942',
    justifyContent: 'center', alignItems: 'center',
  },
  avatarText: { color: '#fff', fontSize: 52, fontWeight: '600' },
  name: { color: '#fff', fontSize: 26, fontWeight: '500' },
  encrypted: { color: '#8696A0', fontSize: 12, marginTop: 10 },

  actions: {
    flexDirection: 'row-reverse', justifyContent: 'space-evenly',
    alignItems: 'center', paddingBottom: 70, paddingHorizontal: 30,
  },
  actionCol: { alignItems: 'center' },
  actionBtn: {
    width: 70, height: 70, borderRadius: 35,
    justifyContent: 'center', alignItems: 'center', elevation: 6,
  },
  acceptBtn: { backgroundColor: '#25D366' },
  rejectBtn: { backgroundColor: '#E0453F' },
  acceptIcon: { fontSize: 30 },
  rejectIcon: { fontSize: 30, transform: [{ rotate: '135deg' }] },
  actionLabel: { color: '#C7CED3', fontSize: 13, marginTop: 12 },
});
