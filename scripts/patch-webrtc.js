#!/usr/bin/env node
/**
 * يعدّل مكتبة react-native-webrtc قبل البناء لتعطيل مراقب الشبكة.
 *
 * ليش هالتعديل ضروري:
 * مراقب الشبكة بأندرويد بيعتمد على ConnectivityManager، وهاد ما بيعتبر
 * واي فاي مباشر "شبكة" أصلاً — فWebRTC ما بتشوف واجهة p2p إطلاقاً
 * وبتفشل كل محاولات ICE.
 * لما نعطّل المراقب، بتعدّ WebRTC الواجهات بنفسها من نظام التشغيل
 * فبتشوف p2p-wlan0-0 و p2p0.
 *
 * أثبتنا هالسلوك بفحص عملي على جهازين: مع تعطيل المراقب ظهرت
 * العناوين 192.168.49.1 و 192.168.49.200، وبدونه ما ظهر ولا مرشّح.
 *
 * السكربت مصمّم ليكون آمناً: بيفشل بصوت عالٍ إذا ما لقي مكان التعديل،
 * بدل ما يمرّر بناءً غير معدّل ونظن إنه اشتغل.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(
  __dirname, '..', 'node_modules', 'react-native-webrtc',
  'android', 'src', 'main', 'java', 'com', 'oney', 'WebRTCModule', 'WebRTCModule.java'
);

const MARKER = 'MUSABCHAT_P2P_PATCH';

function fail(msg) {
  console.error('\n===============================================');
  console.error('  فشل تعديل WebRTC: ' + msg);
  console.error('===============================================\n');
  process.exit(1);
}

if (!fs.existsSync(FILE)) fail('ما لقيت الملف: ' + FILE);

let src = fs.readFileSync(FILE, 'utf8');

if (src.includes(MARKER)) {
  console.log('✓ التعديل مطبّق مسبقاً');
  process.exit(0);
}

let patched = false;

// الحالة ١: المكتبة بتنشئ Options أصلاً — منضيف السطر بعدها
const optionsPattern = /(PeerConnectionFactory\.Options\s+(\w+)\s*=\s*new\s+PeerConnectionFactory\.Options\(\)\s*;)/;
if (optionsPattern.test(src)) {
  src = src.replace(optionsPattern, (m, decl, varName) =>
    `${decl}\n        // ${MARKER}: تعطيل مراقب الشبكة ليرى WebRTC واجهة Wi-Fi Direct\n        ${varName}.disableNetworkMonitor = true;`
  );
  patched = true;
  console.log('✓ عُدّلت Options الموجودة مسبقاً');
}

// الحالة ٢: ما في Options — منضيفها ومنمرّرها للـ builder
if (!patched) {
  const builderPattern = /(mFactory\s*=\s*PeerConnectionFactory\.builder\(\))/;
  if (builderPattern.test(src)) {
    src = src.replace(builderPattern, (m) =>
      `// ${MARKER}: تعطيل مراقب الشبكة ليرى WebRTC واجهة Wi-Fi Direct\n` +
      `        PeerConnectionFactory.Options musabOptions = new PeerConnectionFactory.Options();\n` +
      `        musabOptions.disableNetworkMonitor = true;\n` +
      `        ${m}\n                .setOptions(musabOptions)`
    );
    patched = true;
    console.log('✓ أُضيفت Options جديدة للـ builder');
  }
}

// الحالة ٣: صيغة builder مختلفة
if (!patched) {
  const altPattern = /(PeerConnectionFactory\.builder\(\))/;
  if (altPattern.test(src)) {
    src = src.replace(altPattern, (m) =>
      `${m}\n                .setOptions(musabBuildOptions())`
    );
    // دالة مساعدة تُضاف داخل الصف
    const classEnd = src.lastIndexOf('}');
    src = src.slice(0, classEnd) +
      `\n    // ${MARKER}\n` +
      `    private static PeerConnectionFactory.Options musabBuildOptions() {\n` +
      `        PeerConnectionFactory.Options o = new PeerConnectionFactory.Options();\n` +
      `        o.disableNetworkMonitor = true;\n` +
      `        return o;\n` +
      `    }\n` +
      src.slice(classEnd);
    patched = true;
    console.log('✓ أُضيفت دالة Options مساعدة');
  }
}

if (!patched) fail('ما لقيت مكان إنشاء PeerConnectionFactory داخل الملف');

fs.writeFileSync(FILE, src, 'utf8');

// تحقق نهائي
const verify = fs.readFileSync(FILE, 'utf8');
if (!verify.includes('disableNetworkMonitor = true')) {
  fail('كُتب الملف بس ما ظهر التعديل');
}

console.log('✓ تم تعطيل مراقب الشبكة في react-native-webrtc');
