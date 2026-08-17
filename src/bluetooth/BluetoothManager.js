import { NativeModules, NativeEventEmitter } from 'react-native';

const { BluetoothConnectionModule } = NativeModules;
const emitter = new NativeEventEmitter(BluetoothConnectionModule);

export const BT = BluetoothConnectionModule;

export function onBtConnected(cb) { return emitter.addListener('BT_CONNECTED', cb); }
export function onBtDisconnected(cb) { return emitter.addListener('BT_DISCONNECTED', cb); }
export function onBtMessage(cb) { return emitter.addListener('BT_MESSAGE', cb); }
export function onBtDeviceFound(cb) { return emitter.addListener('BT_DEVICE_FOUND', cb); }
export function onBtDiscoveryFinished(cb) { return emitter.addListener('BT_DISCOVERY_FINISHED', cb); }
export function onBtError(cb) { return emitter.addListener('BT_ERROR', cb); }
