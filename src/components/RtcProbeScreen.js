import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, NativeModules,
} from 'react-native';
import { WA } from '../theme';

const { RtcProbeModule } = NativeModules;

// لو الوحدة الأصلية مش موجودة (نسخة قديمة من التطبيق) منعرض رسالة
// بدل ما تنهار الشاشة عند الفتح
const MODULE_READY = !!RtcProbeModule;

/**
 * شاشة فحص: بتجرّب ثلاث تهيئات مختلفة لـ WebRTC الأصلية وبتوري
 * أي وحدة منهم بتشوف واجهة واي فاي مباشر (192.168.49.x).
 */
export default function RtcProbeScreen({ onClose }) {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState([]);

  const log = (t) => setLines(prev => [...prev, t]);

  const runProbe = async () => {
    setLines([]);
    if (!MODULE_READY) {
      setLines(['✗ وحدة الفحص غير متوفرة بهذه النسخة من التطبيق']);
      return;
    }
    setRunning(true);
    try {
      // ١) واجهات النظام الفعلية — المرجع اللي منقارن عليه
      log('— واجهات النظام —');
      const ifaces = await RtcProbeModule.listInterfaces();
      (ifaces || []).forEach(i => log('  ' + i));
      const hasP2p = (ifaces || []).some(i => i.includes('192.168.49.'));
      if (!hasP2p) {
        log('');
        log('✗ ما في واجهة واي فاي مباشر شغّالة الآن.');
        log('  لازم تكون متصل بالجهاز الثاني قبل الفحص،');
        log('  وإلا النتيجة بلا معنى.');
        log('');
        return;
      }
      log('✓ واي فاي مباشر شغّال — الفحص له معنى');

      // ٢) ثلاث تهيئات مختلفة
      const cases = [
        { label: 'افتراضي (متل المكتبة)', dm: false, ic: false },
        { label: 'تجاهل بيانات الهاتف', dm: false, ic: true },
        { label: 'تعطيل مراقب الشبكة', dm: true, ic: true },
      ];

      for (const c of cases) {
        log('');
        log(`— ${c.label} —`);
        const res = await RtcProbeModule.probeCandidates(c.dm, c.ic);
        const cands = res?.candidates || [];
        if (!cands.length) {
          log('  (ما جمع ولا مرشّح)');
        } else {
          cands.forEach(x => log('  ' + x));
        }
        const win = cands.some(x => x.includes('192.168.49.'));
        log(win ? '  ✓✓ شاف واي فاي مباشر' : '  ✗ ما شاف واي فاي مباشر');
      }

      log('');
      log('انتهى الفحص');
    } catch (e) {
      log('خطأ: ' + (e?.message || ''));
    } finally {
      setRunning(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} style={{ padding: 6 }}>
          <Text style={{ color: '#fff', fontSize: 22 }}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>فحص WebRTC والشبكة</Text>
      </View>

      <ScrollView style={styles.logBox} contentContainerStyle={{ padding: 12 }}>
        {lines.length === 0 && !running ? (
          <Text style={styles.hint}>
            شغّل الفحص وأنت متصل عبر واي فاي مباشر بالجهاز الثاني.{'\n\n'}
            الفحص بيجرّب ثلاث تهيئات وبيقلك أي وحدة بتشوف عنوان 192.168.49.x
          </Text>
        ) : null}
        {lines.map((l, i) => (
          <Text key={i} style={styles.line}>{l}</Text>
        ))}
        {running ? <ActivityIndicator color={WA.teal} style={{ marginTop: 12 }} /> : null}
      </ScrollView>

      <TouchableOpacity
        style={[styles.btn, running && { opacity: 0.5 }]}
        onPress={runProbe}
        disabled={running}
      >
        <Text style={styles.btnText}>{running ? 'جاري الفحص…' : 'ابدأ الفحص'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B141A' },
  header: {
    flexDirection: 'row-reverse', alignItems: 'center',
    backgroundColor: WA.green, paddingHorizontal: 8, paddingVertical: 12,
  },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '600', flex: 1, marginHorizontal: 10 },
  logBox: { flex: 1 },
  hint: { color: '#8696A0', fontSize: 14, lineHeight: 22, textAlign: 'center', marginTop: 30 },
  line: { color: '#9FE8A0', fontSize: 12, fontFamily: 'monospace', marginBottom: 2 },
  btn: {
    backgroundColor: WA.greenLight, margin: 14, paddingVertical: 15,
    borderRadius: 26, alignItems: 'center',
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
