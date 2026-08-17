import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, Modal, TextInput, TouchableOpacity,
  ActivityIndicator, FlatList, Alert, Clipboard,
} from 'react-native';
import { useAppTheme } from '../../theme/themeContext';
import { Button } from '../common/Button';
import TcpSocket from 'react-native-tcp-socket';

export const LanConnectModal = ({
  visible,
  onClose,
  onConnectLan,
  myLocalIp = '127.0.0.1',
  port = 8089,
}) => {
  const { theme } = useAppTheme();
  const [targetIp, setTargetIp] = useState('');
  const [targetPort, setTargetPort] = useState(String(port));
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState('');
  const [discoveredLanPeers, setDiscoveredLanPeers] = useState([]);

  useEffect(() => {
    if (visible && myLocalIp && myLocalIp !== '127.0.0.1') {
      const parts = myLocalIp.split('.');
      if (parts.length === 4) {
        // Suggest the subnet prefix for convenience
        setTargetIp(`${parts[0]}.${parts[1]}.${parts[2]}.`);
      }
    }
  }, [visible, myLocalIp]);

  const copyMyIp = () => {
    if (Clipboard && Clipboard.setString) {
      Clipboard.setString(`${myLocalIp}:${port}`);
      Alert.alert('تم النسخ', `تم نسخ عنوان جهازك: ${myLocalIp}:${port}`);
    }
  };

  const handleManualConnect = () => {
    const ip = targetIp.trim();
    const p = parseInt(targetPort, 10) || port;
    if (!ip || !ip.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
      Alert.alert('خطأ في العنوان', 'يرجى إدخال عنوان IPv4 صحيح (مثال: 192.168.1.50)');
      return;
    }
    onConnectLan && onConnectLan(ip, p);
    onClose();
  };

  const scanSubnet = () => {
    if (!myLocalIp || myLocalIp === '127.0.0.1') {
      Alert.alert('تنبيه', 'الجهاز غير متصل بشبكة واي فاي محلية حالياً.');
      return;
    }
    const parts = myLocalIp.split('.');
    if (parts.length !== 4) return;
    const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
    const myLast = parseInt(parts[3], 10);

    setScanning(true);
    setDiscoveredLanPeers([]);
    setScanProgress('جاري فحص الشبكة المحلية بحثاً عن أجهزة DirectChat...');

    const found = [];
    const checkIp = (host) => {
      return new Promise((resolve) => {
        const client = TcpSocket.createConnection({ host, port: 8089, timeout: 600 }, () => {
          found.push(host);
          try { client.destroy(); } catch (e) {}
          resolve(true);
        });
        client.on('error', () => {
          try { client.destroy(); } catch (e) {}
          resolve(false);
        });
        client.on('close', () => resolve(false));
      });
    };

    // Scan a batch of 40 nearby hosts in parallel
    const candidates = [];
    for (let i = 1; i <= 254; i++) {
      if (i !== myLast) candidates.push(`${prefix}.${i}`);
    }

    // Process in batches
    const batchSize = 25;
    let idx = 0;
    const runBatches = async () => {
      while (idx < candidates.length) {
        const batch = candidates.slice(idx, idx + batchSize);
        idx += batchSize;
        setScanProgress(`فحص الأجهزة (${Math.min(idx, candidates.length)}/254)...`);
        await Promise.all(batch.map(checkIp));
        setDiscoveredLanPeers([...found]);
      }
      setScanning(false);
      setScanProgress(found.length > 0 ? `تم العثور على ${found.length} جهاز على نفس الشبكة!` : 'اكتمل الفحص ولم يُعثر على أجهزة تلقائياً. يمكنك إدخال الـ IP يدوياً.');
    };

    runBatches();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.text }]}>🌐 اتصال عبر نفس شبكة الواي فاي</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Text style={{ color: theme.textMuted, fontSize: 20 }}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Device IP Info */}
          <View style={[styles.myIpBox, { backgroundColor: theme.surfaceVariant }]}>
            <Text style={[styles.myIpLabel, { color: theme.textSecondary }]}>عنوان IP الخاص بهاتفك:</Text>
            <TouchableOpacity onPress={copyMyIp} style={styles.ipBadgeRow}>
              <Text style={[styles.myIpValue, { color: theme.primary }]}>{myLocalIp}:{port}</Text>
              <Text style={styles.copyIcon}>📋</Text>
            </TouchableOpacity>
            <Text style={[styles.myIpHint, { color: theme.textMuted }]}>
              (أخبر صديقك بهذا العنوان ليتصل بك إذا كنتما على نفس الراوتر)
            </Text>
          </View>

          {/* Manual Input */}
          <Text style={[styles.sectionTitle, { color: theme.text }]}>إدخال IP الطرف الآخر يدوياً:</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, { backgroundColor: theme.surfaceSubtle, color: theme.text, borderColor: theme.border }]}
              placeholder="مثال: 192.168.1.45"
              placeholderTextColor={theme.textMuted}
              value={targetIp}
              onChangeText={setTargetIp}
              keyboardType="numeric"
              autoCapitalize="none"
            />
            <TextInput
              style={[styles.portInput, { backgroundColor: theme.surfaceSubtle, color: theme.text, borderColor: theme.border }]}
              placeholder="8089"
              placeholderTextColor={theme.textMuted}
              value={targetPort}
              onChangeText={setTargetPort}
              keyboardType="numeric"
            />
          </View>

          <Button
            title="اتصال مباشر الآن"
            variant="primary"
            size="medium"
            icon="⚡"
            onPress={handleManualConnect}
            style={styles.connectBtn}
          />

          {/* Subnet Auto Scan */}
          <View style={styles.divider} />
          <Button
            title={scanning ? 'جاري الفحص السريع...' : '🔍 فحص الشبكة تلقائياً'}
            variant="secondary"
            size="medium"
            loading={scanning}
            onPress={scanSubnet}
            style={styles.scanBtn}
          />

          {scanProgress ? (
            <Text style={[styles.progressText, { color: theme.textSecondary }]}>{scanProgress}</Text>
          ) : null}

          {discoveredLanPeers.length > 0 && (
            <View style={styles.peersList}>
              <Text style={[styles.peersHeader, { color: theme.primary }]}>الأجهزة المكتشفة على الراوتر:</Text>
              <FlatList
                data={discoveredLanPeers}
                keyExtractor={(item) => item}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={[styles.peerItem, { backgroundColor: theme.surfaceSubtle }]}
                    onPress={() => {
                      onConnectLan && onConnectLan(item, port);
                      onClose();
                    }}
                  >
                    <Text style={{ color: theme.text, fontWeight: '700' }}>📱 {item}:{port}</Text>
                    <Text style={{ color: theme.accent, fontWeight: '600' }}>اتصال ➔</Text>
                  </TouchableOpacity>
                )}
              />
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
    elevation: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 17,
    fontWeight: '800',
  },
  closeBtn: {
    padding: 4,
  },
  myIpBox: {
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
    alignItems: 'center',
  },
  myIpLabel: {
    fontSize: 13,
    marginBottom: 4,
  },
  ipBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  myIpValue: {
    fontSize: 18,
    fontWeight: '800',
  },
  copyIcon: {
    marginLeft: 8,
    fontSize: 16,
  },
  myIpHint: {
    fontSize: 11,
    marginTop: 4,
    textAlign: 'center',
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  input: {
    flex: 3,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 15,
    marginRight: 8,
  },
  portInput: {
    flex: 1,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    fontSize: 15,
    textAlign: 'center',
  },
  connectBtn: {
    marginBottom: 12,
  },
  divider: {
    height: 1,
    backgroundColor: '#333',
    marginVertical: 10,
    opacity: 0.3,
  },
  scanBtn: {
    marginBottom: 8,
  },
  progressText: {
    fontSize: 12,
    textAlign: 'center',
    marginVertical: 6,
  },
  peersList: {
    marginTop: 8,
    maxHeight: 140,
  },
  peersHeader: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  peerItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
    marginBottom: 6,
  },
});
export default LanConnectModal;
