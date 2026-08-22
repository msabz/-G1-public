import { NativeModules, NativeEventEmitter } from 'react-native';
import {
  BluetoothTransportAdapter,
  createBluetoothFallbackHooks,
} from './BluetoothTransportAdapter';

const { BluetoothConnectionModule } = NativeModules;
const emitter = BluetoothConnectionModule
  ? new NativeEventEmitter(BluetoothConnectionModule)
  : { addListener: () => ({ remove() {} }) };

export const BT = BluetoothConnectionModule;
export const bluetoothTransport = new BluetoothTransportAdapter({
  nativeModule: BluetoothConnectionModule,
  emitter,
});
export const bluetoothFallbackHooks = createBluetoothFallbackHooks(bluetoothTransport);

export function onBtConnected(cb) { return emitter.addListener('BT_CONNECTED', cb); }
export function onBtDisconnected(cb) { return emitter.addListener('BT_DISCONNECTED', cb); }
export function onBtMessage(cb) { return emitter.addListener('BT_MESSAGE', cb); }
export function onBtDeviceFound(cb) { return emitter.addListener('BT_DEVICE_FOUND', cb); }
export function onBtDiscoveryFinished(cb) { return emitter.addListener('BT_DISCOVERY_FINISHED', cb); }
export function onBtError(cb) { return emitter.addListener('BT_ERROR', cb); }
export function onBtStateChanged(cb) { return emitter.addListener('BT_STATE_CHANGED', cb); }
export function onBtReconnecting(cb) { return emitter.addListener('BT_RECONNECTING', cb); }
export function onBtDiscoveryStarted(cb) { return emitter.addListener('BT_DISCOVERY_STARTED', cb); }
export function onBtListening(cb) { return emitter.addListener('BT_LISTENING', cb); }

export {
  BluetoothTransportAdapter,
  createBluetoothFallbackHooks,
} from './BluetoothTransportAdapter';
