import { NativeModules } from 'react-native';
const { ServiceModule } = NativeModules;

// خدمة أمامية تمنع أندرويد من قتل الاتصال لما يروح التطبيق للخلفية
export function startConnectionService(status = 'متصل') {
  return ServiceModule.startConnectionService(status).catch(() => {});
}

export function updateConnectionStatus(status) {
  return ServiceModule.updateConnectionStatus(status).catch(() => {});
}

export function stopConnectionService() {
  return ServiceModule.stopConnectionService().catch(() => {});
}

export function showMessageNotification(title, body) {
  return ServiceModule.showMessageNotification(title, body).catch(() => {});
}

export function clearMessageNotifications() {
  return ServiceModule.clearMessageNotifications().catch(() => {});
}
