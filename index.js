/**
 * G1 DirectChat - Entry Point
 */
import React, { useEffect } from 'react';
import { AppRegistry } from 'react-native';
import App from './src/App';
import { setUiAttached } from './src/services/BackgroundRuntime';

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
