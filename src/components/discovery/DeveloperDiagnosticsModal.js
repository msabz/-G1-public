import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  Clipboard,
} from 'react-native';
import { useAppTheme } from '../../theme/themeContext';
import { Button } from '../common/Button';
import { fallbackEngine, TRANSPORT_MODE } from '../../network/TransportFallbackEngine';
import { getDefaultSignalingListener } from '../../network/SignalingListener';
import { getSignalingHealth } from '../../webrtc/signaling';
import { lanDiscovery } from '../../network/LanDiscovery';
import { peerRegistry } from '../../network/PeerRegistry';
import { getDeviceIdentity } from '../../services/Persistence';
import { PROTOCOL_VERSION, APP_IDENTIFIER } from '../../network/SecureHandshake';

export const DeveloperDiagnosticsModal = ({
  visible,
  onClose,
  onManualConnectLan,
  myLocalIp = '127.0.0.1',
  myDeviceId = '',
  myDeviceName = '',
}) => {
  const { theme } = useAppTheme();
  const [manualIp, setManualIp] = useState('');
  const [manualPort, setManualPort] = useState('8089');
  const [transportMode, setTransportMode] = useState(fallbackEngine.getMode());
  const [listenerStatus, setListenerStatus] = useState(getDefaultSignalingListener().getStatus());
  const [lanStatus, setLanStatus] = useState({ isAdvertising: false, isDiscovering: false });
  const [discoveredPeers, setDiscoveredPeers] = useState(peerRegistry.getAllPeers());
  const [resolvedIdentity, setResolvedIdentity] = useState({ deviceId: '', deviceName: '' });
  const [signalingHealth, setSignalingHealth] = useState(getSignalingHealth());

  const effectiveDeviceId = myDeviceId || resolvedIdentity.deviceId || '';
  const effectiveDeviceName = myDeviceName || resolvedIdentity.deviceName || '';

  useEffect(() => {
    if (visible) {
      setListenerStatus(getDefaultSignalingListener().getStatus());
      setDiscoveredPeers(peerRegistry.getAllPeers());
      setSignalingHealth(getSignalingHealth());
      getDeviceIdentity()
        .then(identity => {
          if (identity) setResolvedIdentity(identity);
        })
        .catch(() => {});
      if (lanDiscovery.isSupported()) {
        lanDiscovery.getStatus?.().then(st => setLanStatus(st || {})).catch(() => {});
      }
    }
  }, [visible]);

  const handleModeChange = (mode) => {
    setTransportMode(mode);
    fallbackEngine.setMode(mode);
  };

  const handleManualConnect = () => {
    const ip = manualIp.trim();
    const port = parseInt(manualPort, 10) || 8089;
    if (!ip) {
      Alert.alert('خطأ', 'يرجى كتابة عنوان IP صحيح');
      return;
    }
    if (onManualConnectLan) {
      onManualConnectLan(ip, port);
      onClose();
    }
  };

  const transportLine = (peer) => {
    const lan = peer.transports?.LAN;
    const p2p = peer.transports?.P2P;
    const bt = peer.transports?.BLUETOOTH;
    const parts = [];
    if (lan) {
      parts.push(
        `LAN=${lan.host || 'none'}:${lan.port || 8089}` +
        ` iface=${lan.interfaceName || 'unknown'}` +
        ` gen=${lan.generation ?? 'n/a'}` +
        ` reachable=${lan.isReachable !== false}` +
        ` stale=${lan.stale === true}`
      );
    }
    if (p2p) {
      parts.push(
        `P2P=${p2p.groupOwnerAddress || p2p.deviceAddress || 'none'}` +
        ` iface=${p2p.interfaceName || 'unknown'}` +
        ` gen=${p2p.generation ?? 'n/a'}` +
        ` reachable=${p2p.isReachable !== false}` +
        ` stale=${p2p.stale === true}`
      );
    }
    if (bt) {
      parts.push(
        `BT=${bt.address || 'none'}` +
        ` gen=${bt.generation ?? 'n/a'}` +
        ` reachable=${bt.isReachable !== false}` +
        ` stale=${bt.stale === true}`
      );
    }
    return parts.length ? parts.join(' | ') : 'no transports';
  };

  const copyDiagnostics = () => {
    const health = getSignalingHealth();
    setSignalingHealth(health);
    const report = [
      `=== G1 Network Diagnostics ===`,
      `Protocol: ${APP_IDENTIFIER} v${PROTOCOL_VERSION}`,
      `Device ID: ${effectiveDeviceId}`,
      `Device Name: ${effectiveDeviceName}`,
      `Local IP: ${myLocalIp}`,
      `Listener Port: ${listenerStatus.port} (listening: ${listenerStatus.isListening})`,
      `mDNS Advertising: ${lanStatus.isAdvertising}`,
      `mDNS Discovering: ${lanStatus.isDiscovering}`,
      `Transport Mode: ${transportMode}`,
      `Signaling Connected: ${health.connected}`,
      `Signaling Peer: ${health.peerAddress || 'none'}`,
      `Heartbeat Running: ${health.heartbeatRunning}`,
      `Last Inbound Activity: ${health.lastInboundActivityAt || 0}`,
      `Recovery In Progress: ${health.recoveryInProgress === true}`,
      `Discovered Peers: ${discoveredPeers.length}`,
      ...discoveredPeers.map(p => ` - ${p.deviceName} (${p.deviceId}) ${transportLine(p)}`),
    ].join('\n');

    if (Clipboard && Clipboard.setString) {
      Clipboard.setString(report);
      Alert.alert('تم النسخ', 'تم نسخ تقرير التشخيص بالكامل للحافظة');
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.text }]}>🛠️ Developer Diagnostics</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Text style={{ color: theme.textMuted, fontSize: 20 }}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            <View style={[styles.section, { backgroundColor: theme.surfaceVariant }]}>
              <Text style={[styles.sectionHeader, { color: theme.primary }]}>معلومات النظام والشبكة</Text>
              <Text style={[styles.rowText, { color: theme.text }]}>
                <Text style={styles.bold}>Device ID: </Text>{effectiveDeviceId || 'N/A'}
              </Text>
              <Text style={[styles.rowText, { color: theme.text }]}>
                <Text style={styles.bold}>Device Name: </Text>{effectiveDeviceName || 'N/A'}
              </Text>
              <Text style={[styles.rowText, { color: theme.text }]}>
                <Text style={styles.bold}>Local IP: </Text>{myLocalIp}
              </Text>
              <Text style={[styles.rowText, { color: theme.text }]}>
                <Text style={styles.bold}>LAN Listener: </Text>
                {listenerStatus.isListening ? `✅ 0.0.0.0:${listenerStatus.port}` : '❌ متوقف'}
              </Text>
              <Text style={[styles.rowText, { color: theme.text }]}>
                <Text style={styles.bold}>mDNS NSD: </Text>
                {lanStatus.isAdvertising ? '📢 Advertising' : '⚪ Idle'} | {lanStatus.isDiscovering ? '🔍 Discovering' : '⚪ Idle'}
              </Text>
              <Text style={[styles.rowText, { color: theme.text }]}>
                <Text style={styles.bold}>Signaling: </Text>
                {signalingHealth.connected ? `✅ ${signalingHealth.peerAddress || ''}` : '⚪ غير متصل'}
              </Text>
              <Text style={[styles.rowText, { color: theme.text }]}>
                <Text style={styles.bold}>Heartbeat: </Text>
                {signalingHealth.heartbeatRunning ? '✅ Active' : '⚪ Idle'} | Recovery: {signalingHealth.recoveryInProgress ? '🔄 Yes' : 'No'}
              </Text>
              <Text style={[styles.rowText, { color: theme.text }]}>
                <Text style={styles.bold}>Protocol Version: </Text>{APP_IDENTIFIER} v{PROTOCOL_VERSION}
              </Text>

              <TouchableOpacity style={styles.copyBtn} onPress={copyDiagnostics}>
                <Text style={{ color: theme.primary, fontWeight: '700', fontSize: 12 }}>📋 نسخ التقرير التشخيصي</Text>
              </TouchableOpacity>
            </View>

            <Text style={[styles.label, { color: theme.text }]}>فرض وسيلة الاتصال (Transport Override):</Text>
            <View style={styles.modeRow}>
              {Object.values(TRANSPORT_MODE).map(mode => (
                <TouchableOpacity
                  key={mode}
                  style={[
                    styles.modeChip,
                    {
                      backgroundColor: transportMode === mode ? theme.primary : theme.surfaceSubtle,
                      borderColor: theme.border,
                    },
                  ]}
                  onPress={() => handleModeChange(mode)}
                >
                  <Text
                    style={[
                      styles.modeText,
                      { color: transportMode === mode ? '#FFF' : theme.text },
                    ]}
                  >
                    {mode}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.label, { color: theme.text, marginTop: 14 }]}>الاتصال اليدوي بـ IP المباشر:</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={[styles.input, { backgroundColor: theme.surfaceSubtle, color: theme.text, borderColor: theme.border }]}
                placeholder="192.168.1.50"
                placeholderTextColor={theme.textMuted}
                value={manualIp}
                onChangeText={setManualIp}
                keyboardType="numeric"
              />
              <TextInput
                style={[styles.portInput, { backgroundColor: theme.surfaceSubtle, color: theme.text, borderColor: theme.border }]}
                placeholder="8089"
                placeholderTextColor={theme.textMuted}
                value={manualPort}
                onChangeText={setManualPort}
                keyboardType="numeric"
              />
            </View>
            <Button
              title="اتصال يدوي فوري"
              variant="primary"
              size="small"
              icon="⚡"
              onPress={handleManualConnect}
            />

            <Text style={[styles.label, { color: theme.text, marginTop: 16 }]}>
              الأجهزة المكتشفة مع العناوين ({discoveredPeers.length}):
            </Text>
            {discoveredPeers.map(p => (
              <View key={p.deviceId} style={[styles.peerRow, { backgroundColor: theme.surfaceSubtle }]}>
                <Text style={[styles.peerRowName, { color: theme.text }]}>{p.deviceName}</Text>
                <Text style={[styles.peerRowMeta, { color: theme.textMuted }]}>{transportLine(p)}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '85%',
    borderRadius: 20,
    borderWidth: 1,
    padding: 18,
    elevation: 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '800',
  },
  closeBtn: {
    padding: 4,
  },
  content: {
    flexGrow: 0,
  },
  section: {
    padding: 12,
    borderRadius: 12,
    marginBottom: 14,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 8,
  },
  rowText: {
    fontSize: 12,
    marginBottom: 4,
  },
  bold: {
    fontWeight: '700',
  },
  copyBtn: {
    marginTop: 8,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  modeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  modeChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  modeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  input: {
    flex: 3,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  portInput: {
    flex: 1,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
    fontSize: 14,
    textAlign: 'center',
  },
  peerRow: {
    padding: 10,
    borderRadius: 8,
    marginBottom: 6,
  },
  peerRowName: {
    fontSize: 13,
    fontWeight: '700',
  },
  peerRowMeta: {
    fontSize: 11,
    marginTop: 2,
  },
});

export default DeveloperDiagnosticsModal;
