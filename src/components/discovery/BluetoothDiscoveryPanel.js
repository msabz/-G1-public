import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  I18nManager,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Avatar } from '../common/Avatar';

export const BLUETOOTH_CONNECT_UI_TIMEOUT_MS = 30000;

const IDLE_CONNECTION = Object.freeze({
  phase: 'idle',
  deviceKey: null,
  deviceName: '',
});

function deviceKey(device, index = 0) {
  return String(device?.address || device?.btAddress || `bluetooth-device-${index}`).toUpperCase();
}

function deviceName(device) {
  const name = String(device?.name || device?.deviceName || '').trim();
  return name && name !== 'Bluetooth Device' ? name : 'جهاز Bluetooth';
}

function connectionMessage(connection) {
  switch (connection.phase) {
    case 'connecting':
      return `جاري الاتصال بـ ${connection.deviceName}. وافق على طلب الاقتران في الجهازين إن ظهر.`;
    case 'connected':
      return `تم الاتصال بـ ${connection.deviceName}. جارٍ فتح المحادثة النصية.`;
    case 'failed':
      return `لم يكتمل الاتصال بـ ${connection.deviceName}. تحقق من قبول الاقتران وقرب الجهازين ثم أعد المحاولة.`;
    default:
      return '';
  }
}

/**
 * Bluetooth Classic discovery UI only. Transport ownership stays in App.js;
 * this component presents bounded, truthful UI states around that contract.
 */
