import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
  ScrollView, StatusBar,
} from 'react-native';
import { WA } from '../theme';

const TIER_LABELS = {
  NONE: '',
  WIFI_DIRECT: 'واي فاي مباشر',
  BLUETOOTH: 'بلوتوث (دردشة فقط)',
};

export default function IdleScreen({
  onStart, status, busy, onOpenProbe, wifiDirectEnabled, showCreateGroup, onCreateGroup,
  activeTier, btDevices, onBtScan, onBtConnect, btScanning,
}) {
  const isOff = wifiDirectEnabled === false;
  // الزر بيختفي فقط أثناء عمليات الاتصال الفعلية، مش لمجرد وجود كلمة
  // "جاري" بالنص. سابقاً أي رسالة حالة كانت تخفي الزر فيبان وكأنه لا يستجيب.
  const loading = !!busy;

  return (
    <View style={styles.screen}>
      <StatusBar backgroundColor={WA.green} barStyle="light-content" />

      {/* الشريط العلوي */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Musabchat</Text>
      </View>

      <ScrollView contentContainerStyle={styles.container}>
        {activeTier && activeTier !== 'NONE' && (
          <View style={styles.tierBadge}>
            <View style={styles.dot} />
            <Text style={styles.tierText}>القناة النشطة: {TIER_LABELS[activeTier]}</Text>
          </View>
        )}

        <View style={styles.heroCard}>
          <View style={styles.logoCircle}>
            <Text style={styles.logoText}>M</Text>
          </View>
          <Text style={styles.title}>اتصال مباشر بدون إنترنت</Text>
          <Text style={styles.subtitle}>
            دردشة ومكالمات فيديو ونقل ملفات بين جهازين، بدون أي خادم وسيط
          </Text>
        </View>

        {isOff && (
          <View style={styles.warningBox}>
            <Text style={styles.warningText}>
              ⚠️ واي فاي مباشر غير مفعّل — فعّله من إعدادات الجهاز
            </Text>
          </View>
        )}

        {status ? (
          <View style={styles.statusBox}>
            {loading && <ActivityIndicator color={WA.greenLight} style={{ marginLeft: 10 }} />}
            <Text style={styles.statusText}>{status}</Text>
          </View>
        ) : null}

        {!loading && (
          <>
            <TouchableOpacity
              style={[styles.primaryBtn, isOff && styles.disabled]}
              onPress={onStart}
              disabled={isOff}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>بدء الاتصال</Text>
            </TouchableOpacity>

            {showCreateGroup && !isOff && (
              <TouchableOpacity style={styles.secondaryBtn} onPress={onCreateGroup} activeOpacity={0.85}>
                <Text style={styles.secondaryBtnText}>إنشاء مجموعة (أنا المضيف)</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity onPress={onOpenProbe} style={styles.probeLink}>
              <Text style={styles.probeLinkText}>فحص الشبكة و WebRTC</Text>
            </TouchableOpacity>

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>بديل احتياطي</Text>
              <View style={styles.dividerLine} />
            </View>

            <Text style={styles.sectionLabel}>بلوتوث — دردشة نصية فقط</Text>

            <TouchableOpacity style={styles.outlineBtn} onPress={onBtScan} activeOpacity={0.85}>
              {btScanning
                ? <ActivityIndicator color={WA.greenLight} />
                : <Text style={styles.outlineBtnText}>بحث عن أجهزة بلوتوث</Text>}
            </TouchableOpacity>

            {btDevices && btDevices.length > 0 && (
              <View style={styles.deviceList}>
                {btDevices.map(d => (
                  <TouchableOpacity
                    key={d.address}
                    style={styles.deviceItem}
                    onPress={() => onBtConnect(d.address)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.deviceAvatar}>
                      <Text style={styles.deviceAvatarText}>
                        {(d.name || '؟')[0].toUpperCase()}
                      </Text>
                    </View>
                    <View style={{ flex: 1, marginHorizontal: 12 }}>
                      <Text style={styles.deviceName}>{d.name || 'جهاز غير معروف'}</Text>
                      <Text style={styles.deviceAddr}>{d.address}</Text>
                    </View>
                    <Text style={styles.deviceArrow}>‹</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F7F8FA' },

  header: { backgroundColor: WA.green, paddingTop: 14, paddingBottom: 14, paddingHorizontal: 16, elevation: 4 },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },

  container: { padding: 16, paddingBottom: 40 },

  tierBadge: {
    flexDirection: 'row-reverse', alignItems: 'center', alignSelf: 'center',
    backgroundColor: '#E7F7EF', paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 20, marginBottom: 14, gap: 8,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: WA.teal },
  tierText: { color: WA.greenLight, fontSize: 12, fontWeight: '600' },

  heroCard: {
    backgroundColor: '#fff', borderRadius: 14, padding: 24,
    alignItems: 'center', elevation: 1, marginBottom: 20,
  },
  logoCircle: {
    width: 76, height: 76, borderRadius: 38, backgroundColor: WA.green,
    justifyContent: 'center', alignItems: 'center', marginBottom: 14,
  },
  logoText: { color: '#fff', fontSize: 34, fontWeight: '700' },
  title: { fontSize: 18, fontWeight: '700', color: WA.text, textAlign: 'center' },
  subtitle: { fontSize: 13, color: WA.subText, textAlign: 'center', marginTop: 8, lineHeight: 19 },

  warningBox: { backgroundColor: '#FFF4E5', borderRadius: 10, padding: 12, marginBottom: 14 },
  warningText: { color: '#8A5A00', fontSize: 13, textAlign: 'center' },

  statusBox: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#fff', borderRadius: 10, padding: 14, marginBottom: 14, elevation: 1,
  },
  statusText: { color: WA.subText, fontSize: 13, textAlign: 'center', flexShrink: 1 },

  primaryBtn: {
    backgroundColor: WA.greenLight, borderRadius: 26, paddingVertical: 15,
    alignItems: 'center', elevation: 2,
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  disabled: { backgroundColor: '#B9C4C0' },

  secondaryBtn: {
    backgroundColor: '#fff', borderRadius: 26, paddingVertical: 14,
    alignItems: 'center', marginTop: 10, borderWidth: 1.5, borderColor: WA.greenLight,
  },
  secondaryBtnText: { color: WA.greenLight, fontSize: 15, fontWeight: '600' },

  probeLink: { alignSelf: 'center', marginTop: 16, padding: 8 },
  probeLinkText: { color: '#8696A0', fontSize: 12, textDecorationLine: 'underline' },

  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 24, gap: 10 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#DDE3E6' },
  dividerText: { color: '#98A2A8', fontSize: 12 },

  sectionLabel: { color: WA.subText, fontSize: 13, textAlign: 'center', marginBottom: 12 },

  outlineBtn: {
    backgroundColor: '#fff', borderRadius: 26, paddingVertical: 14,
    alignItems: 'center', borderWidth: 1, borderColor: '#DDE3E6',
  },
  outlineBtnText: { color: WA.text, fontSize: 15, fontWeight: '600' },

  deviceList: { marginTop: 14, backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden', elevation: 1 },
  deviceItem: {
    flexDirection: 'row-reverse', alignItems: 'center', padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#EDF1F2',
  },
  deviceAvatar: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: '#DDE7E4',
    justifyContent: 'center', alignItems: 'center',
  },
  deviceAvatarText: { color: WA.green, fontWeight: '700', fontSize: 17 },
  deviceName: { color: WA.text, fontSize: 15, fontWeight: '600' },
  deviceAddr: { color: WA.subText, fontSize: 11, marginTop: 2 },
  deviceArrow: { color: '#B4BEC3', fontSize: 22 },
});
