import { NativeModules, NativeEventEmitter } from 'react-native';
const { AppInstallerModule } = NativeModules;
const emitter = new NativeEventEmitter(AppInstallerModule);

/**
 * يثبّت تطبيقاً مستلماً — سواء كان APK مفرد أو أرشيف حزم مقسّمة.
 * بيستخدم PackageInstaller فبيتعامل معه النظام متل ما لو إجا من متجر رسمي،
 * وبالتالي ما بتظهر رسالة "غير متوافق مع جهازك".
 */
export function installApp(path) {
  return AppInstallerModule.installFromFile(path);
}

export function onInstallResult(cb) {
  return emitter.addListener('APP_INSTALL_RESULT', cb);
}