export function BluetoothDiscoveryPanel({
  devices = [],
  isScanning = false,
  onScan,
  onSelectDevice,
  scanButtonTitle = 'بحث Bluetooth',
  theme,
}) {
  const [scanRequested, setScanRequested] = useState(false);
  const [scanStarting, setScanStarting] = useState(false);
  const [scanFailed, setScanFailed] = useState(false);
  const [connection, setConnection] = useState(IDLE_CONNECTION);
  const mountedRef = useRef(true);
  const connectionAttemptRef = useRef(0);
  const connectionTimerRef = useRef(null);
  const safeDevices = Array.isArray(devices) ? devices.filter(Boolean) : [];
  const scanningRef = useRef(isScanning);
  const deviceCountRef = useRef(safeDevices.length);
  const scanBusy = isScanning || scanStarting;
  const connectionBusy = connection.phase === 'connecting';
  const rowDirection = I18nManager.isRTL ? 'row' : 'row-reverse';
  scanningRef.current = isScanning;
  deviceCountRef.current = safeDevices.length;

  const clearConnectionTimer = () => {
    if (connectionTimerRef.current) {
      clearTimeout(connectionTimerRef.current);
      connectionTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (isScanning) {
      setScanRequested(true);
      setScanStarting(false);
      setScanFailed(false);
    }
  }, [isScanning]);

  useEffect(() => () => {
    mountedRef.current = false;
    connectionAttemptRef.current += 1;
    clearConnectionTimer();
  }, []);

  const scanState = useMemo(() => {
    if (scanFailed) {
      return {
        tone: 'error',
        text: 'تعذّر بدء البحث. فعّل Bluetooth وامنح إذن «الأجهزة القريبة»، ثم حاول مجددًا.',
      };
    }
    if (scanBusy) {
      return {
        tone: 'info',
        text: 'هذا الهاتف ظاهر ويبحث الآن. اترك الشاشة مفتوحة وابدأ البحث في الهاتف الآخر أيضًا.',
      };
    }
    if (safeDevices.length > 0) {
      return {
        tone: 'success',
        text: `تم العثور على ${safeDevices.length} ${safeDevices.length === 1 ? 'جهاز' : 'أجهزة'}. ظهور الجهاز لا يعني أنه متصل بعد.`,
      };
    }
    if (scanRequested) {
      return {
        tone: 'warning',
        text: 'لم يظهر جهاز. أعد البحث في الهاتفين في الوقت نفسه، ووافق على الظهور في كليهما.',
      };
    }
    if (typeof onScan !== 'function') {
      return {
        tone: 'error',
        text: 'بحث Bluetooth غير متاح حاليًا.',
      };
    }
    return {
      tone: 'neutral',
      text: 'لم يبدأ البحث بعد. نفّذ الخطوات الثلاث على الهاتفين.',
    };
  }, [onScan, safeDevices.length, scanBusy, scanFailed, scanRequested]);

  const scanToneColor = {
    error: theme.error,
    info: theme.info || theme.primary,
    success: theme.success || theme.accent,
    warning: theme.warning || theme.textSecondary,
    neutral: theme.textSecondary,
  }[scanState.tone];

  const resetConnection = () => {
    connectionAttemptRef.current += 1;
    clearConnectionTimer();
    setConnection(IDLE_CONNECTION);
  };

  const handleScan = async () => {
    if (scanBusy || typeof onScan !== 'function') return;
    resetConnection();
    setScanRequested(true);
    setScanFailed(false);
    setScanStarting(true);
    try {
      const result = await onScan();
      const didNotStart = !scanningRef.current && deviceCountRef.current === 0;
      // App's scan contract returns true only after native discovery starts.
      // Trust that explicit result even if the parent `isScanning` render has
      // not reached this child yet; otherwise a successful first tap flashes a
      // false permission/adapter failure.
      const failed = result === false || (result !== true && didNotStart);
      if (failed && mountedRef.current) setScanFailed(true);
    } catch (_) {
      if (mountedRef.current) setScanFailed(true);
    } finally {
      if (mountedRef.current) setScanStarting(false);
    }
  };

  const handleConnect = device => {
    if (connectionBusy || typeof onSelectDevice !== 'function') return;
    const key = deviceKey(device);
    const name = deviceName(device);
    const attempt = connectionAttemptRef.current + 1;
    connectionAttemptRef.current = attempt;
    clearConnectionTimer();
    setConnection({ phase: 'connecting', deviceKey: key, deviceName: name });

    connectionTimerRef.current = setTimeout(() => {
      if (!mountedRef.current || connectionAttemptRef.current !== attempt) return;
      connectionAttemptRef.current += 1;
      connectionTimerRef.current = null;
      setConnection({ phase: 'failed', deviceKey: key, deviceName: name });
    }, BLUETOOTH_CONNECT_UI_TIMEOUT_MS);

    Promise.resolve()
      .then(() => onSelectDevice(device))
      .then(result => {
        if (!mountedRef.current || connectionAttemptRef.current !== attempt) return;
        if (result !== true && result !== false) return;
        clearConnectionTimer();
        setConnection({
          phase: result ? 'connected' : 'failed',
          deviceKey: key,
          deviceName: name,
        });
      })
      .catch(() => {
        if (!mountedRef.current || connectionAttemptRef.current !== attempt) return;
        clearConnectionTimer();
        setConnection({ phase: 'failed', deviceKey: key, deviceName: name });
      });
  };

  const connectionStatus = connectionMessage(connection);

  return (
    <View testID="bluetooth-discovery-panel">
      <View style={[styles.headerRow, { flexDirection: rowDirection }]}>
        <Text
          accessibilityRole="header"
          style={[styles.title, styles.rtlText, { color: theme.primary }]}
        >
          أجهزة Bluetooth القريبة
        </Text>
        {scanBusy ? <ActivityIndicator size="small" color={theme.accent} /> : null}
      </View>

      <View style={[styles.instructions, { backgroundColor: theme.surfaceSubtle, borderColor: theme.border }]}>
        <Text style={[styles.instructionsTitle, styles.rtlText, { color: theme.text }]}>على الهاتفين:</Text>
        <Text style={[styles.instructionText, styles.rtlText, { color: theme.textSecondary }]}>١. افتح تبويب «الأجهزة والشبكة».</Text>
        <Text style={[styles.instructionText, styles.rtlText, { color: theme.textSecondary }]}>٢. اضغط «بحث Bluetooth» ووافق على طلب الظهور.</Text>
        <Text style={[styles.instructionText, styles.rtlText, { color: theme.textSecondary }]}>٣. اختر الجهاز مرة واحدة، ثم وافق على الاقتران إن ظهر.</Text>
        <Text style={[styles.limitText, styles.rtlText, { color: theme.textMuted }]}>Bluetooth هنا للرسائل النصية؛ الصوت والفيديو يحتاجان LAN أو Wi‑Fi Direct.</Text>
      </View>

      <View
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={scanState.text}
        testID="bluetooth-discovery-state"
        style={[styles.stateBox, { backgroundColor: theme.surfaceVariant, borderColor: scanToneColor }]}
      >
        <View style={[styles.stateDot, { backgroundColor: scanToneColor }]} />
        <Text style={[styles.stateText, styles.rtlText, { color: theme.text }]}>{scanState.text}</Text>
      </View>

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="بدء بحث Bluetooth وإظهار هذا الهاتف"
        accessibilityHint="افتح البحث على الهاتفين ووافق على طلب الظهور في كل هاتف"
        accessibilityState={{ busy: scanBusy, disabled: scanBusy || typeof onScan !== 'function' }}
        activeOpacity={0.8}
        disabled={scanBusy || typeof onScan !== 'function'}
        onPress={handleScan}
        testID="bluetooth-scan-action"
        style={[
          styles.primaryAction,
          { backgroundColor: scanBusy || typeof onScan !== 'function' ? theme.surfaceVariant : theme.primary },
        ]}
      >
        {scanBusy ? <ActivityIndicator size="small" color={theme.textMuted} /> : null}
        <Text
          style={[
            styles.actionText,
            { color: scanBusy || typeof onScan !== 'function' ? theme.textMuted : '#FFFFFF' },
          ]}
        >
          {scanStarting && !isScanning ? 'جاري تجهيز البحث…' : scanButtonTitle}
        </Text>
      </TouchableOpacity>

      {connectionStatus ? (
        <View
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={connectionStatus}
          testID="bluetooth-connect-state"
          style={[
            styles.connectionState,
            {
              backgroundColor: theme.surfaceSubtle,
              borderColor: connection.phase === 'failed'
                ? theme.error
                : connection.phase === 'connected'
                  ? (theme.success || theme.accent)
                  : (theme.info || theme.primary),
            },
          ]}
        >
          {connectionBusy ? <ActivityIndicator size="small" color={theme.accent} /> : null}
          <Text style={[styles.connectionText, styles.rtlText, { color: theme.text }]}>{connectionStatus}</Text>
        </View>
      ) : null}

      {safeDevices.map((device, index) => {
        const key = deviceKey(device, index);
        const name = deviceName(device);
        const selected = connection.deviceKey === key;
        const bonded = device.bonded === true || device.source === 'BONDED';
        const unavailable = typeof onSelectDevice !== 'function';
        const disabled = unavailable || connectionBusy || connection.phase === 'connected';
        const buttonTitle = selected && connection.phase === 'connecting'
          ? 'جاري الاتصال…'
          : selected && connection.phase === 'failed'
            ? 'إعادة المحاولة'
            : selected && connection.phase === 'connected'
              ? 'تم الاتصال'
              : 'اتصال ومحادثة';
        const deviceStatus = bonded
          ? 'مقترن في Android — جاهز لمحاولة الاتصال'
          : 'غير مقترن — قد يظهر طلب اقتران على الجهازين';

        return (
          <View
            key={key}
            testID={`bluetooth-device-${key}`}
            style={[
              styles.deviceRow,
              { borderBottomColor: theme.border, flexDirection: rowDirection },
              selected ? { backgroundColor: theme.surfaceSubtle } : null,
            ]}
          >
            <Avatar name={name} size={44} transportType="bluetooth" />
            <View style={styles.deviceInfo}>
              <Text numberOfLines={1} style={[styles.deviceName, styles.rtlText, { color: theme.text }]}>{name}</Text>
              <Text style={[styles.deviceStatus, styles.rtlText, { color: bonded ? theme.success : theme.textSecondary }]}>{deviceStatus}</Text>
              {device.address ? (
                <Text accessibilityLabel={`عنوان الجهاز ${device.address}`} style={[styles.address, { color: theme.textMuted }]}>{device.address}</Text>
              ) : null}
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`${buttonTitle} مع ${name}`}
              accessibilityHint={bonded
                ? 'يبدأ اتصال Bluetooth الآمن ويفتح المحادثة النصية'
                : 'قد يطلب Android تأكيد الاقتران في الجهازين قبل فتح المحادثة'}
              accessibilityState={{ busy: selected && connectionBusy, disabled }}
              activeOpacity={0.8}
              disabled={disabled}
              onPress={() => handleConnect(device)}
              testID={`bluetooth-connect-${key}`}
              style={[
                styles.connectAction,
                {
                  backgroundColor: disabled && !(selected && connectionBusy)
                    ? theme.surfaceVariant
                    : selected && connection.phase === 'failed'
                      ? theme.error
                      : theme.primary,
                },
              ]}
            >
              {selected && connectionBusy ? <ActivityIndicator size="small" color="#FFFFFF" /> : null}
              <Text style={[styles.connectActionText, { color: disabled && !connectionBusy ? theme.textMuted : '#FFFFFF' }]}>{buttonTitle}</Text>
            </TouchableOpacity>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
  },
  rtlText: {
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  instructions: {
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
    padding: 12,
  },
  instructionsTitle: {
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 5,
  },
  instructionText: {
    fontSize: 13,
    lineHeight: 21,
  },
  limitText: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 7,
  },
  stateBox: {
    alignItems: 'center',
    borderLeftWidth: 4,
    borderRadius: 10,
    flexDirection: 'row-reverse',
    marginBottom: 10,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  stateDot: {
    borderRadius: 4,
    height: 8,
    marginLeft: 9,
    width: 8,
  },
  stateText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
  },
  primaryAction: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row-reverse',
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: 16,
  },
  actionText: {
    fontSize: 14,
    fontWeight: '800',
    marginHorizontal: 6,
    textAlign: 'center',
  },
  connectionState: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row-reverse',
    marginTop: 10,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  connectionText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    marginHorizontal: 8,
  },
  deviceRow: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    marginTop: 8,
    minHeight: 72,
    paddingHorizontal: 6,
    paddingVertical: 9,
  },
  deviceInfo: {
    flex: 1,
    marginHorizontal: 10,
  },
  deviceName: {
    fontSize: 15,
    fontWeight: '700',
  },
  deviceStatus: {
    fontSize: 11,
    lineHeight: 17,
    marginTop: 2,
  },
  address: {
    fontSize: 10,
    marginTop: 2,
    textAlign: 'right',
    writingDirection: 'ltr',
  },
  connectAction: {
    alignItems: 'center',
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 108,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  connectActionText: {
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
});

export default BluetoothDiscoveryPanel;
