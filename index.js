/**
 * G1 DirectChat - Entry Point
 */
import React, { useEffect } from 'react';
import { AppRegistry } from 'react-native';
import App from './src/App';
import { setUiAttached } from './src/services/BackgroundRuntime';
import { connectionCoordinator } from './src/network/ConnectionCoordinator';
import { lanPassiveAdmissionHandler } from './src/network/LanPassiveAdmission';
import { wifiDirectTransportAdapter } from './src/network/WifiDirectTransportAdapter';
import { setPassiveInboundAdmissionHandler } from './src/webrtc/signaling';
import { signalingOwner } from './src/webrtc/signalingOwner';
import { bluetoothTransport } from './src/bluetooth/BluetoothManager';

connectionCoordinator.setSignalingOwner(signalingOwner);
connectionCoordinator.setP2pAdapter(wifiDirectTransportAdapter);
connectionCoordinator.setBluetoothAdapter(bluetoothTransport);
wifiDirectTransportAdapter.startObserving();
bluetoothTransport.startObserving();
setPassiveInboundAdmissionHandler(lanPassiveAdmissionHandler);

function G1Root() {
  useEffect(() => {
    setUiAttached(true);
    return () => setUiAttached(false);
  }, []);

  return React.createElement(App);
}

AppRegistry.registerComponent('DirectChat', () => G1Root);
AppRegistry.registerComponent('M200', () => G1Root);
AppRegistry.registerComponent('G1', () => G1Root);
