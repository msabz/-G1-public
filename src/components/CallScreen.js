import React, { useState, useEffect } from 'react';
import {
  View, StyleSheet, TouchableOpacity, Text, StatusBar,
} from 'react-native';
import { RTCView } from 'react-native-webrtc';
import * as RTCAudio from '../media/WebRTCAudio';
import { WA } from '../theme';

function formatDuration(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function CallScreen({
  onToggleCamera, onToggleMute, onEndCall, onToggleSpeaker, onSetVolume,
  peerName, videoEnabled, audioEngine, audioDiag, rtcLog,
}) {
  const [cameraOn, setCameraOn] = useState(!!videoEnabled);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(!!videoEnabled);
  const [seconds, setSeconds] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [volumeStep, setVolumeStep] = useState(videoEnabled ? 2 : 4);
  const [localStreamURL, setLocalStreamURL] = useState(null);
  const [remoteStreamURL, setRemoteStreamURL] = useState(null);

  useEffect(() => {
    const t = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!controlsVisible) return;
    const t = setTimeout(() => setControlsVisible(false), 6000);
    return () => clearTimeout(t);
  }, [controlsVisible]);

  useEffect(() => {
    if (!videoEnabled) {
      setLocalStreamURL(null);
      setRemoteStreamURL(null);
      return undefined;
    }
    const refresh = () => {
      const local = RTCAudio.getLocalStreamURL();
      const remote = RTCAudio.getRemoteStreamURL();
      setLocalStreamURL(prev => prev === local ? prev : local);
      setRemoteStreamURL(prev => prev === remote ? prev : remote);
    };
    refresh();
    const timer = setInterval(refresh, 150);
    return () => clearInterval(timer);
  }, [videoEnabled, audioEngine]);

  const hasRemoteVideo = !!videoEnabled && !!remoteStreamURL;
  const hasLocalVideo = !!videoEnabled && !!localStreamURL && cameraOn;

  return (
    <TouchableOpacity
      activeOpacity={1}
      onPress={() => setControlsVisible(v => !v)}
      style={styles.container}
    >
      <StatusBar backgroundColor="#000" barStyle="light-content" />

      {hasRemoteVideo ? (
        <RTCView
          streamURL={remoteStreamURL}
          style={StyleSheet.absoluteFill}
          objectFit="cover"
          mirror={false}
        />
      ) : (
        <View style={styles.waitingScreen}>
          <View style={styles.bigAvatar}>
            <Text style={styles.bigAvatarText}>{(peerName || 'M')[0].toUpperCase()}</Text>
          </View>
          <Text style={styles.waitingName}>{peerName || 'Musabchat'}</Text>
          <Text style={styles.waitingStatus}>
            {videoEnabled ? 'جاري تشغيل فيديو WebRTC…' : 'جاري الاتصال…'}
          </Text>
        </View>
      )}

      {controlsVisible && (
        <View style={styles.topBar}>
          <Text style={styles.topName}>{peerName || 'Musabchat'}</Text>
          <Text style={styles.topTimer}>{formatDuration(seconds)}</Text>
          <Text style={styles.topEncrypted}>
            {audioEngine === 'webrtc'
              ? (videoEnabled ? '🔒 WebRTC مباشر · صوت وفيديو' : '🔒 اتصال مباشر · صوت محسّن')
              : audioEngine === 'failed'
                ? `⚠️ تعذّر WebRTC${audioDiag ? ' · ' + audioDiag : ''}`
                : '🔒 اتصال مباشر بين الجهازين'}
          </Text>
        </View>
      )}

      {controlsVisible && rtcLog && rtcLog.length > 0 && (
        <View style={styles.diagBox}>
          {rtcLog.map((line, i) => (
            <Text key={i} style={styles.diagLine} numberOfLines={1}>{line}</Text>
          ))}
        </View>
      )}

      {hasLocalVideo && (
        <View style={styles.pipContainer}>
          <RTCView
            streamURL={localStreamURL}
            style={styles.pip}
            objectFit="cover"
            mirror
          />
        </View>
      )}

      {controlsVisible && (
        <View style={styles.controlsWrap}>
          <View style={styles.volRow}>
            <TouchableOpacity
              onPress={() => {
                const next = Math.max(0, volumeStep - 1);
                setVolumeStep(next);
                onSetVolume && onSetVolume(next / 5);
              }}
              style={styles.volBtn}
            >
              <Text style={styles.volBtnText}>−</Text>
            </TouchableOpacity>

            <View style={styles.volBars}>
              {[0, 1, 2, 3, 4].map(i => (
                <View key={i} style={[styles.volBar, i < volumeStep && styles.volBarOn]} />
              ))}
            </View>

            <TouchableOpacity
              onPress={() => {
                const next = Math.min(5, volumeStep + 1);
                setVolumeStep(next);
                onSetVolume && onSetVolume(next / 5);
              }}
              style={styles.volBtn}
            >
              <Text style={styles.volBtnText}>+</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.controlsRow}>
            <TouchableOpacity
              onPress={() => RTCAudio.switchCamera().catch(() => {})}
              style={styles.ctrlBtn}
            >
              <Text style={styles.ctrlIcon}>🔄</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => {
                const on = onToggleCamera();
                setCameraOn(on);
                RTCAudio.setCameraEnabled(on);
              }}
              style={[styles.ctrlBtn, !cameraOn && styles.ctrlBtnOff]}
            >
              <Text style={styles.ctrlIcon}>{cameraOn ? '🎥' : '🚫'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => { const on = onToggleMute(); setMuted(on); }}
              style={[styles.ctrlBtn, muted && styles.ctrlBtnOff]}
            >
              <Text style={styles.ctrlIcon}>{muted ? '🔇' : '🎤'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => {
                const next = !speaker;
                setSpeaker(next);
                onToggleSpeaker && onToggleSpeaker(next);
              }}
              style={[styles.ctrlBtn, !speaker && styles.ctrlBtnOff]}
            >
              <Text style={styles.ctrlIcon}>{speaker ? '🔊' : '👂'}</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={onEndCall} style={styles.endBtn}>
              <Text style={styles.endIcon}>📞</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B141A' },
  waitingScreen: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0B141A' },
  bigAvatar: {
    width: 110, height: 110, borderRadius: 55, backgroundColor: '#2A3942',
    justifyContent: 'center', alignItems: 'center', marginBottom: 18,
  },
  bigAvatarText: { color: '#fff', fontSize: 44, fontWeight: '600' },
  waitingName: { color: '#fff', fontSize: 24, fontWeight: '500' },
  waitingStatus: { color: '#8696A0', fontSize: 15, marginTop: 6 },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 40, paddingBottom: 16, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  topName: { color: '#fff', fontSize: 18, fontWeight: '600' },
  topTimer: { color: 'rgba(255,255,255,0.85)', fontSize: 13, marginTop: 2 },
  topEncrypted: { color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 6 },
  diagBox: {
    position: 'absolute', top: 130, left: 10, right: 130,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 8, padding: 8,
  },
  diagLine: { color: '#9FE8A0', fontSize: 10, fontFamily: 'monospace' },
  pipContainer: {
    position: 'absolute', top: 110, right: 14,
    width: 100, height: 140, borderRadius: 10, overflow: 'hidden',
    backgroundColor: '#000', elevation: 6,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
  },
  pip: { width: '100%', height: '100%' },
  controlsWrap: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingBottom: 40, paddingTop: 20, backgroundColor: 'rgba(0,0,0,0.35)' },
  volRow: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center',
    gap: 14, marginBottom: 18,
  },
  volBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center', alignItems: 'center',
  },
  volBtnText: { color: '#fff', fontSize: 20, fontWeight: '600' },
  volBars: { flexDirection: 'row-reverse', gap: 5, alignItems: 'flex-end' },
  volBar: { width: 7, height: 18, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)' },
  volBarOn: { backgroundColor: '#34C759' },
  controlsRow: { flexDirection: 'row-reverse', justifyContent: 'center', alignItems: 'center', gap: 18 },
  ctrlBtn: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.18)',
    justifyContent: 'center', alignItems: 'center',
  },
  ctrlBtnOff: { backgroundColor: 'rgba(255,255,255,0.85)' },
  ctrlIcon: { fontSize: 22 },
  endBtn: {
    width: 62, height: 62, borderRadius: 31, backgroundColor: WA.danger,
    justifyContent: 'center', alignItems: 'center',
    transform: [{ rotate: '135deg' }],
  },
  endIcon: { fontSize: 24 },
});
