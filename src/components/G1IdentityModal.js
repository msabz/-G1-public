import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme } from '../theme/themeContext';
import {
  buildOwnQrPayload,
  copyG1Number,
  getOwnG1Identity,
  listG1Contacts,
  renderG1QrDataUri,
  saveManualG1Contact,
  saveQrG1Contact,
  scanG1Qr,
  setOwnProfileName,
  shareG1Qr,
} from '../services/G1IdentityService';

function messageOf(error) {
  return error?.message || String(error || 'خطأ غير معروف');
}

export default function G1IdentityModal({ visible, onClose }) {
  const { theme } = useAppTheme();
  const [tab, setTab] = useState('mine');
  const [loading, setLoading] = useState(false);
  const [identity, setIdentity] = useState(null);
  const [qrPayload, setQrPayload] = useState('');
  const [qrDataUri, setQrDataUri] = useState('');
  const [profileDraft, setProfileDraft] = useState('');
  const [contacts, setContacts] = useState([]);
  const [manualNumber, setManualNumber] = useState('');
  const [localAlias, setLocalAlias] = useState('');
  const [scanned, setScanned] = useState(null);
  const [busyAction, setBusyAction] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const [own, savedContacts] = await Promise.all([
        getOwnG1Identity(),
        listG1Contacts(),
      ]);
      const payload = buildOwnQrPayload(own);
      const image = await renderG1QrDataUri(payload, 720);
      setIdentity(own);
      setProfileDraft(own.profileName || '');
      setQrPayload(payload);
      setQrDataUri(image || '');
      setContacts(savedContacts);
    } catch (error) {
      Alert.alert('تعذّر تحميل هوية G1', messageOf(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible) refresh();
  }, [visible]);

  const displayName = useMemo(
    () => identity?.profileName?.trim() || 'بدون اسم ملف شخصي',
    [identity]
  );

  const run = async (name, action) => {
    if (busyAction) return;
    setBusyAction(name);
    try {
      await action();
    } catch (error) {
      Alert.alert('G1', messageOf(error));
    } finally {
      setBusyAction('');
    }
  };

  const saveProfile = () => run('profile', async () => {
    const next = await setOwnProfileName(profileDraft);
    const payload = buildOwnQrPayload(next);
    const image = await renderG1QrDataUri(payload, 720);
    setIdentity(next);
    setQrPayload(payload);
    setQrDataUri(image || '');
    Alert.alert('تم', 'تم تحديث اسم الملف الشخصي. رقم G1 لم يتغير.');
  });

  const copyNumber = () => run('copy', async () => {
    await copyG1Number(identity.g1Number);
    Alert.alert('تم النسخ', 'تم نسخ رقم G1.');
  });

  const shareNumber = () => run('share-number', async () => {
    await Share.share({
      message: `${displayName}\n${identity.g1Number}`,
      title: 'G1 Number',
    });
  });

  const shareQr = () => run('share-qr', async () => {
    await shareG1Qr(qrPayload, identity.g1Number);
  });

  const addManual = () => run('manual-add', async () => {
    const saved = await saveManualG1Contact(manualNumber, localAlias);
    setContacts(await listG1Contacts());
    setManualNumber('');
    setLocalAlias('');
    Alert.alert(
      'تمت الإضافة',
      `${saved?.g1Number || 'رقم G1'} محفوظ كهوية متوقعة. لن يُعتبر الطرف موثوقاً حتى يثبت هويته عند الاتصال.`
    );
  });

  const requestCamera = async () => {
    if (Platform.OS !== 'android') return true;
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.CAMERA,
      {
        title: 'مسح رمز G1',
        message: 'يحتاج G1 إلى الكاميرا لمسح QR الخاص بجهة الاتصال.',
        buttonPositive: 'سماح',
        buttonNegative: 'إلغاء',
      }
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  };

  const scanQr = () => run('scan', async () => {
    if (!(await requestCamera())) {
      Alert.alert('الكاميرا مطلوبة', 'لم يتم منح إذن الكاميرا.');
      return;
    }
    const parsed = await scanG1Qr();
    if (!parsed) return;
    setScanned(parsed);
    setManualNumber(parsed.g1Number);
    setLocalAlias('');
    setTab('add');
  });

  const saveScanned = () => run('save-scan', async () => {
    if (!scanned) return;
    await saveQrG1Contact(scanned, localAlias);
    setContacts(await listG1Contacts());
    setScanned(null);
    setManualNumber('');
    setLocalAlias('');
    Alert.alert('تمت إضافة جهة الاتصال', 'تم حفظ رقم G1 مع الـUserId الكامل الموجود داخل QR.');
  });

  const renderMine = () => (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={[styles.label, { color: theme.textSecondary }]}>اسم الملف الشخصي</Text>
      <TextInput
        value={profileDraft}
        onChangeText={setProfileDraft}
        placeholder="الاسم الذي تختاره لنفسك"
        placeholderTextColor={theme.textMuted}
        maxLength={80}
        style={[styles.input, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]}
      />
      <TouchableOpacity
        style={[styles.smallButton, { backgroundColor: theme.surfaceVariant }]}
        onPress={saveProfile}
        disabled={busyAction === 'profile'}
      >
        <Text style={[styles.smallButtonText, { color: theme.primary }]}>حفظ الاسم</Text>
      </TouchableOpacity>

      <View style={[styles.identityCard, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
        <Text style={[styles.profileName, { color: theme.text }]}>{displayName}</Text>
        <Text style={[styles.number, { color: theme.primary }]} selectable>{identity?.g1Number || '—'}</Text>
        <Text style={[styles.hint, { color: theme.textSecondary }]}>هذا هو الرقم العام الذي يمكنك نسخه أو مشاركته وإضافتك عن طريقه.</Text>

        {qrDataUri ? (
          <View style={styles.qrWrap}>
            <Image source={{ uri: qrDataUri }} style={styles.qrImage} resizeMode="contain" />
          </View>
        ) : (
          <ActivityIndicator style={{ marginVertical: 24 }} color={theme.primary} />
        )}

        <Text style={[styles.securityNote, { color: theme.textSecondary }]}> 
          QR يحمل رقم G1 والـUserId الكامل 256-bit. الـUserId لا يظهر للمستخدم كرقم يومي، لكنه يسمح بمطابقة أقوى عند أول اتصال. QR أو الرقم ليسا Route ولا يثبتان جلسة وحدهما.
        </Text>

        <View style={styles.buttonRow}>
          <TouchableOpacity style={[styles.actionButton, { backgroundColor: theme.surfaceVariant }]} onPress={copyNumber}>
            <Text style={[styles.actionText, { color: theme.primary }]}>نسخ الرقم</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionButton, { backgroundColor: theme.surfaceVariant }]} onPress={shareNumber}>
            <Text style={[styles.actionText, { color: theme.primary }]}>مشاركة الرقم</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={[styles.primaryButton, { backgroundColor: theme.accent }]} onPress={shareQr}>
          <Text style={styles.primaryButtonText}>مشاركة QR</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  const renderAdd = () => (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <TouchableOpacity style={[styles.primaryButton, { backgroundColor: theme.accent }]} onPress={scanQr}>
        <Text style={styles.primaryButtonText}>{busyAction === 'scan' ? 'جاري فتح الماسح…' : 'مسح QR لشخص آخر'}</Text>
      </TouchableOpacity>

      {scanned ? (
        <View style={[styles.scannedCard, { backgroundColor: theme.surface, borderColor: theme.accent }]}> 
          <Text style={[styles.profileName, { color: theme.text }]}>{scanned.profileName || 'جهة اتصال G1'}</Text>
          <Text style={[styles.numberSmall, { color: theme.primary }]}>{scanned.g1Number}</Text>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>تم التحقق أن الرقم داخل QR يطابق الـUserId الكامل الموجود معه.</Text>
        </View>
      ) : null}

      <Text style={[styles.label, { color: theme.textSecondary }]}>رقم G1</Text>
      <TextInput
        value={manualNumber}
        onChangeText={setManualNumber}
        autoCapitalize="characters"
        placeholder="G1-...."
        placeholderTextColor={theme.textMuted}
        style={[styles.input, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]}
      />

      <Text style={[styles.label, { color: theme.textSecondary }]}>الاسم المحلي عندك (اختياري)</Text>
      <TextInput
        value={localAlias}
        onChangeText={setLocalAlias}
        maxLength={80}
        placeholder="مثلاً: أحمد العمل"
        placeholderTextColor={theme.textMuted}
        style={[styles.input, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]}
      />

      {scanned ? (
        <TouchableOpacity style={[styles.primaryButton, { backgroundColor: theme.accent }]} onPress={saveScanned}>
          <Text style={styles.primaryButtonText}>حفظ جهة الاتصال من QR</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={[styles.primaryButton, { backgroundColor: theme.primary }]} onPress={addManual}>
          <Text style={styles.primaryButtonText}>إضافة بالرقم</Text>
        </TouchableOpacity>
      )}

      <Text style={[styles.securityNote, { color: theme.textSecondary }]}> 
        إضافة الرقم يحدد من تتوقعه فقط. العثور على الجهاز سيتم لاحقاً عبر LAN / Wi-Fi Direct / Bluetooth / I2P، ثم يجب أن يثبت الطرف هويته تشفيرياً قبل ترقيته إلى جهة موثوقة.
      </Text>

      <Text style={[styles.sectionTitle, { color: theme.text }]}>جهات G1 المحفوظة</Text>
      {contacts.length === 0 ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>لا توجد جهات G1 محفوظة بعد.</Text>
      ) : contacts.map(contact => (
        <View key={contact.g1Number} style={[styles.contactRow, { borderBottomColor: theme.borderSubtle }]}> 
          <View style={{ flex: 1 }}>
            <Text style={[styles.contactName, { color: theme.text }]}> 
              {contact.localAlias || contact.profileName || 'جهة G1'}
            </Text>
            <Text style={[styles.contactNumber, { color: theme.primary }]}>{contact.g1Number}</Text>
            <Text style={[styles.contactSource, { color: theme.textMuted }]}> 
              {contact.userId ? 'QR + UserId كامل محفوظ' : 'رقم فقط — بانتظار إثبات الهوية'}
            </Text>
          </View>
        </View>
      ))}
      <View style={{ height: 24 }} />
    </ScrollView>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}> 
        <View style={[styles.header, { backgroundColor: theme.primary }]}> 
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
          <Text style={styles.title}>هوية G1</Text>
          <View style={{ width: 38 }} />
        </View>

        <View style={[styles.tabs, { borderBottomColor: theme.border }]}> 
          <TouchableOpacity style={[styles.tab, tab === 'mine' && { borderBottomColor: theme.accent, borderBottomWidth: 3 }]} onPress={() => setTab('mine')}>
            <Text style={[styles.tabText, { color: tab === 'mine' ? theme.primary : theme.textSecondary }]}>هويتي</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.tab, tab === 'add' && { borderBottomColor: theme.accent, borderBottomWidth: 3 }]} onPress={() => setTab('add')}>
            <Text style={[styles.tabText, { color: tab === 'add' ? theme.primary : theme.textSecondary }]}>إضافة شخص</Text>
          </TouchableOpacity>
        </View>

        {loading || !identity ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={[styles.hint, { color: theme.textSecondary, marginTop: 12 }]}>جاري تجهيز هوية G1…</Text>
          </View>
        ) : tab === 'mine' ? renderMine() : renderAdd()}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { height: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
  closeButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: '#fff', fontSize: 22, fontWeight: '700' },
  title: { color: '#fff', fontSize: 20, fontWeight: '800' },
  tabs: { flexDirection: 'row', borderBottomWidth: 1 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 13 },
  tabText: { fontSize: 15, fontWeight: '800' },
  content: { padding: 16, paddingBottom: 40 },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13, fontWeight: '700', marginTop: 12, marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11, fontSize: 15 },
  smallButton: { alignSelf: 'flex-start', marginTop: 9, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  smallButtonText: { fontSize: 13, fontWeight: '800' },
  identityCard: { marginTop: 18, borderRadius: 18, borderWidth: 1, padding: 18, alignItems: 'center' },
  profileName: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  number: { fontSize: 18, fontWeight: '900', marginTop: 8, textAlign: 'center', letterSpacing: 0.5 },
  numberSmall: { fontSize: 14, fontWeight: '800', marginTop: 6, textAlign: 'center' },
  hint: { fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 7 },
  qrWrap: { marginTop: 18, padding: 12, backgroundColor: '#fff', borderRadius: 16 },
  qrImage: { width: 240, height: 240 },
  securityNote: { fontSize: 12, lineHeight: 19, textAlign: 'center', marginTop: 14 },
  buttonRow: { flexDirection: 'row', marginTop: 16, gap: 10 },
  actionButton: { flex: 1, borderRadius: 11, paddingVertical: 11, alignItems: 'center' },
  actionText: { fontSize: 13, fontWeight: '800' },
  primaryButton: { marginTop: 14, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16, alignItems: 'center' },
  primaryButtonText: { color: '#fff', fontSize: 14, fontWeight: '900' },
  scannedCard: { marginTop: 16, padding: 14, borderRadius: 14, borderWidth: 1 },
  sectionTitle: { fontSize: 16, fontWeight: '900', marginTop: 24, marginBottom: 6 },
  contactRow: { flexDirection: 'row', paddingVertical: 12, borderBottomWidth: 0.5 },
  contactName: { fontSize: 15, fontWeight: '800' },
  contactNumber: { fontSize: 12, fontWeight: '700', marginTop: 3 },
  contactSource: { fontSize: 11, marginTop: 3 },
});
